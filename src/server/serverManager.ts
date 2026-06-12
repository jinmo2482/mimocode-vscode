import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';

export interface ServerConfig {
    port: number;
    mimoPath: string;
    autoStart: boolean;
}

export enum ServerState {
    Stopped = 'stopped',
    Starting = 'starting',
    Running = 'running',
    Error = 'error'
}

export class ServerManager implements vscode.Disposable {
    private process: ChildProcess | null = null;
    private _state = ServerState.Stopped;
    private _port: number;
    private _mimoPath: string;
    private _autoStart: boolean;
    private _onStateChange = new vscode.EventEmitter<ServerState>();
    private _outputChannel: vscode.OutputChannel;

    readonly onStateChange = this._onStateChange.event;
    get state(): ServerState { return this._state; }
    get port(): number { return this._port; }
    get baseUrl(): string { return `http://127.0.0.1:${this._port}`; }
    get mimoPath(): string { return this._mimoPath; }

    constructor(config: ServerConfig) {
        this._port = config.port;
        this._mimoPath = config.mimoPath;
        this._autoStart = config.autoStart;
        this._outputChannel = vscode.window.createOutputChannel('MiMoCode Server');
    }

    async start(): Promise<void> {
        if (this._state === ServerState.Running || this._state === ServerState.Starting) {
            return;
        }

        this.setState(ServerState.Starting);
        const isRunning = await this.checkHealth();
        if (isRunning) {
            this._outputChannel.appendLine(`Connected to existing MiMoCode server at ${this.baseUrl}`);
            this.setState(ServerState.Running);
            return;
        }

        try {
            this._outputChannel.appendLine(`Starting MiMoCode server: ${this._mimoPath} --port ${this._port}`);
            this.process = spawn(this._mimoPath, ['--port', String(this._port)], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    OPENCODE_CALLER: 'vscode',
                    MIMOCODE_CALLER: 'vscode'
                }
            });

            this.process.stdout?.on('data', (data: Buffer) => this._outputChannel.append(data.toString()));
            this.process.stderr?.on('data', (data: Buffer) => this._outputChannel.append(data.toString()));

            this.process.on('error', (err) => {
                this._outputChannel.appendLine(`Server error: ${err.message}`);
                this.setState(ServerState.Error);
            });

            this.process.on('exit', (code) => {
                this._outputChannel.appendLine(`Server exited with code ${code}`);
                this.process = null;
                if (this._state !== ServerState.Stopped) {
                    this.setState(ServerState.Stopped);
                }
            });

            await this.waitForHealth(15000);
            this._outputChannel.appendLine('MiMoCode server started successfully');
            this.setState(ServerState.Running);
        } catch (err) {
            this._outputChannel.appendLine(`Failed to start server: ${err}`);
            this.setState(ServerState.Error);
            throw err;
        }
    }

    async stop(): Promise<void> {
        if (!this.process) {
            this.setState(ServerState.Stopped);
            return;
        }

        this._outputChannel.appendLine('Stopping MiMoCode server...');
        return new Promise<void>((resolve) => {
            const proc = this.process;
            const timeout = setTimeout(() => {
                proc?.kill('SIGKILL');
                resolve();
            }, 3000);

            proc?.on('exit', () => {
                clearTimeout(timeout);
                this.process = null;
                this.setState(ServerState.Stopped);
                resolve();
            });

            proc?.kill('SIGTERM');
        });
    }

    updateConfig(config: ServerConfig): void {
        this._port = config.port;
        this._mimoPath = config.mimoPath;
        this._autoStart = config.autoStart;
    }

    async restart(): Promise<void> {
        await this.stop();
        if (this._autoStart) {
            await this.start();
        }
    }

    private async checkHealth(): Promise<boolean> {
        return (await this.checkEndpoint('/path')) || (await this.checkEndpoint('/app'));
    }

    private checkEndpoint(path: string): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(`${this.baseUrl}${path}`, (res) => {
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

    private async waitForHealth(timeoutMs: number): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (await this.checkHealth()) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error(`Health check timeout for ${this.baseUrl}`);
    }

    private setState(state: ServerState): void {
        if (this._state === state) {
            return;
        }
        this._state = state;
        this._onStateChange.fire(state);
    }

    dispose(): void {
        void this.stop();
        this._onStateChange.dispose();
        this._outputChannel.dispose();
    }
}
