import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';

export interface ServerConfig {
    port: number;
    mimoPath: string;
    autoStart: boolean;
    cwd?: string;
    instanceId?: string;
}

export enum ServerState {
    Stopped = 'stopped',
    Starting = 'starting',
    Running = 'running',
    Error = 'error'
}

interface PathInfo {
    directory?: string;
    worktree?: string;
    home?: string;
    state?: string;
    config?: string;
}

export class ServerManager implements vscode.Disposable {
    private process: ChildProcess | null = null;
    private _state = ServerState.Stopped;
    private _port: number;
    private _actualPort: number;
    private _mimoPath: string;
    private _autoStart: boolean;
    private _cwd?: string;
    private _instanceId: string;
    private _ownsProcess = false;
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
        this._cwd = config.cwd;
        this._instanceId = config.instanceId || crypto.randomUUID();
        this._outputChannel = vscode.window.createOutputChannel('MiMoCode Server');
    }

    async start(): Promise<void> {
        if (this._state === ServerState.Running || this._state === ServerState.Starting) {
            return;
        }

        this.setState(ServerState.Starting);

        this._actualPort = this._port;

        const cwd = this._cwd || process.cwd();

        this._outputChannel.appendLine(`MiMoCode Server instance: ${this._instanceId}`);
        this._outputChannel.appendLine(`Configured port: ${this._port}`);
        this._outputChannel.appendLine(`Server cwd: ${cwd}`);

        if (this._port === 0) {
            // port=0: spawn isolated server, no health check, no reuse
            this._outputChannel.appendLine(`Mode: spawn isolated server`);
            await this.spawnServer(cwd);
            return;
        }

        // Fixed port mode: check if a server is already running
        this._outputChannel.appendLine(`Mode: reuse fixed-port server`);

        const isRunning = await this.checkHealth();

        if (isRunning) {
            const existingPath = await this.getServerPath();
            this._outputChannel.appendLine(`Existing server /path response: ${JSON.stringify(existingPath)}`);

            if (this._cwd && existingPath?.directory && normalizePath(existingPath.directory) !== normalizePath(this._cwd)) {
                const msg = `Existing MiMoCode server directory mismatch. expected: ${this._cwd}, actual: ${existingPath.directory}`;
                this._outputChannel.appendLine(`WARNING: ${msg}`);
                this.setState(ServerState.Error);
                throw new Error(
                    `MiMoCode server already running on configured port, but its directory does not match current workspace. ` +
                    `Close the old server or set mimocode.server.port to 0. (expected: ${this._cwd}, actual: ${existingPath.directory})`
                );
            }

            if (this._cwd && !existingPath?.directory) {
                const msg = 'Existing MiMoCode server /path did not return directory. Reuse is unsafe.';
                this._outputChannel.appendLine(`WARNING: ${msg}`);
                this.setState(ServerState.Error);
                throw new Error(
                    'Existing MiMoCode server cannot be verified. Close the old server or set mimocode.server.port to 0.'
                );
            }

            this._outputChannel.appendLine(`Connected to existing MiMoCode server at ${this.baseUrl}`);
            this._ownsProcess = false;
            this.setState(ServerState.Running);
            return;
        }

        // No server running on the fixed port, spawn a new one
        await this.spawnServer(cwd);
    }

    /**
     * Spawn a new mimo serve process.
     * Handles port=0 port resolution, health check, and lock file.
     */
    private async spawnServer(cwd: string): Promise<void> {
        const args = ['serve', '--hostname', '127.0.0.1', '--port', String(this._port)];
        const commandLine = `${this._mimoPath} ${args.join(' ')}`;
        this._outputChannel.appendLine(`Starting MiMoCode server: ${commandLine}`);

        try {
            this.process = spawn(this._mimoPath, args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    OPENCODE_CALLER: 'vscode',
                    MIMOCODE_CALLER: 'vscode'
                }
            });

            this._ownsProcess = true;

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
                if (portResolve) { portResolve(); portResolve = undefined; }
            });

            this.process.on('exit', (code) => {
                this._outputChannel.appendLine(`Server exited with code ${code}`);
                this.process = null;
                this._ownsProcess = false;
                if (this._state !== ServerState.Stopped) {
                    this.setState(ServerState.Stopped);
                }
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

            // Write lock file for self-spawned servers
            this.writeLockFile(cwd);
        } catch (err) {
            this._outputChannel.appendLine(`Failed to start server: ${err}`);
            this._outputChannel.appendLine('Tip: Open the "MiMoCode Server" output channel (View → Output → MiMoCode Server) to see server logs.');
            await this.killProcess();
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
                this._ownsProcess = false;
                this.removeLockFile();
                this.setState(ServerState.Stopped);
                resolve();
            });

            proc?.kill('SIGTERM');
        });
    }

    /**
     * Safely terminate a spawned server process.
     * Sends SIGTERM first, waits up to 3 seconds, then escalates to SIGKILL.
     * Clears this.process on exit. Used only during start() failure cleanup;
     * does not touch ServerState (caller is responsible).
     */
    private killProcess(): Promise<void> {
        const proc = this.process;
        if (!proc) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) {
                    return;
                }
                settled = true;
                this.process = null;
                this._ownsProcess = false;
                this.removeLockFile();
                resolve();
            };

            proc.on('exit', done);

            proc.kill('SIGTERM');

            setTimeout(() => {
                if (!settled && proc.exitCode === null) {
                    proc.kill('SIGKILL');
                }
                // Give SIGKILL a moment, then resolve regardless
                setTimeout(done, 500);
            }, 3000);
        });
    }

    updateConfig(config: ServerConfig): void {
        this._port = config.port;
        this._actualPort = config.port;
        this._mimoPath = config.mimoPath;
        this._autoStart = config.autoStart;
        this._cwd = config.cwd;
        if (config.instanceId) {
            this._instanceId = config.instanceId;
        }
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

    /**
     * Query an existing server's /path endpoint to verify its workspace directory.
     * Returns undefined on any failure.
     */
    private getServerPath(): Promise<PathInfo | undefined> {
        return new Promise(resolve => {
            const req = http.get(`${this.baseUrl}/path`, res => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        resolve(undefined);
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(undefined);
                    }
                });
            });
            req.on('error', () => resolve(undefined));
            req.setTimeout(1000, () => {
                req.destroy();
                resolve(undefined);
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

    // --- Lock file helpers ---

    private getLockDir(): string | undefined {
        const home = process.env.HOME || process.env.USERPROFILE;
        if (!home || !this._cwd) return undefined;
        const hash = crypto.createHash('sha256').update(this._cwd).digest('hex').slice(0, 16);
        return path.join(home, '.mimocode', 'ide', hash);
    }

    private writeLockFile(cwd: string): void {
        try {
            const dir = this.getLockDir();
            if (!dir) return;
            fs.mkdirSync(dir, { recursive: true });
            const lockData = {
                instanceId: this._instanceId,
                workspaceRoot: this._cwd,
                cwd,
                pid: this.process?.pid,
                port: this._actualPort,
                baseUrl: this.baseUrl,
                startedAt: Date.now()
            };
            fs.writeFileSync(path.join(dir, `${this._instanceId}.json`), JSON.stringify(lockData, null, 2));
        } catch {
            // Best effort, don't fail startup
        }
    }

    private removeLockFile(): void {
        try {
            const dir = this.getLockDir();
            if (!dir) return;
            const lockPath = path.join(dir, `${this._instanceId}.json`);
            if (fs.existsSync(lockPath)) {
                fs.unlinkSync(lockPath);
            }
        } catch {
            // Best effort
        }
    }

    dispose(): void {
        void this.stop();
        this._onStateChange.dispose();
        this._outputChannel.dispose();
    }
}

function normalizePath(input?: string): string | undefined {
    if (!input) return undefined;
    return path.resolve(input);
}
