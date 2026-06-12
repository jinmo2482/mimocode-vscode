import * as vscode from 'vscode';

export interface MimocodeConfig {
    server: {
        port: number;
        path: string;
        autoStart: boolean;
    };
    model?: string;
    mode: 'code' | 'chat' | 'auto';
}

export class ConfigManager implements vscode.Disposable {
    private _onConfigChange = new vscode.EventEmitter<MimocodeConfig>();
    private _disposables: vscode.Disposable[] = [];

    readonly onConfigChange = this._onConfigChange.event;

    constructor() {
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('mimocode')) {
                    this._onConfigChange.fire(this.getConfig());
                }
            })
        );
    }

    getConfig(): MimocodeConfig {
        const config = vscode.workspace.getConfiguration('mimocode');
        return {
            server: {
                port: config.get<number>('server.port', 7860),
                path: config.get<string>('server.path', 'mimo'),
                autoStart: config.get<boolean>('server.autoStart', true)
            },
            model: config.get<string>('model'),
            mode: config.get<'code' | 'chat' | 'auto'>('mode', 'auto')
        };
    }

    async updateConfig(section: string, value: any): Promise<void> {
        const config = vscode.workspace.getConfiguration('mimocode');
        await config.update(section, value, vscode.ConfigurationTarget.Global);
    }

    dispose(): void {
        this._onConfigChange.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}
