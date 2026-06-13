import * as vscode from 'vscode';
import { getStyles } from './styles';
import { getScript } from './script';

export function getHtml(webview: vscode.Webview): string {
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
    <div class="header">
        <div class="header-left">
            <span class="status-dot" id="status-dot" title="Connection status"></span>
            <select id="session-select" title="Session"></select>
            <span class="meta-chips" id="meta"></span>
        </div>
        <div class="header-right">
            <button class="header-btn" id="new-session" title="New session">+</button>
            <button class="header-btn" id="refresh" title="Refresh">&#x21bb;</button>
        </div>
    </div>
    <section id="login-screen" class="login-screen hidden">
        <div class="login-card">
            <div class="login-logo">&#x2731;</div>
            <h2>Welcome to MiMoCode</h2>
            <p>Sign in to an AI provider to start coding with MiMoCode.</p>
            <button id="sign-in-btn" class="login-btn">Sign In to Provider</button>
            <p class="login-hint">Or use Ctrl+Shift+P &rarr; MiMoCode: Sign In to Provider</p>
        </div>
    </section>
    <main id="timeline" class="timeline"></main>
    <section id="mentions" class="mentions hidden"></section>
    <footer class="composer">
        <div class="agent-bar" id="agent-bar"></div>
        <div class="control-row" id="control-row">
            <button class="details-toggle" id="details-toggle" title="Show/hide tool details">Details</button>
            <label class="control-label">Model
                <select id="model-select" class="control-select"></select>
            </label>
            <label class="control-label">Reasoning
                <select id="variant-select" class="control-select"></select>
            </label>
        </div>
        <div class="composer-input-wrap">
            <textarea id="prompt" placeholder="Ask MiMoCode... (@ to mention)" rows="1"></textarea>
            <div class="composer-actions">
                <button class="abort-btn hidden" id="abort" title="Abort">Stop</button>
                <button class="send-btn" id="send" title="Send (Ctrl+Enter)">&#x27a4;</button>
            </div>
        </div>
        <div class="composer-hint">Ctrl+Enter to send</div>
    </footer>
    <script nonce="${nonce}">${getScript()}</script>
</body>
</html>`;
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
