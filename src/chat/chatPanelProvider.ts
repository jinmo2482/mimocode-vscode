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
    private _timeline = new TimelineStore();
    private _disposables: vscode.Disposable[] = [];
    private _busy = false;
    private _onSignInRequest?: () => void;

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
        const [config, providers] = await Promise.all([
            this._apiClient.getConfig().catch(() => ({} as ConfigInfo)),
            this._apiClient.getProviders().catch(() => undefined)
        ]);
        this._config = config;
        this._providers = providers;
        this._currentModel = typeof config.model === 'string' ? config.model : undefined;
        this._effectiveModelRef = normalizeModelRef(this._currentModel);
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
            this._currentSessionId = session.id;
            console.log(`[MiMoCode] ensureSession: created ${session.id} for directory=${workspaceRoot}`);
            await this.reloadSessions();
            this._timeline.reset(session, []);
            this.postTimeline();
            return session.id;
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
                    await this.handleAnswerQuestion(msg.answer, msg.sessionId);
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

        const workspaceRoot = this._editorContext.getWorkspaceRoot();
        const currentSession = this._sessions.find(s => s.id === sid);
        console.log(`[MiMoCode] sendPrompt: workspaceRoot=${workspaceRoot}, sid=${sid}, session.directory=${currentSession?.directory}`);

        const context = this._editorContext.gatherContext();
        const promptOptions = this.getPromptOptions(agent);
        this._busy = true;
        this.postShellState();

        try {
            const response = await this._apiClient.sendPrompt(sid, prompt, context, promptOptions);
            this._timeline.mergeMessage(response);
            await this.refreshStatus();
            await this.reloadSessions().catch(() => undefined);
            this.postTimeline();
        } catch (err) {
            if (err instanceof ApiError && err.statusCode === 409) {
                this.showError('Session is busy. Use Abort, then try again.');
            } else {
                this.showError(`Failed to send prompt: ${toMessage(err)}`);
            }
        } finally {
            this._busy = false;
            this.postShellState();
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

    private async handleAnswerQuestion(answer: string, sessionId?: string): Promise<void> {
        if (!answer) {
            return;
        }
        try {
            await this._apiClient.appendTuiPrompt(answer);
        } catch (err) {
            const message = 'Failed to answer MiMoCode question. The headless server may not support question replies yet.';
            this.showError(message);
        }
    }

    private async refreshStatus(): Promise<void> {
        if (!this._currentSessionId) {
            return;
        }
        const statuses = await this._apiClient.getSessionStatus().catch(() => ({} as Record<string, SessionStatusInfo>));
        this._timeline.setStatus(statuses[this._currentSessionId]);
    }

    private handleSseEvent(event: SseEvent): void {
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

        const patch = this._timeline.applyEvent(event);
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
            model: this._effectiveModelRef || this._currentModel
        });
    }

    private getPromptOptions(agent?: string): PromptOptions {
        const opts: PromptOptions = {};
        if (this._effectiveModelRef) {
            opts.modelRef = this._effectiveModelRef;
        }
        if (agent) {
            opts.agent = agent;
        }
        return opts;
    }

    private postTimeline(): void {
        this.postMessage({ type: 'timelineSnapshot', snapshot: this._timeline.snapshot() });
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
