import * as vscode from 'vscode';
import * as http from 'http';
import { ApiClient } from '../api/client';
import { SseClient } from '../api/sseClient';
import { ConfigManager } from '../config/configManager';

interface CommandEventData {
    name: string;
    sessionID: string;
    arguments: string;
    messageID: string;
}

export class TerminalBridge implements vscode.Disposable {
    private readonly terminalName = 'MiMoCode';
    private _outputChannel: vscode.OutputChannel;
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private _sseClient: SseClient,
        private _apiClient: ApiClient,
        private _configManager: ConfigManager
    ) {
        this._outputChannel = vscode.window.createOutputChannel('MiMoCode Terminal');
        this._disposables.push(
            this._sseClient.onEvent(event => {
                if (event.type === 'command.executed') {
                    this._outputChannel.appendLine(`Command executed: ${JSON.stringify(event.properties as CommandEventData)}`);
                }
            })
        );
    }

    async openTerminal(forceNew = false): Promise<void> {
        if (!forceNew) {
            const existing = vscode.window.terminals.find(terminal => terminal.name === this.terminalName);
            if (existing) {
                existing.show();
                return;
            }
        }

        const port = randomPort();
        const config = this._configManager.getConfig();
        const terminal = vscode.window.createTerminal({
            name: this.terminalName,
            location: {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: false
            },
            env: {
                _EXTENSION_OPENCODE_PORT: String(port),
                OPENCODE_CALLER: 'vscode',
                MIMOCODE_CALLER: 'vscode'
            }
        });

        terminal.show();
        terminal.sendText(`${config.server.path} --port ${port}`);

        const fileRef = this.getActiveFileReference();
        if (!fileRef) {
            return;
        }

        const connected = await this.waitForTerminalServer(port);
        if (connected) {
            await this.appendPromptToPort(port, `In ${fileRef}`);
        }
    }

    async insertActiveFileReference(): Promise<void> {
        const fileRef = this.getActiveFileReference();
        if (!fileRef) {
            vscode.window.showInformationMessage('No active workspace file to reference.');
            return;
        }

        const terminal = vscode.window.activeTerminal;
        if (terminal?.name === this.terminalName) {
            const port = (terminal.creationOptions as any).env?._EXTENSION_OPENCODE_PORT;
            if (port) {
                await this.appendPromptToPort(Number(port), fileRef);
            } else {
                terminal.sendText(fileRef, false);
            }
            terminal.show();
            return;
        }

        await this._apiClient.appendTuiPrompt(fileRef).catch(() => undefined);
        vscode.window.showInformationMessage(`Inserted MiMoCode reference: ${fileRef}`);
    }

    getActiveFileReference(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return undefined;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            return undefined;
        }

        let reference = `@${vscode.workspace.asRelativePath(editor.document.uri)}`;
        const selection = editor.selection;
        if (!selection.isEmpty) {
            const start = selection.start.line + 1;
            const end = selection.end.line + 1;
            reference += start === end ? `#L${start}` : `#L${start}-${end}`;
        }
        return reference;
    }

    private async waitForTerminalServer(port: number): Promise<boolean> {
        for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 250));
            try {
                const ok = await fetchOk(`http://127.0.0.1:${port}/app`);
                if (ok) {
                    return true;
                }
            } catch {
                // Keep waiting while the terminal TUI starts.
            }
        }
        return false;
    }

    private async appendPromptToPort(port: number, text: string): Promise<void> {
        await postJson(`http://127.0.0.1:${port}/tui/append-prompt`, { text });
    }

    dispose(): void {
        this._outputChannel.dispose();
        this._disposables.forEach(disposable => disposable.dispose());
    }
}

function randomPort(): number {
    return Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
}

function fetchOk(url: string): Promise<boolean> {
    return new Promise(resolve => {
        const req = http.get(url, (res) => {
            res.resume();
            resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500));
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

function postJson(url: string, body: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        }, (res) => {
            res.resume();
            res.on('end', resolve);
        });
        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
    });
}
