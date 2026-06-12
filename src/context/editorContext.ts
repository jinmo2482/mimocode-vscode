import * as vscode from 'vscode';

export interface SelectionContext {
    text: string;
    startLine: number;
    endLine: number;
    filePath: string;
    languageId: string;
}

export class EditorContext {
    getSelection(): SelectionContext | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            return undefined;
        }

        const doc = editor.document;
        const sel = editor.selection;

        return {
            text: doc.getText(sel),
            startLine: sel.start.line,
            endLine: sel.end.line,
            filePath: doc.fileName,
            languageId: doc.languageId
        };
    }

    getCurrentFile(): { path: string; languageId: string; content: string } | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }

        const doc = editor.document;
        return {
            path: doc.fileName,
            languageId: doc.languageId,
            content: doc.getText()
        };
    }

    getOpenFiles(): Array<{ path: string; isActive: boolean }> {
        const activeEditor = vscode.window.activeTextEditor;
        return vscode.workspace.textDocuments
            .filter(d => d.uri.scheme === 'file')
            .map(d => ({
                path: d.fileName,
                isActive: d === activeEditor?.document
            }));
    }

    getWorkspaceRoot(): string | undefined {
        // Prefer the workspace folder containing the active text editor
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
            if (folder) {
                return folder.uri.fsPath;
            }
        }
        // Fall back to the first workspace folder
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    gatherContext(): {
        currentFile?: { path: string; languageId: string; content: string };
        selection?: { text: string; startLine: number; endLine: number };
        openFiles?: Array<{ path: string; isActive: boolean }>;
        workspaceRoot?: string;
    } {
        return {
            currentFile: this.getCurrentFile(),
            selection: this.getSelection(),
            openFiles: this.getOpenFiles(),
            workspaceRoot: this.getWorkspaceRoot()
        };
    }
}
