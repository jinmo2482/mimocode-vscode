import * as vscode from 'vscode';
import { ServerManager, ServerState } from '../server/serverManager';
import { SseConnectionState } from '../api/sseClient';

export class StatusBarManager implements vscode.Disposable {
    private _statusBarItem: vscode.StatusBarItem;
    private _disposables: vscode.Disposable[] = [];
    private _serverState: ServerState;
    private _sseState: SseConnectionState = 'disconnected';
    private _sessionLabel = 'No session';

    constructor(private _serverManager: ServerManager) {
        this._statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this._statusBarItem.command = 'mimocode.openChat';
        this._serverState = this._serverManager.state;

        this._disposables.push(
            this._serverManager.onStateChange(state => {
                this._serverState = state;
                this.updateStatusBar();
            })
        );

        this.updateStatusBar();
        this._statusBarItem.show();
    }

    setSseState(state: SseConnectionState): void {
        this._sseState = state;
        this.updateStatusBar();
    }

    setSessionLabel(label: string): void {
        this._sessionLabel = label;
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        const server = this._serverState;
        const sse = this._sseState;

        switch (server) {
            case ServerState.Running:
                this._statusBarItem.text = sse === 'connected' ? '$(check) MiMoCode' : '$(sync~spin) MiMoCode';
                this._statusBarItem.tooltip = `MiMoCode: ${this._sessionLabel}`;
                this._statusBarItem.backgroundColor = undefined;
                break;
            case ServerState.Starting:
                this._statusBarItem.text = '$(sync~spin) MiMoCode';
                this._statusBarItem.tooltip = 'MiMoCode: Starting...';
                this._statusBarItem.backgroundColor = undefined;
                break;
            case ServerState.Error:
                this._statusBarItem.text = '$(warning) MiMoCode';
                this._statusBarItem.tooltip = 'MiMoCode: Server error';
                this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                break;
            case ServerState.Stopped:
                this._statusBarItem.text = '$(circle-slash) MiMoCode';
                this._statusBarItem.tooltip = 'MiMoCode: Disconnected';
                this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
        }
    }

    dispose(): void {
        this._statusBarItem.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}
