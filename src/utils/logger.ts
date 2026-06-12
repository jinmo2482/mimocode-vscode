import * as vscode from 'vscode';

export class Logger {
    private static _outputChannel: vscode.OutputChannel;

    static initialize(): void {
        if (!Logger._outputChannel) {
            Logger._outputChannel = vscode.window.createOutputChannel('MiMoCode');
        }
    }

    static info(message: string): void {
        Logger.initialize();
        Logger._outputChannel.appendLine(`[INFO] ${message}`);
    }

    static warn(message: string): void {
        Logger.initialize();
        Logger._outputChannel.appendLine(`[WARN] ${message}`);
    }

    static error(message: string, error?: Error): void {
        Logger.initialize();
        Logger._outputChannel.appendLine(`[ERROR] ${message}`);
        if (error) {
            Logger._outputChannel.appendLine(error.stack || error.message);
        }
    }

    static debug(message: string): void {
        Logger.initialize();
        Logger._outputChannel.appendLine(`[DEBUG] ${message}`);
    }

    static dispose(): void {
        Logger._outputChannel?.dispose();
    }
}
