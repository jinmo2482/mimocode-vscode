import * as vscode from 'vscode';
import * as path from 'path';
import { ApiClient, ApiError, ConfigInfo, PromptOptions, SessionInfo, SessionStatusInfo } from '../api/client';
import { SseClient, SseEvent } from '../api/sseClient';
import { EditorContext } from '../context/editorContext';
import { MentionProvider } from '../context/mentionProvider';
import { DiffManager } from '../diff/diffManager';
import { TimelineStore } from '../timeline/timelineStore';
import { getHtml } from './webview/html';

export class ChatPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'mimocode.chatView';
    private _view?: vscode.WebviewView;
    private _currentSessionId?: string;
    private _sessions: SessionInfo[] = [];
    private _config: ConfigInfo = {};
    private _providers: unknown;
    private _currentModel?: string;
    private _effectiveModelRef?: string;
    private _currentVariant?: string;
    private _variantOptions: string[] = [];
    private _models: Array<{ label: string; description?: string; providerID: string; modelID: string }> = [];
    private _timeline = new TimelineStore();
    private _disposables: vscode.Disposable[] = [];
    private _busy = false;
    private _onSignInRequest?: () => void;
    private _pendingQuestions = new Map<string, string>(); // sessionID+callID -> requestID
    private _errorDedup = new Map<string, number>(); // message -> lastShown timestamp

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _apiClient: ApiClient,
        private readonly _sseClient: SseClient,
        private readonly _editorContext: EditorContext,
        private readonly _mentionProvider: MentionProvider,
        private readonly _diffManager: DiffManager
    ) {
        this._disposables.push(
            this._sseClient.onEvent(event => this.handleSseEvent(event)),
            this._sseClient.onStateChange(() => this.postShellState()),
            this._diffManager.onDiffUpdate(diffs => this.postMessage({ type: 'pendingDiffs', diffs }))
        );
    }

    setSignInHandler(handler: () => void): void {
        this._onSignInRequest = handler;
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = getHtml(webviewView.webview);

        this._disposables.push(webviewView.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg)));
        webviewView.onDidDispose(() => {
            this._view = undefined;
        });
    }

    show(): void {
        this._view?.show(true);
    }

    async newSession(): Promise<void> {
        try {
            const directory = this._editorContext.getWorkspaceRoot();
            const session = await this._apiClient.newSession(directory ? { directory } : undefined);
            this._currentSessionId = session.id;
            await this.reloadSessions();
            await this.loadSession(session.id);
        } catch (err) {
            this.showError(`Failed to create session: ${toMessage(err)}`);
        }
    }

    async switchSession(sessionId: string): Promise<void> {
        await this.loadSession(sessionId);
    }

    async sendWithContext(text: string): Promise<void> {
        await this.ensureSession();
        this.show();
        await this.handleSendPrompt(text);
    }

    async abort(): Promise<void> {
        if (!this._currentSessionId) {
            return;
        }
        await this._apiClient.abortSession(this._currentSessionId);
        this._busy = false;
        this.postShellState();
    }

    private async initializeWebview(): Promise<void> {
        try {
            await this.reloadSessions();
            await this.loadConfigAndProviders();

            if (!this._currentSessionId && this._sessions.length > 0) {
                const workspaceRoot = this._editorContext.getWorkspaceRoot();
                if (workspaceRoot) {
                    // Prefer the most recent session whose directory matches the workspace
                    const normalizedRoot = normalizePathForCompare(workspaceRoot);
                    const match = this._sessions.find(s => normalizePathForCompare(s.directory) === normalizedRoot);
                    if (match) {
                        this._currentSessionId = match.id;
                    }
                    // If no match, leave undefined — user will get a new session on first prompt
                } else {
                    // No workspace — fall back to the most recent session
                    this._currentSessionId = this._sessions[0].id;
                }
            }

            if (this._currentSessionId) {
                await this.loadSession(this._currentSessionId);
            } else {
                this._timeline.reset(undefined, []);
                this.postShellState();
                this.postTimeline();
            }
        } catch (err) {
            this.showError(`Failed to initialize MiMoCode: ${toMessage(err)}`);
        }
    }

    private async reloadSessions(): Promise<void> {
        const workspaceRoot = this._editorContext.getWorkspaceRoot();
        const opts: { directory?: string; limit: number } = { limit: 100 };
        if (workspaceRoot) {
            opts.directory = workspaceRoot;
        }

        const sessions = await this._apiClient.listSessions(opts);

        // Frontend filter: even if backend filters by directory, re-verify locally
        // to avoid cross-workspace session leakage.
        if (workspaceRoot) {
            const normalizedRoot = normalizePathForCompare(workspaceRoot);
            this._sessions = sessions.filter(s => {
                return normalizePathForCompare(s.directory) === normalizedRoot;
            });
        } else {
            this._sessions = sessions;
        }

        this.postShellState();
    }

    private async loadConfigAndProviders(): Promise<void> {
        const [config, globalConfig, providers] = await Promise.all([
            this._apiClient.getConfig().catch(() => ({} as ConfigInfo)),
            this._apiClient.getGlobalConfig().catch(() => ({} as ConfigInfo)),
            this._apiClient.getProviders().catch(() => undefined)
        ]);
        this._config = config;
        this._providers = providers;

        // Model is stored in global config. GET /config returns merged (global+project),
        // but if model was never set, it may be absent from both.
        this._currentModel = getConfigModel(config) || getConfigModel(globalConfig);
        this._effectiveModelRef = normalizeModelRef(this._currentModel);

        // Compute models list — filter to connected providers only
        if (providers) {
            const allModels = this._apiClient.normalizeModels(providers);
            const connected = new Set(providers.connected || []);
            const connectedModels = allModels.filter(m => connected.has(m.providerID));

            if (connectedModels.length > 0) {
                this._models = connectedModels;
            } else {
                this._models = allModels;
            }

            // Ensure current configured model is in the list even if not in connected providers
            if (this._currentModel && !this._models.some(m => m.label === this._currentModel)) {
                this._models.unshift({
                    label: this._currentModel,
                    description: 'Current configured model',
                    providerID: this._currentModel.split('/')[0] || '',
                    modelID: this._currentModel.split('/').slice(1).join('/')
                });
            }

            // Update variant options for current model
            this.updateVariantOptions();
        } else {
            this._models = [];
            this._variantOptions = [];
        }
    }

    /**
     * Update variant options based on the current model.
     * Variant names come from the provider model info (e.g. "low", "medium", "high").
     */
    private updateVariantOptions(): void {
        if (!this._providers || !this._currentModel) {
            this._variantOptions = [];
            return;
        }
        const [providerID, ...rest] = this._currentModel.split('/');
        const modelID = rest.join('/');
        this._variantOptions = this._apiClient.getVariantsForModel(this._providers, providerID, modelID);
        // If current variant is not in the new options, clear it
        if (this._currentVariant && !this._variantOptions.includes(this._currentVariant)) {
            this._currentVariant = undefined;
        }
    }

    /**
     * Public: re-fetch config/providers and push updated state to webview.
     * Called after sign-in, model change, or manual refresh.
     */
    async refreshProviders(): Promise<void> {
        try {
            await this.loadConfigAndProviders();
            this.postShellState();
        } catch {
            // silently ignore refresh errors
        }
    }

    private async loadSession(sessionId: string): Promise<void> {
        try {
            // Guard: prevent loading a session from another workspace
            const workspaceRoot = this._editorContext.getWorkspaceRoot();
            if (workspaceRoot) {
                const session = await this._apiClient.getSession(sessionId);
                const normalizedRoot = normalizePathForCompare(workspaceRoot);
                if (normalizePathForCompare(session.directory) !== normalizedRoot) {
                    this.showError('Cannot switch to a session from another workspace.');
                    return;
                }
            }

            // Clear pending question mappings when switching sessions
            this._pendingQuestions.clear();
            this._errorDedup.clear();
            this._currentSessionId = sessionId;
            const [session, messages, statuses] = await Promise.all([
                this._apiClient.getSession(sessionId),
                this._apiClient.getMessages(sessionId),
                this._apiClient.getSessionStatus().catch(() => ({} as Record<string, SessionStatusInfo>))
            ]);
            const status = statuses[sessionId];
            this._timeline.reset(session, messages, status);
            this.postShellState();
            this.postTimeline();
        } catch (err) {
            this.showError(`Failed to load session: ${toMessage(err)}`);
        }
    }

    private async ensureSession(): Promise<string> {
        const workspaceRoot = this._editorContext.getWorkspaceRoot();

        if (workspaceRoot) {
            const normalizedRoot = normalizePathForCompare(workspaceRoot);

            // If we have a current session, verify it belongs to this workspace
            if (this._currentSessionId) {
                const currentSession = this._sessions.find(s => s.id === this._currentSessionId);
                if (currentSession && normalizePathForCompare(currentSession.directory) === normalizedRoot) {
                    console.log(`[MiMoCode] ensureSession: reusing ${this._currentSessionId} (directory=${currentSession.directory})`);
                    return this._currentSessionId;
                }
                // Current session doesn't match workspace — find or create
                this._currentSessionId = undefined;
            }

            // Find a session in the list that matches this workspace
            const match = this._sessions.find(s => normalizePathForCompare(s.directory) === normalizedRoot);
            if (match) {
                this._currentSessionId = match.id;
                console.log(`[MiMoCode] ensureSession: switched to ${match.id} (directory=${match.directory})`);
                return match.id;
            }

            // No matching session — create a new one
            const session = await this._apiClient.newSession({ directory: workspaceRoot });
            // Verify the server actually used the requested directory
            const created = await this._apiClient.getSession(session.id);
            if (normalizePathForCompare(created.directory) !== normalizedRoot) {
                console.warn(
                    `[MiMoCode] Server ignored requested session directory. ` +
                    `requested: ${workspaceRoot}, actual: ${created.directory}`
                );
            }
            this._currentSessionId = created.id;
            console.log(`[MiMoCode] ensureSession: created ${created.id} for directory=${workspaceRoot}`);
            await this.reloadSessions();
            this._timeline.reset(created, []);
            this.postTimeline();
            return created.id;
        }

        // No workspace root
        if (this._currentSessionId) {
            return this._currentSessionId;
        }

        // No workspace, no session — create one without directory
        const session = await this._apiClient.newSession();
        this._currentSessionId = session.id;
        await this.reloadSessions();
        this._timeline.reset(session, []);
        this.postTimeline();
        return session.id;
    }

    private async handleWebviewMessage(msg: any): Promise<void> {
        try {
            switch (msg.type) {
                case 'ready':
                    await this.initializeWebview();
                    break;
                case 'sendPrompt':
                    await this.handleSendPrompt(msg.text, msg.agent);
                    break;
                case 'abort':
                    await this.abort();
                    break;
                case 'newSession':
                    await this.newSession();
                    break;
                case 'switchSession':
                    await this.loadSession(msg.sessionId);
                    break;
                case 'deleteSession':
                    await this.handleDeleteSession(msg.sessionId);
                    break;
                case 'forkSession':
                    await this.handleForkSession(msg.sessionId, msg.messageId);
                    break;
                case 'revertSession':
                    await this.handleRevertSession(msg.sessionId, msg.messageId);
                    break;
                case 'searchMention':
                    await this.handleSearchMention(msg.query);
                    break;
                case 'resolveMention':
                    await this.handleResolveMention(msg.item);
                    break;
                case 'viewDiff':
                    this._diffManager.showDiffEditor(msg.diffId);
                    break;
                case 'acceptDiff':
                    await this._diffManager.acceptDiff(msg.diffId);
                    break;
                case 'rejectDiff':
                    await this._diffManager.rejectDiff(msg.diffId);
                    break;
                case 'refresh':
                    await this.initializeWebview();
                    break;
                case 'signIn':
                    this._onSignInRequest?.();
                    break;
                case 'answerQuestion':
                    await this.handleAnswerQuestion({
                        answer: msg.answer,
                        sessionId: msg.sessionId,
                        messageId: msg.messageId,
                        toolCallId: msg.toolCallId,
                        requestID: msg.requestID
                    });
                    break;
                case 'setModel':
                    await this.handleSetModel(msg.model);
                    break;
                case 'setVariant':
                    await this.handleSetVariant(msg.variant);
                    break;
                case 'changeModel':
                    vscode.commands.executeCommand('mimocode.setModel');
                    break;
                case 'refreshProviders':
                    await this.refreshProviders();
                    break;
                case 'signInProvider':
                    vscode.commands.executeCommand('mimocode.signInProvider');
                    break;
            }
        } catch (err) {
            this.showError(toMessage(err));
        }
    }

    private async handleSendPrompt(text: string, agent?: string): Promise<void> {
        const prompt = String(text || '').trim();
        if (!prompt) {
            return;
        }

        // Always go through ensureSession() so workspace directory is validated;
        // do not trust any sessionId from the webview directly.
        const sid = await this.ensureSession();
        const context = this._editorContext.gatherContext();
        const promptOptions = this.getPromptOptions(agent);

        // CLI/TUI-aligned async flow:
        // POST /prompt_async returns 204 immediately. All timeline updates
        // (user message, assistant message, parts, errors) arrive via SSE.
        // Busy state is driven by session.status SSE events, not manually.
        try {
            await this._apiClient.sendPromptAsync(sid, prompt, context, promptOptions);
        } catch (err) {
            // Only network-level failures (connection refused, timeout) reach here.
            // Prompt-level errors (model not found, provider auth, etc.) are
            // delivered via SSE session.error and rendered by handleSseEvent.
            const errMsg = toMessage(err);
            if (err instanceof ApiError && err.statusCode === 409) {
                this.showError('Session is busy. Use Abort, then try again.');
            } else {
                this.showError(`Failed to send prompt: ${errMsg}`);
            }
        }
    }

    private async handleDeleteSession(sessionId?: string): Promise<void> {
        if (!sessionId) {
            return;
        }
        await this._apiClient.deleteSession(sessionId);
        if (this._currentSessionId === sessionId) {
            this._currentSessionId = undefined;
        }
        await this.reloadSessions();
        if (!this._currentSessionId && this._sessions.length > 0) {
            // When workspace exists, pick a matching session; otherwise fall back to first
            const workspaceRoot = this._editorContext.getWorkspaceRoot();
            if (workspaceRoot) {
                const normalizedRoot = normalizePathForCompare(workspaceRoot);
                const match = this._sessions.find(s => normalizePathForCompare(s.directory) === normalizedRoot);
                if (match) {
                    await this.loadSession(match.id);
                } else {
                    this._timeline.reset(undefined, []);
                    this.postTimeline();
                }
            } else {
                await this.loadSession(this._sessions[0].id);
            }
        } else {
            this._timeline.reset(undefined, []);
            this.postTimeline();
        }
    }

    private async handleForkSession(sessionId?: string, messageId?: string): Promise<void> {
        const source = sessionId || this._currentSessionId;
        if (!source) {
            return;
        }
        const forked = await this._apiClient.forkSession(source, messageId);
        await this.reloadSessions();
        await this.loadSession(forked.id);
    }

    private async handleRevertSession(sessionId?: string, messageId?: string): Promise<void> {
        const source = sessionId || this._currentSessionId;
        if (!source || !messageId) {
            return;
        }
        const reverted = await this._apiClient.revertSession(source, messageId);
        await this.reloadSessions();
        await this.loadSession(reverted.id);
    }

    private async handleSearchMention(query: string): Promise<void> {
        const items = await this._mentionProvider.getMentionItems(query || '');
        this.postMessage({ type: 'mentionResults', items });
    }

    private async handleResolveMention(item: any): Promise<void> {
        const content = await this._mentionProvider.resolveMentionContent(item);
        this.postMessage({ type: 'mentionContent', item, content });
    }

    private async handleAnswerQuestion(payload: {
        answer: string;
        sessionId?: string;
        messageId?: string;
        toolCallId?: string;
        requestID?: string;
    }): Promise<void> {
        if (!payload.answer) {
            return;
        }

        const sid = payload.sessionId || this._currentSessionId;

        // Resolve requestID: from payload, from pending map (session-scoped), or try fetching
        let requestID = payload.requestID;
        if (!requestID && payload.toolCallId && sid) {
            requestID = this._pendingQuestions.get(`${sid}:${payload.toolCallId}`);
        }
        if (!requestID) {
            requestID = await this.findPendingQuestionRequestID(sid);
        }

        if (requestID) {
            try {
                await this._apiClient.answerQuestion(requestID, [[payload.answer]]);
                // Clean up pending map
                if (payload.toolCallId && sid) {
                    this._pendingQuestions.delete(`${sid}:${payload.toolCallId}`);
                }
                return;
            } catch {
                // Fall through to appendTuiPrompt
            }
        }

        // Fallback: appendTuiPrompt
        try {
            await this._apiClient.appendTuiPrompt(payload.answer + '\n');
        } catch {
            this.showError('Failed to answer MiMoCode question. The headless question answer protocol may be unsupported.');
        }
    }

    /**
     * Try to find the requestID for a pending question by fetching GET /question.
     * Matches by sessionID if available.
     */
    private async findPendingQuestionRequestID(sessionId?: string): Promise<string | undefined> {
        try {
            const questions = await this._apiClient.listPendingQuestions();
            if (!Array.isArray(questions) || questions.length === 0) {
                return undefined;
            }
            // Find a question matching the current session only; never cross sessions
            const match = sessionId
                ? questions.find(q => q.sessionID === sessionId)
                : questions[0];
            if (match) {
                // Store the mapping for future use (session-scoped)
                if (match.tool?.callID && match.sessionID) {
                    this._pendingQuestions.set(`${match.sessionID}:${match.tool.callID}`, match.id);
                }
                return match.id;
            }
        } catch {
            // ignore
        }
        return undefined;
    }

    /**
     * Public: set the current model. Called from webview or command palette.
     * Model is stored in global config via PATCH /global/config.
     */
    async setModel(modelRef: string): Promise<void> {
        if (!modelRef) return;
        try {
            await this._apiClient.setModel(modelRef);
            await this.loadConfigAndProviders();

            // Verify: read back from config
            const effective = normalizeModelRef(this._currentModel);
            if (!effective) {
                // Config readback empty — trust the PATCH succeeded, update local state
                this._currentModel = modelRef;
                this._effectiveModelRef = normalizeModelRef(modelRef);
            } else if (effective !== normalizeModelRef(modelRef)) {
                this.showError(
                    `Model update did not persist. Requested: ${modelRef}, current: ${effective}.`
                );
            }

            this.updateVariantOptions();
            this.postShellState();
        } catch (err) {
            const msg = toMessage(err);
            if (this.isModelProviderError(msg)) {
                this.showActionableError(`Failed to set model: ${msg}`, [
                    { label: 'Change Model', action: 'changeModel' },
                    { label: 'Refresh Providers', action: 'refreshProviders' },
                    { label: 'Sign In Provider', action: 'signInProvider' }
                ]);
            } else {
                this.showError(`Failed to set model: ${msg}`);
            }
        }
    }

    /**
     * Public: set the current variant (reasoning effort). Called from webview or command palette.
     */
    async setVariant(variant: string | undefined): Promise<void> {
        this._currentVariant = variant || undefined;
        this.postShellState();
    }

    /**
     * Public: get current variant options for the command palette.
     */
    getVariantOptions(): string[] {
        return [...this._variantOptions];
    }

    /**
     * Public: get current models list for the command palette.
     */
    getModels(): Array<{ label: string; description?: string; providerID: string; modelID: string }> {
        return [...this._models];
    }

    private async handleSetModel(modelRef: string): Promise<void> {
        await this.setModel(modelRef);
    }

    private async handleSetVariant(variant: string): Promise<void> {
        // Validate variant is in allowed list (empty string means default/no variant)
        if (variant && this._variantOptions.length > 0 && !this._variantOptions.includes(variant)) {
            this.showError(`Invalid variant "${variant}". Allowed: ${this._variantOptions.join(', ')}`);
            return;
        }
        await this.setVariant(variant || undefined);
    }

    private async refreshStatus(): Promise<void> {
        if (!this._currentSessionId) {
            return;
        }
        const statuses = await this._apiClient.getSessionStatus().catch(() => ({} as Record<string, SessionStatusInfo>));
        this._timeline.setStatus(statuses[this._currentSessionId]);
    }

    private handleSseEvent(event: SseEvent): void {
        // Handle question events — use session-scoped key (sessionID+callID)
        if (event.type === 'question.asked') {
            const requestID = event.properties?.id as string | undefined;
            const sessionID = event.properties?.sessionID as string | undefined;
            const callID =
                (event.properties?.tool?.callID as string | undefined) ||
                (event.properties?.callID as string | undefined) ||
                (event.properties?.part?.callID as string | undefined) ||
                (event.properties?.toolCallId as string | undefined) ||
                (event.properties?.toolCallID as string | undefined);
            // Only track questions for the current session
            if (requestID && callID && sessionID && sessionID === this._currentSessionId) {
                const key = `${sessionID}:${callID}`;
                this._pendingQuestions.set(key, requestID);
            }
            return;
        }
        if (event.type === 'question.replied' || event.type === 'question.rejected') {
            const requestID =
                (event.properties?.requestID as string | undefined) ||
                (event.properties?.id as string | undefined);
            const sessionID = event.properties?.sessionID as string | undefined;
            if (requestID && sessionID) {
                const prefix = `${sessionID}:`;
                for (const [key, rid] of this._pendingQuestions.entries()) {
                    if (key.startsWith(prefix) && rid === requestID) {
                        this._pendingQuestions.delete(key);
                        break;
                    }
                }
            }
            return;
        }

        const sessionID = event.properties?.sessionID as string | undefined;
        if (sessionID && this._currentSessionId && sessionID !== this._currentSessionId) {
            if (event.type === 'session.updated' || event.type === 'session.created' || event.type === 'session.deleted') {
                void this.reloadSessions();
            }
            return;
        }

        if (event.type === 'server.connected' || event.type === 'server.heartbeat') {
            this.postShellState();
            return;
        }

        // For session.error: handle special cases BEFORE applying to timeline.
        if (event.type === 'session.error') {
            const errorObj = event.properties.error;
            const errorName = errorObj?.name || '';
            const errMsg = typeof errorObj === 'string'
                ? errorObj
                : (errorObj?.message || errorObj?.data?.message || JSON.stringify(errorObj));

            // Abort is not a real error — it's a user-initiated interrupt.
            // The message's finish field and info.error already carry this state;
            // rendering a big red session-level error card is misleading.
            if (errorName === 'MessageAbortedError' || errMsg.includes('MessageAbortedError')) {
                return;
            }

            if (this.isModelProviderError(errMsg)) {
                this.showActionableErrorDeduped(`Model / Provider Error: ${errMsg}`, [
                    { label: 'Change Model', action: 'changeModel' },
                    { label: 'Refresh Providers', action: 'refreshProviders' },
                    { label: 'Sign In Provider', action: 'signInProvider' }
                ], sessionID);
                return; // skip plain error card
            }
        }

        const patch = this._timeline.applyEvent(event);

        // Note: message.info.error is rendered by the webview's renderMessageError()
        // inside the message bubble. Do NOT create a separate session-level error
        // card for it — that would duplicate the error display.

        if (event.type === 'session.diff' && sessionID) {
            const files = event.properties.diff;
            if (Array.isArray(files) && files.length > 0) {
                this._diffManager.addFileDiffs(sessionID, files, event.properties.messageID as string | undefined);
            }
        }
        if (event.type === 'session.status') {
            this._busy = event.properties.status?.type === 'busy' || event.properties.status?.type === 'retry';
            this.postShellState();
        }
        if (event.type === 'session.updated' || event.type === 'session.created' || event.type === 'session.deleted') {
            void this.reloadSessions();
        }
        if (patch) {
            this.postMessage({ type: 'timelinePatch', patch });
            this.postTimeline();
        }
    }

    private postShellState(): void {
        this.postMessage({
            type: 'shellState',
            currentSessionId: this._currentSessionId,
            sessions: this._sessions,
            config: this._config,
            providers: this._providers,
            sseState: this._sseClient.state,
            busy: this._busy,
            model: this._effectiveModelRef || this._currentModel,
            models: this._models,
            variant: this._currentVariant,
            variantOptions: this._variantOptions
        });
    }

    private getPromptOptions(agent?: string): PromptOptions {
        const opts: PromptOptions = {};
        if (this._effectiveModelRef) {
            opts.modelRef = this._effectiveModelRef;
        }
        if (this._currentVariant) {
            opts.variant = this._currentVariant;
        }
        if (agent) {
            opts.agent = agent;
        }
        return opts;
    }

    private postTimeline(): void {
        const snapshot = this._timeline.snapshot();
        this.injectQuestionRequestIDs(snapshot);
        this.postMessage({ type: 'timelineSnapshot', snapshot });
    }

    /**
     * Inject pending question requestIDs into question tool parts
     * so the webview can use them when answering.
     */
    private injectQuestionRequestIDs(snapshot: { messages: Array<{ parts: Array<any> }> }): void {
        for (const message of snapshot.messages) {
            for (const part of message.parts) {
                if (part.type === 'tool' && part.tool === 'question' && part.state?.status !== 'completed') {
                    const key = `${part.sessionID}:${part.callID}`;
                    const requestID = this._pendingQuestions.get(key);
                    if (requestID && !part._questionRequestID) {
                        part._questionRequestID = requestID;
                    }
                }
            }
        }
    }

    private postMessage(message: unknown): void {
        void this._view?.webview.postMessage(message);
    }

    private showError(message: string): void {
        const error = this._timeline.addError({ sessionID: this._currentSessionId, message });
        this.postMessage({ type: 'error', message });
        this.postMessage({ type: 'timelinePatch', patch: { kind: 'error', error } });
        this.postTimeline();
        vscode.window.showErrorMessage(message);
    }

    /**
     * Show an actionable error card in the timeline (no VS Code toast).
     * Used for model/provider errors that the user can fix from the UI.
     */
    private showActionableError(message: string, actions: Array<{ label: string; action: string }>): void {
        const error = this._timeline.addError({
            sessionID: this._currentSessionId,
            message,
            actions
        });
        this.postMessage({ type: 'timelinePatch', patch: { kind: 'error', error } });
        this.postTimeline();
    }

    /**
     * Show an actionable error card with deduplication (5s window).
     * Prevents the same error from flooding the timeline.
     */
    private showActionableErrorDeduped(
        message: string,
        actions: Array<{ label: string; action: string }>,
        sessionID?: string,
        messageID?: string
    ): void {
        const now = Date.now();
        const dedupKey = `${sessionID || ''}:${message}`;
        const lastShown = this._errorDedup.get(dedupKey) || 0;
        if (now - lastShown < 5000) return;
        this._errorDedup.set(dedupKey, now);

        const error = this._timeline.addError({
            sessionID: sessionID || this._currentSessionId,
            messageID,
            source: messageID ? 'message' : 'session',
            message,
            actions
        });
        this.postMessage({ type: 'timelinePatch', patch: { kind: 'error', error } });
        this.postTimeline();
    }

    /**
     * Check if an error is a model/provider error that should show actionable card.
     */
    private isModelProviderError(errMsg: string): boolean {
        return /insufficient.+balance|not supported.+model|param incorrect|unauthorized|provider/i.test(errMsg);
    }

    dispose(): void {
        this._timeline.dispose();
        this._disposables.forEach(disposable => disposable.dispose());
    }
}

function toMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return JSON.stringify(error);
}

/**
 * Extract the current model from a config object.
 * Tries multiple paths to handle different config structures.
 */
function getConfigModel(config: ConfigInfo): string | undefined {
    if (typeof config.model === 'string' && config.model.trim()) {
        return config.model.trim();
    }
    if (typeof (config as any).modelRef === 'string' && (config as any).modelRef.trim()) {
        return (config as any).modelRef.trim();
    }
    return undefined;
}

function normalizeModelRef(model: string | undefined): string | undefined {
    if (!model) {
        return undefined;
    }
    const trimmed = model.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed === 'anthropic/unknown' || trimmed.endsWith('/unknown')) {
        return 'standard';
    }
    return trimmed;
}

function normalizePathForCompare(input?: string): string | undefined {
    if (!input) return undefined;
    return path.resolve(input);
}
