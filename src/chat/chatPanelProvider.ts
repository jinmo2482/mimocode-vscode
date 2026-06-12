import * as vscode from 'vscode';
import { ApiClient, ApiError, ConfigInfo, PromptOptions, SessionInfo, SessionStatusInfo } from '../api/client';
import { SseClient, SseEvent } from '../api/sseClient';
import { EditorContext } from '../context/editorContext';
import { MentionProvider } from '../context/mentionProvider';
import { DiffManager } from '../diff/diffManager';
import { TimelineStore } from '../timeline/timelineStore';

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
        webviewView.webview.html = this.getHtml(webviewView.webview);

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
            const session = await this._apiClient.newSession();
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
        await this.handleSendPrompt(text, this._currentSessionId);
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
                this._currentSessionId = this._sessions[0].id;
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
        this._sessions = await this._apiClient.listSessions({ limit: 100 });
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
        if (this._currentSessionId) {
            return this._currentSessionId;
        }
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
                    await this.handleSendPrompt(msg.text, msg.sessionId);
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
            }
        } catch (err) {
            this.showError(toMessage(err));
        }
    }

    private async handleSendPrompt(text: string, sessionId?: string): Promise<void> {
        const prompt = String(text || '').trim();
        if (!prompt) {
            return;
        }

        const sid = sessionId || await this.ensureSession();
        const context = this._editorContext.gatherContext();
        const promptOptions = this.getPromptOptions();
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
            await this.loadSession(this._sessions[0].id);
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

    private async handleSearchMention(query: string): Promise<void> {
        const items = await this._mentionProvider.getMentionItems(query || '');
        this.postMessage({ type: 'mentionResults', items });
    }

    private async handleResolveMention(item: any): Promise<void> {
        const content = await this._mentionProvider.resolveMentionContent(item);
        this.postMessage({ type: 'mentionContent', item, content });
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
            if (Array.isArray(files)) {
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

    private getPromptOptions(): PromptOptions {
        if (this._effectiveModelRef) {
            return { modelRef: this._effectiveModelRef };
        }
        return {};
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

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';`;
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>MiMoCode</title>
    <style>${getStyles()}</style>
</head>
<body>
    <header class="topbar">
        <div class="status-dot" id="status-dot" title="Connection status"></div>
        <select id="session-select" title="Session"></select>
        <button id="new-session" title="New session">＋</button>
        <button id="refresh" title="Refresh">↻</button>
    </header>
    <section class="meta" id="meta"></section>
    <section id="login-screen" class="login-screen hidden">
        <div class="login-card">
            <div class="login-logo">✱</div>
            <h2>Welcome to MiMoCode</h2>
            <p>Sign in to an AI provider to start coding with MiMoCode.</p>
            <button id="sign-in-btn" class="login-btn">Sign In to Provider</button>
            <p class="login-hint">Or use Ctrl+Shift+P → MiMoCode: Sign In to Provider</p>
        </div>
    </section>
    <main id="timeline" class="timeline"></main>
    <section id="mentions" class="mentions hidden"></section>
    <footer class="composer">
        <textarea id="prompt" placeholder="Ask MiMoCode... Use @ to mention files"></textarea>
        <div class="composer-actions">
            <button id="send">Send</button>
            <button id="abort" class="secondary">Abort</button>
        </div>
    </footer>
    <script nonce="${nonce}">${getScript()}</script>
</body>
</html>`;
    }
}

function getStyles(): string {
    return String.raw`
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
    height: 100%;
    width: 100%;
    overflow: hidden;
}
body {
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    display: grid;
    grid-template-rows: auto auto 1fr auto auto;
    grid-template-areas:
        "topbar"
        "meta"
        "main"
        "mentions"
        "composer";
}
/* Login screen */
.login-screen {
    grid-area: main;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(8px, 2vw, 16px);
    min-height: 0;
    overflow-y: auto;
    animation: fadeIn 0.3s ease;
}
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}
.login-screen.hidden { display: none; }
.login-card {
    text-align: center;
    width: min(90%, 340px);
    box-sizing: border-box;
    padding: clamp(20px, 5vw, 36px) clamp(16px, 4vw, 28px);
    border: 1px solid var(--vscode-panel-border);
    border-radius: clamp(10px, 2vw, 16px);
    background: var(--vscode-editor-background);
    box-shadow: 0 4px 24px rgba(0,0,0,0.15);
}
.login-logo {
    font-size: clamp(32px, 6vw, 48px);
    margin-bottom: clamp(8px, 2vw, 16px);
    color: var(--vscode-textLink-foreground);
    line-height: 1;
}
.login-card h2 {
    margin: 0 0 clamp(6px, 1.5vw, 10px);
    font-size: clamp(16px, 3vw, 20px);
    font-weight: 600;
    letter-spacing: -0.01em;
}
.login-card p {
    margin: 0 0 clamp(12px, 3vw, 20px);
    color: var(--vscode-descriptionForeground);
    font-size: clamp(12px, 2vw, 14px);
    line-height: 1.5;
}
.login-btn {
    width: 100%;
    padding: clamp(8px, 2vw, 12px) 20px;
    font-size: clamp(13px, 2.2vw, 15px);
    font-weight: 500;
    border-radius: 8px;
    margin-bottom: clamp(10px, 2.5vw, 16px);
    transition: background 0.15s, transform 0.1s;
}
.login-btn:hover { transform: translateY(-1px); }
.login-btn:active { transform: translateY(0); }
.login-hint {
    font-size: clamp(10px, 1.5vw, 12px) !important;
    color: var(--vscode-descriptionForeground) !important;
    margin: 0 !important;
    opacity: 0.8;
}
/* Topbar */
.topbar {
    grid-area: topbar;
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    gap: clamp(4px, 1vw, 8px);
    align-items: center;
    padding: clamp(6px, 1.2vw, 10px) clamp(8px, 1.5vw, 12px);
    border-bottom: 1px solid var(--vscode-panel-border);
    min-width: 0;
    background: var(--vscode-sideBar-background);
}
.topbar select {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 4px;
    padding: 2px 4px;
}
.status-dot {
    width: 10px;
    height: 10px;
    border-radius: 99px;
    background: var(--vscode-descriptionForeground);
    flex-shrink: 0;
    transition: background 0.3s;
}
.status-dot.connected { background: var(--vscode-testing-iconPassed); }
.status-dot.retrying, .status-dot.connecting { background: var(--vscode-testing-iconQueued); animation: pulse 1.5s infinite; }
.status-dot.error { background: var(--vscode-testing-iconFailed); }
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
/* Form elements */
select, textarea, button { font: inherit; }
select, textarea {
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
}
button {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: 0;
    border-radius: 5px;
    padding: clamp(4px, 1vw, 6px) clamp(8px, 2vw, 12px);
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, opacity 0.15s;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.4; cursor: default; pointer-events: none; }
/* Meta bar */
.meta {
    grid-area: meta;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: clamp(4px, 1vw, 7px) clamp(8px, 1.5vw, 12px);
    display: flex;
    gap: clamp(4px, 1vw, 8px);
    flex-wrap: wrap;
    font-size: clamp(10px, 1.5vw, 12px);
    min-width: 0;
    background: var(--vscode-sideBar-background);
}
.chip {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    padding: 1px clamp(6px, 1.2vw, 8px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    line-height: 1.6;
}
/* Timeline */
.timeline {
    grid-area: main;
    overflow-y: auto;
    overflow-x: hidden;
    padding: clamp(8px, 2vw, 14px) clamp(8px, 2vw, 12px);
    min-height: 0;
    word-break: break-word;
    scroll-behavior: smooth;
}
.empty {
    color: var(--vscode-descriptionForeground);
    padding: clamp(24px, 5vw, 40px) clamp(8px, 2vw, 16px);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
}
.empty-icon {
    font-size: 32px;
    opacity: 0.6;
    line-height: 1;
}
.empty-text {
    font-size: clamp(12px, 2vw, 14px);
    line-height: 1.5;
    max-width: 260px;
}
/* Messages */
.message {
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
    border-radius: clamp(6px, 1.2vw, 8px);
    margin-bottom: clamp(6px, 1.5vw, 12px);
    overflow: hidden;
    min-width: 0;
    transition: border-color 0.15s;
}
.message:hover { border-color: var(--vscode-focusBorder); }
.message.user { background: var(--vscode-input-background); }
.message-header {
    display: flex;
    justify-content: space-between;
    gap: clamp(4px, 1vw, 8px);
    padding: clamp(5px, 1.2vw, 8px) clamp(8px, 1.5vw, 10px);
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: clamp(10px, 1.5vw, 12px);
    min-width: 0;
}
.message-header span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.message-body {
    padding: clamp(8px, 2vw, 12px);
    min-width: 0;
    overflow: hidden;
}
.part { margin: clamp(6px, 1.5vw, 10px) 0; }
.part:first-child { margin-top: 0; }
.text { white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
.reasoning summary, .tool summary, .system summary, .retry summary {
    cursor: pointer;
    color: var(--vscode-textLink-foreground);
    padding: 2px 0;
}
.reasoning summary:hover, .tool summary:hover, .system summary:hover, .retry summary:hover {
    text-decoration: underline;
}
pre {
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
    padding: clamp(6px, 1.5vw, 10px);
    border-radius: 6px;
    background: var(--vscode-textCodeBlock-background);
    max-width: 100%;
    font-size: 0.9em;
    line-height: 1.5;
}
code { font-family: var(--vscode-editor-font-family); word-break: break-all; font-size: 0.9em; }
/* Cards */
.tool-card, .step-card, .diff-card, .error-card, .system-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: clamp(5px, 1vw, 7px);
    padding: clamp(6px, 1.5vw, 10px);
    background: var(--vscode-sideBar-background);
    min-width: 0;
    overflow: hidden;
}
.tool-status { color: var(--vscode-descriptionForeground); font-size: clamp(10px, 1.5vw, 12px); }
.diff-card { margin-bottom: 8px; }
.diff-actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.error-card {
    border-color: var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground, var(--vscode-sideBar-background));
    font-size: clamp(11px, 1.6vw, 13px);
    line-height: 1.5;
}
/* Mentions */
.mentions {
    grid-area: mentions;
    max-height: min(200px, 35vh);
    overflow-y: auto;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-dropdown-background);
    box-shadow: 0 -2px 8px rgba(0,0,0,0.1);
}
.mention-item {
    padding: clamp(5px, 1.2vw, 8px) clamp(8px, 2vw, 12px);
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border);
    transition: background 0.1s;
}
.mention-item:hover { background: var(--vscode-list-hoverBackground); }
.mention-path { color: var(--vscode-descriptionForeground); font-size: clamp(10px, 1.5vw, 12px); }
.hidden { display: none; }
/* Composer */
.composer {
    grid-area: composer;
    padding: clamp(6px, 1.2vw, 10px);
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
}
#prompt {
    width: 100%;
    min-height: clamp(52px, 12vw, 80px);
    max-height: clamp(140px, 35vw, 240px);
    resize: vertical;
    padding: clamp(6px, 1.5vw, 10px);
    border-radius: 6px;
    line-height: 1.5;
    transition: border-color 0.15s;
}
#prompt:focus { border-color: var(--vscode-focusBorder); outline: none; }
.composer-actions {
    display: flex;
    justify-content: flex-end;
    gap: clamp(6px, 1.5vw, 10px);
    margin-top: clamp(6px, 1.5vw, 8px);
}`;
}

function getScript(): string {
    return String.raw`
const vscode = acquireVsCodeApi();
let state = { sessions: [], currentSessionId: null, busy: false, sseState: 'disconnected', model: undefined };
let timeline = { messages: [], diffs: [], errors: [] };

const els = {
  statusDot: document.getElementById('status-dot'),
  sessionSelect: document.getElementById('session-select'),
  newSession: document.getElementById('new-session'),
  refresh: document.getElementById('refresh'),
  meta: document.getElementById('meta'),
  timeline: document.getElementById('timeline'),
  mentions: document.getElementById('mentions'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  abort: document.getElementById('abort'),
  loginScreen: document.getElementById('login-screen'),
  signInBtn: document.getElementById('sign-in-btn')
};

window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'shellState':
      state = { ...state, ...msg };
      renderShell();
      break;
    case 'timelineSnapshot':
      timeline = msg.snapshot || { messages: [], diffs: [], errors: [] };
      renderTimeline();
      break;
    case 'pendingDiffs':
      state.pendingDiffs = msg.diffs || [];
      renderTimeline();
      break;
    case 'mentionResults':
      renderMentions(msg.items || []);
      break;
    case 'mentionContent':
      break;
    case 'error':
      console.error(msg.message);
      break;
  }
});

els.newSession.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
els.refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
els.abort.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
els.send.addEventListener('click', sendPrompt);
els.signInBtn.addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));
els.sessionSelect.addEventListener('change', () => {
  const sessionId = els.sessionSelect.value;
  if (sessionId) vscode.postMessage({ type: 'switchSession', sessionId });
});
els.prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
    event.preventDefault();
    sendPrompt();
  }
});
els.prompt.addEventListener('input', () => {
  const query = currentMentionQuery();
  if (query === null) {
    els.mentions.classList.add('hidden');
  } else {
    vscode.postMessage({ type: 'searchMention', query });
  }
});
els.timeline.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const diffId = button.getAttribute('data-diff-id');
  const action = button.getAttribute('data-action');
  if (!diffId || !action) return;
  vscode.postMessage({ type: action, diffId });
});

function sendPrompt() {
  const text = els.prompt.value.trim();
  if (!text || state.busy) return;
  vscode.postMessage({ type: 'sendPrompt', text, sessionId: state.currentSessionId });
  els.prompt.value = '';
}

function renderShell() {
  const status = state.sseState || 'disconnected';
  els.statusDot.className = 'status-dot ' + status;

  // Show/hide login screen based on provider connection
  const providers = state.providers;
  const connected = providers && providers.connected && providers.connected.length > 0;
  if (!connected) {
    els.loginScreen.classList.remove('hidden');
    els.timeline.style.display = 'none';
    els.mentions.style.display = 'none';
    document.querySelector('.composer').style.display = 'none';
    document.querySelector('.meta').style.display = 'none';
  } else {
    els.loginScreen.classList.add('hidden');
    els.timeline.style.display = '';
    els.mentions.style.display = '';
    document.querySelector('.composer').style.display = '';
    document.querySelector('.meta').style.display = '';
  }

  els.sessionSelect.innerHTML = '';
  if (!state.sessions || state.sessions.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No session';
    els.sessionSelect.appendChild(opt);
  } else {
    for (const session of state.sessions) {
      const opt = document.createElement('option');
      opt.value = session.id;
      opt.textContent = session.title || session.id.slice(0, 8);
      opt.selected = session.id === state.currentSessionId;
      els.sessionSelect.appendChild(opt);
    }
  }
  els.abort.disabled = !state.busy;
  els.send.disabled = !!state.busy;
  const statusLabel = timeline.status?.message || timeline.status?.type || (state.busy ? 'busy' : 'idle');
  els.meta.innerHTML = [
    chip('SSE: ' + status),
    chip('Run: ' + statusLabel),
    chip('Model: ' + (state.model || 'default'))
  ].join('');
}

function renderTimeline() {
  renderShell();
  const chunks = [];
  if ((!timeline.messages || timeline.messages.length === 0) && (!timeline.errors || timeline.errors.length === 0)) {
    chunks.push('<div class="empty"><div class="empty-icon">💬</div><div class="empty-text">Start a conversation with MiMoCode. Type your question or use @ to mention files.</div></div>');
  }
  for (const message of timeline.messages || []) {
    chunks.push(renderMessage(message));
  }
  for (const diff of timeline.diffs || []) {
    chunks.push(renderSessionDiff(diff));
  }
  for (const error of timeline.errors || []) {
    chunks.push('<div class="error-card">' + escapeHtml(error.message) + '</div>');
  }
  for (const diff of state.pendingDiffs || []) {
    chunks.push(renderPendingDiff(diff));
  }
  els.timeline.innerHTML = chunks.join('');
  els.timeline.scrollTop = els.timeline.scrollHeight;
}

function renderMessage(message) {
  const info = message.info || {};
  const parts = message.parts || [];
  const role = info.role || 'assistant';
  const when = info.time?.created ? new Date(info.time.created).toLocaleTimeString() : '';
  const label = role === 'user' ? 'You' : 'MiMoCode';
  return '<article class="message ' + escapeAttr(role) + '">' +
    '<div class="message-header"><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(metaForMessage(info, when)) + '</span></div>' +
    '<div class="message-body">' + parts.map(renderPart).join('') + renderMessageError(info) + '</div>' +
  '</article>';
}

function metaForMessage(info, when) {
  const bits = [];
  if (info.agent) bits.push(info.agent);
  if (info.providerID && info.modelID) bits.push(info.providerID + '/' + info.modelID);
  if (when) bits.push(when);
  return bits.join(' · ');
}

function renderMessageError(info) {
  if (!info.error) return '';
  return '<div class="error-card">' + escapeHtml(errorText(info.error)) + '</div>';
}

function renderPart(part) {
  if (!part) return '';
  switch (part.type) {
    case 'text':
      return '<div class="part text">' + renderMarkdown(part.text || '') + '</div>';
    case 'reasoning':
      return '<details class="part reasoning"><summary>Reasoning</summary><pre>' + escapeHtml(part.text || '') + '</pre></details>';
    case 'tool':
      return renderTool(part);
    case 'step-start':
      return '<div class="part step-card">Step started' + (part.snapshot ? ': ' + escapeHtml(part.snapshot) : '') + '</div>';
    case 'step-finish':
      return '<div class="part step-card">Step finished: ' + escapeHtml(part.reason || 'done') + renderTokens(part.tokens, part.cost) + '</div>';
    case 'retry':
      return '<details class="part retry"><summary>Retry attempt ' + escapeHtml(String(part.attempt)) + '</summary><pre>' + escapeHtml(JSON.stringify(part.error, null, 2)) + '</pre></details>';
    case 'patch':
      return '<div class="part system-card">Patch: ' + escapeHtml((part.files || []).join(', ')) + '</div>';
    case 'file':
      return '<div class="part system-card">File: ' + escapeHtml(part.filename || part.url || 'attachment') + '</div>';
    case 'agent':
      return '<div class="part system-card">Agent: ' + escapeHtml(part.name || 'unknown') + '</div>';
    case 'subtask':
      return '<details class="part system"><summary>Subtask: ' + escapeHtml(part.description || part.agent || 'subtask') + '</summary><pre>' + escapeHtml(part.prompt || '') + '</pre></details>';
    case 'checkpoint':
      return '<div class="part system-card">Checkpoint #' + escapeHtml(String(part.checkpointNumber || '')) + '</div>';
    case 'compaction':
      return '<div class="part system-card">Context compacted' + (part.auto ? ' automatically' : '') + '</div>';
    case 'snapshot':
      return '<div class="part system-card">Snapshot: ' + escapeHtml(part.snapshot || '') + '</div>';
    default:
      return '<details class="part system"><summary>' + escapeHtml(part.type || 'part') + '</summary><pre>' + escapeHtml(JSON.stringify(part, null, 2)) + '</pre></details>';
  }
}

function renderTool(part) {
  const state = part.state || {};
  const title = state.title || part.tool || 'tool';
  const status = state.status || 'pending';
  const body = state.output || state.error || state.raw || JSON.stringify(state.input || {}, null, 2);
  return '<details class="part tool" ' + (status === 'running' ? 'open' : '') + '>' +
    '<summary>' + escapeHtml(title) + ' <span class="tool-status">' + escapeHtml(status) + '</span></summary>' +
    '<div class="tool-card"><pre>' + escapeHtml(body || '') + '</pre></div>' +
  '</details>';
}

function renderTokens(tokens, cost) {
  const bits = [];
  if (typeof cost === 'number') bits.push('$' + cost.toFixed(4));
  if (tokens?.total) bits.push(tokens.total + ' tokens');
  if (tokens?.input || tokens?.output) bits.push((tokens.input || 0) + ' in / ' + (tokens.output || 0) + ' out');
  return bits.length ? '<div class="tool-status">' + escapeHtml(bits.join(' · ')) + '</div>' : '';
}

function renderSessionDiff(diff) {
  const files = diff.files || [];
  return '<div class="diff-card"><strong>Session diff</strong><div class="tool-status">' + escapeHtml(files.length + ' file(s) changed') + '</div>' +
    '<pre>' + escapeHtml(files.map(file => file.path || file.filePath || file.newPath || file.oldPath || 'unknown').join('\n')) + '</pre></div>';
}

function renderPendingDiff(diff) {
  const name = diff.filePath ? diff.filePath.split(/[\\/]/).pop() : 'unknown';
  const reason = diff.conflictReason ? '<div class="error-card">' + escapeHtml(diff.conflictReason) + '</div>' : '';
  return '<div class="diff-card"><strong>' + escapeHtml(name) + '</strong><div class="tool-status">' + escapeHtml(diff.status || 'pending') + '</div>' + reason +
    '<div class="diff-actions">' +
    '<button data-action="viewDiff" data-diff-id="' + escapeAttr(diff.id) + '">View</button>' +
    '<button data-action="acceptDiff" data-diff-id="' + escapeAttr(diff.id) + '">Accept</button>' +
    '<button class="secondary" data-action="rejectDiff" data-diff-id="' + escapeAttr(diff.id) + '">Reject</button>' +
    '</div></div>';
}

function renderMentions(items) {
  if (!items.length) {
    els.mentions.classList.add('hidden');
    return;
  }
  els.mentions.innerHTML = items.map((item, index) => '<div class="mention-item" data-index="' + index + '"><div>' + escapeHtml(item.label) + '</div><div class="mention-path">' + escapeHtml(item.description || item.path || '') + '</div></div>').join('');
  els.mentions.classList.remove('hidden');
  Array.from(els.mentions.querySelectorAll('.mention-item')).forEach(node => {
    node.addEventListener('click', () => {
      const item = items[Number(node.dataset.index)];
      insertMention(item);
      els.mentions.classList.add('hidden');
    });
  });
}

function insertMention(item) {
  const value = '@' + (item.description || item.path || item.label);
  const query = currentMentionQuery();
  const pos = els.prompt.selectionStart;
  const start = query === null ? pos : pos - query.length - 1;
  els.prompt.value = els.prompt.value.slice(0, start) + value + ' ' + els.prompt.value.slice(pos);
  els.prompt.focus();
}

function currentMentionQuery() {
  const pos = els.prompt.selectionStart;
  const before = els.prompt.value.slice(0, pos);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  return match ? match[1] : null;
}

function chip(text) { return '<span class="chip">' + escapeHtml(text) + '</span>'; }
function errorText(error) { return error?.data?.message || error?.message || error?.name || JSON.stringify(error); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function escapeAttr(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }
function renderMarkdown(text) {
  let html = escapeHtml(text);
  const tick = String.fromCharCode(96);
  html = html.replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

vscode.postMessage({ type: 'ready' });`;
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
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
