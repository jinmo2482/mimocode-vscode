import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FileDiff } from '../api/client';

export interface PendingDiff {
    id: string;
    sessionId: string;
    messageId?: string;
    filePath: string;
    originalContent?: string;
    newContent?: string;
    raw: FileDiff;
    status: 'pending' | 'accepted' | 'rejected' | 'conflict';
    conflictReason?: string;
    createdAt: number;
}

export class DiffManager implements vscode.Disposable {
    private _pendingDiffs = new Map<string, PendingDiff>();
    private _onDiffUpdate = new vscode.EventEmitter<PendingDiff[]>();
    private _outputChannel: vscode.OutputChannel;

    readonly onDiffUpdate = this._onDiffUpdate.event;

    constructor() {
        this._outputChannel = vscode.window.createOutputChannel('MiMoCode Diff');
    }

    addDiff(sessionId: string, filePath: string, originalContent: string, newContent: string, messageId?: string): string {
        return this.addFileDiff(sessionId, {
            filePath,
            originalContent,
            newContent
        }, messageId).id;
    }

    addFileDiff(sessionId: string, raw: FileDiff, messageId?: string): PendingDiff {
        const id = `diff_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        const normalized = this.normalizeFileDiff(raw);
        const diff: PendingDiff = {
            id,
            sessionId,
            messageId,
            filePath: normalized.filePath,
            originalContent: normalized.originalContent,
            newContent: normalized.newContent,
            raw,
            status: 'pending',
            createdAt: Date.now()
        };

        this._pendingDiffs.set(id, diff);
        this._onDiffUpdate.fire(this.getPendingDiffs());
        this._outputChannel.appendLine(`New diff for ${diff.filePath}`);
        return diff;
    }

    addFileDiffs(sessionId: string, diffs: FileDiff[], messageId?: string): PendingDiff[] {
        const added = diffs.map(diff => this.addFileDiff(sessionId, diff, messageId));
        this._onDiffUpdate.fire(this.getPendingDiffs());
        return added;
    }

    async acceptDiff(diffId: string): Promise<void> {
        const diff = this._pendingDiffs.get(diffId);
        if (!diff) {
            return;
        }

        if (diff.newContent === undefined) {
            diff.status = 'conflict';
            diff.conflictReason = 'MiMoCode did not provide complete modified file content for this diff.';
            this._onDiffUpdate.fire(this.getPendingDiffs());
            vscode.window.showWarningMessage(diff.conflictReason);
            return;
        }

        try {
            if (diff.originalContent !== undefined && fs.existsSync(diff.filePath)) {
                const current = fs.readFileSync(diff.filePath, 'utf-8');
                if (current !== diff.originalContent) {
                    diff.status = 'conflict';
                    diff.conflictReason = 'The file changed on disk after MiMoCode produced this diff.';
                    this._onDiffUpdate.fire(this.getPendingDiffs());
                    vscode.window.showWarningMessage(`MiMoCode diff conflict: ${diff.filePath}`);
                    return;
                }
            }

            fs.mkdirSync(path.dirname(diff.filePath), { recursive: true });
            fs.writeFileSync(diff.filePath, diff.newContent, 'utf-8');
            diff.status = 'accepted';
            this._pendingDiffs.delete(diffId);
            this._onDiffUpdate.fire(this.getPendingDiffs());
            this._outputChannel.appendLine(`Accepted diff for ${diff.filePath}`);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to write file: ${err}`);
        }
    }

    async rejectDiff(diffId: string): Promise<void> {
        const diff = this._pendingDiffs.get(diffId);
        if (diff) {
            diff.status = 'rejected';
            this._pendingDiffs.delete(diffId);
            this._onDiffUpdate.fire(this.getPendingDiffs());
            this._outputChannel.appendLine(`Rejected diff for ${diff.filePath}`);
        }
    }

    async acceptCurrentDiff(): Promise<void> {
        const pending = this.getPendingDiffs();
        if (pending.length > 0) {
            await this.acceptDiff(pending[0].id);
        }
    }

    async rejectCurrentDiff(): Promise<void> {
        const pending = this.getPendingDiffs();
        if (pending.length > 0) {
            await this.rejectDiff(pending[0].id);
        }
    }

    async acceptAll(): Promise<void> {
        const pending = this.getPendingDiffs();
        for (const diff of pending) {
            await this.acceptDiff(diff.id);
        }
    }

    async rejectAll(): Promise<void> {
        const pending = this.getPendingDiffs();
        for (const diff of pending) {
            await this.rejectDiff(diff.id);
        }
    }

    getPendingDiffs(): PendingDiff[] {
        return Array.from(this._pendingDiffs.values()).filter(d => d.status === 'pending' || d.status === 'conflict');
    }

    showDiffEditor(diffId: string): void {
        const diff = this._pendingDiffs.get(diffId);
        if (!diff) {
            return;
        }

        const original = diff.originalContent ?? this.renderRawDiff(diff.raw);
        const modified = diff.newContent ?? this.renderRawDiff(diff.raw);
        const originalUri = vscode.Uri.parse(`untitled:MiMoCode Original - ${path.basename(diff.filePath)}`);
        const modifiedUri = vscode.Uri.parse(`untitled:MiMoCode Modified - ${path.basename(diff.filePath)}`);

        const edit = new vscode.WorkspaceEdit();
        edit.createFile(originalUri, { ignoreIfExists: true, overwrite: true });
        edit.replace(originalUri, new vscode.Range(0, 0, 0, 0), original);

        edit.createFile(modifiedUri, { ignoreIfExists: true, overwrite: true });
        edit.replace(modifiedUri, new vscode.Range(0, 0, 0, 0), modified);

        vscode.workspace.applyEdit(edit).then(() => {
            vscode.commands.executeCommand(
                'vscode.diff',
                originalUri,
                modifiedUri,
                `MiMoCode: ${path.basename(diff.filePath)}`
            );
        });
    }

    private normalizeFileDiff(raw: FileDiff): { filePath: string; originalContent?: string; newContent?: string } {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const rawPath = raw.filePath || raw.path || raw.newPath || raw.oldPath || 'unknown';
        const filePath = path.isAbsolute(rawPath) || !workspaceRoot ? rawPath : path.join(workspaceRoot, rawPath);
        return {
            filePath,
            originalContent: raw.originalContent ?? raw.original,
            newContent: raw.newContent ?? raw.modified
        };
    }

    private renderRawDiff(raw: FileDiff): string {
        if (!raw.hunks || raw.hunks.length === 0) {
            return JSON.stringify(raw, null, 2);
        }

        const lines: string[] = [];
        for (const hunk of raw.hunks) {
            if (hunk.header) {
                lines.push(hunk.header);
            }
            for (const line of hunk.lines || []) {
                if (typeof line === 'string') {
                    lines.push(line);
                } else {
                    const prefix = line.type === 'add' || line.type === 'added' ? '+' : line.type === 'remove' || line.type === 'removed' ? '-' : ' ';
                    lines.push(`${prefix}${line.content || ''}`);
                }
            }
        }
        return lines.join('\n');
    }

    dispose(): void {
        this._onDiffUpdate.dispose();
        this._outputChannel.dispose();
    }
}
