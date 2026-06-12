import * as vscode from 'vscode';
import { ApiClient, Session } from '../api/client';

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private _apiClient: ApiClient) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SessionTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
        if (element) {
            return [];
        }

        try {
            const sessions = await this._apiClient.listSessions();
            return sessions.map(session => new SessionTreeItem(session));
        } catch (err) {
            return [];
        }
    }
}

export class SessionTreeItem extends vscode.TreeItem {
    constructor(public readonly session: Session) {
        super(session.title || session.id.substring(0, 8), vscode.TreeItemCollapsibleState.None);
        
        this.tooltip = `Session: ${session.title || session.id}\nCreated: ${new Date(session.time.created).toLocaleString()}`;
        this.description = new Date(session.time.updated).toLocaleString();
        
        this.command = {
            command: 'mimocode.switchSession',
            title: 'Switch Session',
            arguments: [session.id]
        };

        this.contextValue = 'session';
    }
}
