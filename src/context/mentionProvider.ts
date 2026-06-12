import * as vscode from 'vscode';
import * as path from 'path';

export interface MentionItem {
    label: string;
    description: string;
    path: string;
    type: 'file' | 'folder' | 'symbol';
}

export class MentionProvider {
    private _disposables: vscode.Disposable[] = [];

    constructor() {}

    async getMentionItems(query: string): Promise<MentionItem[]> {
        const items: MentionItem[] = [];
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!workspaceRoot) {
            return items;
        }

        try {
            const files = await vscode.workspace.findFiles(
                `**/*${query}*`,
                '**/node_modules/**',
                20
            );

            for (const file of files) {
                const relativePath = path.relative(workspaceRoot, file.fsPath);
                items.push({
                    label: path.basename(file.fsPath),
                    description: relativePath,
                    path: file.fsPath,
                    type: 'file'
                });
            }
        } catch (err) {
        }

        return items;
    }

    async resolveMentionContent(item: MentionItem): Promise<string> {
        try {
            const doc = await vscode.workspace.openTextDocument(item.path);
            return doc.getText();
        } catch {
            return '';
        }
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }
}
