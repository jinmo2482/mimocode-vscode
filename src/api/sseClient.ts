import * as vscode from 'vscode';
import * as http from 'http';

export type SseConnectionState = 'disconnected' | 'connecting' | 'connected' | 'retrying' | 'error';

export interface SseEvent {
    type: string;
    properties: Record<string, any>;
}

export class SseClient implements vscode.Disposable {
    private _onEvent = new vscode.EventEmitter<SseEvent>();
    private _onStateChange = new vscode.EventEmitter<SseConnectionState>();
    private _connected = false;
    private _state: SseConnectionState = 'disconnected';
    private _reconnectTimer: NodeJS.Timeout | null = null;
    private _reconnectDelay = 1000;
    private _maxReconnectDelay = 30000;
    private _baseUrl = '';
    private _request: http.ClientRequest | null = null;

    readonly onEvent = this._onEvent.event;
    readonly onStateChange = this._onStateChange.event;

    get connected(): boolean { return this._connected; }
    get state(): SseConnectionState { return this._state; }

    connect(baseUrl: string): void {
        this.disconnect();
        this._baseUrl = baseUrl;
        this._reconnectDelay = 1000;
        this.streamLoop();
    }

    disconnect(): void {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._request) {
            this._request.destroy();
            this._request = null;
        }
        this._connected = false;
        this.setState('disconnected');
    }

    private streamLoop(): void {
        if (!this._baseUrl) {
            return;
        }

        this.setState(this._connected ? 'retrying' : 'connecting');
        const url = `${this._baseUrl}/event`;

        this._request = http.get(url, (res) => {
            if (res.statusCode !== 200) {
                this._connected = false;
                this.scheduleReconnect();
                return;
            }

            this._connected = true;
            this._reconnectDelay = 1000;
            this.setState('connected');

            let buffer = '';

            res.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                const frames = buffer.split('\n\n');
                buffer = frames.pop() || '';

                for (const frame of frames) {
                    this.handleFrame(frame);
                }
            });

            res.on('end', () => {
                this._connected = false;
                this.scheduleReconnect();
            });

            res.on('error', () => {
                this._connected = false;
                this.scheduleReconnect();
            });
        });

        this._request.on('error', () => {
            this._connected = false;
            this.setState('error');
            this.scheduleReconnect();
        });

        this._request.setTimeout(0);
    }

    private handleFrame(frame: string): void {
        const dataLines = frame
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart());

        if (dataLines.length === 0) {
            return;
        }

        const data = dataLines.join('\n').trim();
        if (!data) {
            return;
        }

        try {
            const event = JSON.parse(data) as SseEvent;
            if (event?.type && event.properties) {
                this._onEvent.fire(event);
            }
        } catch {
            // Ignore malformed frames; the next server event should restore state.
        }
    }

    private scheduleReconnect(): void {
        if (this._reconnectTimer || !this._baseUrl) {
            return;
        }

        this.setState('retrying');
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.streamLoop();
        }, this._reconnectDelay);

        this._reconnectDelay = Math.min(
            this._reconnectDelay * 2,
            this._maxReconnectDelay
        );
    }

    private setState(state: SseConnectionState): void {
        if (this._state === state) {
            return;
        }
        this._state = state;
        this._onStateChange.fire(state);
    }

    dispose(): void {
        this.disconnect();
        this._onEvent.dispose();
        this._onStateChange.dispose();
    }
}
