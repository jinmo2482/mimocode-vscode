import * as vscode from 'vscode';
import * as path from 'path';
import { ApiClient, Session } from '../api/client';

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private _apiClient: ApiClient,
        private _getWorkspaceRoot: () => string | undefined
    ) {}

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
            const workspaceRoot = this._getWorkspaceRoot();
            const opts: { directory?: string; limit: number } = { limit: 100 };
            if (workspaceRoot) {
                opts.directory = workspaceRoot;
            }

            const sessions = await this._apiClient.listSessions(opts);

            // Frontend filter: even if backend filters by directory, re-verify locally
            if (workspaceRoot) {
                const normalizedRoot = normalizePathForCompare(workspaceRoot);
                const filtered = sessions.filter(s => normalizePathForCompare(s.directory) === normalizedRoot);
                return filtered.map(session => new SessionTreeItem(session));
            }

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

function normalizePathForCompare(input?: string): string | undefined {
    if (!input) return undefined;
    return path.resolve(input);
}
