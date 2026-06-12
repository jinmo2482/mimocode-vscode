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
    private _actualPort: number;
    private _mimoPath: string;
    private _autoStart: boolean;
    private _onStateChange = new vscode.EventEmitter<ServerState>();
    private _outputChannel: vscode.OutputChannel;

    readonly onStateChange = this._onStateChange.event;
    get state(): ServerState { return this._state; }
    get port(): number { return this._actualPort; }
    get configuredPort(): number { return this._port; }
    get baseUrl(): string { return `http://127.0.0.1:${this._actualPort}`; }
    get mimoPath(): string { return this._mimoPath; }

    constructor(config: ServerConfig) {
        this._port = config.port;
        this._actualPort = config.port;
        this._mimoPath = config.mimoPath;
        this._autoStart = config.autoStart;
        this._outputChannel = vscode.window.createOutputChannel('MiMoCode Server');
    }

    async start(): Promise<void> {
        if (this._state === ServerState.Running || this._state === ServerState.Starting) {
            return;
        }

        this.setState(ServerState.Starting);

        // Reset actual port to configured value before attempting connection
        this._actualPort = this._port;

        const isRunning = await this.checkHealth();
        if (isRunning) {
            this._outputChannel.appendLine(`Connected to existing MiMoCode server at ${this.baseUrl}`);
            this.setState(ServerState.Running);
            return;
        }

        const args = ['serve', '--hostname', '127.0.0.1', '--port', String(this._port)];
        const commandLine = `${this._mimoPath} ${args.join(' ')}`;
        this._outputChannel.appendLine(`Starting MiMoCode server: ${commandLine}`);

        try {
            this.process = spawn(this._mimoPath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    OPENCODE_CALLER: 'vscode',
                    MIMOCODE_CALLER: 'vscode'
                }
            });

            // When port=0, parse stdout/stderr to discover the actual port
            let portResolve: (() => void) | undefined;
            const portPromise = this._port === 0
                ? new Promise<void>((resolve) => {
                    portResolve = resolve;
                })
                : Promise.resolve();

            const handleOutput = (data: Buffer): void => {
                const text = data.toString();
                this._outputChannel.append(text);
                if (portResolve) {
                    const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/i)
                        || text.match(/http:\/\/127\.0\.0\.1:(\d+)/i);
                    if (match) {
                        this._actualPort = parseInt(match[1], 10);
                        this._outputChannel.appendLine(`\nResolved actual server port: ${this._actualPort}`);
                        portResolve();
                        portResolve = undefined;
                    }
                }
            };

            this.process.stdout?.on('data', handleOutput);
            this.process.stderr?.on('data', handleOutput);

            this.process.on('error', (err) => {
                this._outputChannel.appendLine(`Server error: ${err.message}`);
                this.setState(ServerState.Error);
                // Resolve port promise so we don't hang on error
                if (portResolve) { portResolve(); portResolve = undefined; }
            });

            this.process.on('exit', (code) => {
                this._outputChannel.appendLine(`Server exited with code ${code}`);
                this.process = null;
                if (this._state !== ServerState.Stopped) {
                    this.setState(ServerState.Stopped);
                }
                // Resolve port promise so we don't hang on exit
                if (portResolve) { portResolve(); portResolve = undefined; }
            });

            // Wait for port resolution when port=0, with a safety timeout
            if (this._port === 0) {
                const portTimeout = new Promise<void>((resolve) => setTimeout(resolve, 10000));
                await Promise.race([portPromise, portTimeout]);
                if (this._actualPort === 0) {
                    throw new Error('Timed out waiting for MiMoCode server to report its port. Check the MiMoCode Server output channel for details.');
                }
            }

            this._outputChannel.appendLine(`Waiting for health check at ${this.baseUrl} ...`);
            await this.waitForHealth(15000);
            this._outputChannel.appendLine(`MiMoCode server started successfully at ${this.baseUrl}`);
            this.setState(ServerState.Running);
        } catch (err) {
            this._outputChannel.appendLine(`Failed to start server: ${err}`);
            this._outputChannel.appendLine('Tip: Open the "MiMoCode Server" output channel (View → Output → MiMoCode Server) to see server logs.');
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
        this._actualPort = config.port;
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
        throw new Error(
            `Health check timeout after ${timeoutMs / 1000}s for ${this.baseUrl}. ` +
            'Open the "MiMoCode Server" output channel (View → Output → MiMoCode Server) to inspect server logs.'
        );
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
