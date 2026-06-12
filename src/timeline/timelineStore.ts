import { EventEmitter } from 'vscode';
import { FileDiff, MessageInfo, MessagePart, MessageWithParts, SessionInfo, SessionStatusInfo } from '../api/client';
import { SseEvent } from '../api/sseClient';

export interface TimelineMessage {
    info: MessageInfo;
    parts: MessagePart[];
}

export interface TimelineError {
    id: string;
    sessionID?: string;
    message: string;
    error?: unknown;
    time: number;
}

export interface TimelineDiff {
    id: string;
    sessionID: string;
    messageID?: string;
    files: FileDiff[];
    time: number;
}

export interface TimelineSnapshot {
    session?: SessionInfo;
    status?: SessionStatusInfo;
    messages: TimelineMessage[];
    diffs: TimelineDiff[];
    errors: TimelineError[];
}

export type TimelinePatchKind = 'reset' | 'message' | 'part' | 'part-removed' | 'diff' | 'error' | 'session' | 'status';

export interface TimelinePatch {
    kind: TimelinePatchKind;
    snapshot?: TimelineSnapshot;
    message?: TimelineMessage;
    part?: MessagePart;
    messageID?: string;
    partID?: string;
    diff?: TimelineDiff;
    error?: TimelineError;
    session?: SessionInfo;
    status?: SessionStatusInfo;
}

export class TimelineStore {
    private _session?: SessionInfo;
    private _status?: SessionStatusInfo;
    private _messages = new Map<string, TimelineMessage>();
    private _diffs = new Map<string, TimelineDiff>();
    private _errors: TimelineError[] = [];
    private _onPatch = new EventEmitter<TimelinePatch>();

    readonly onPatch = this._onPatch.event;

    reset(session?: SessionInfo, messages: MessageWithParts[] = [], status?: SessionStatusInfo): TimelineSnapshot {
        this._session = session;
        this._status = status;
        this._messages.clear();
        this._diffs.clear();
        this._errors = [];

        for (const message of messages) {
            this.upsertMessage(message.info, message.parts, false);
        }

        const snapshot = this.snapshot();
        this._onPatch.fire({ kind: 'reset', snapshot });
        return snapshot;
    }

    snapshot(): TimelineSnapshot {
        return {
            session: this._session,
            status: this._status,
            messages: Array.from(this._messages.values()).sort((a, b) => {
                return (a.info.time?.created || 0) - (b.info.time?.created || 0);
            }).map(message => ({ ...message, parts: [...message.parts] })),
            diffs: Array.from(this._diffs.values()).sort((a, b) => a.time - b.time),
            errors: [...this._errors]
        };
    }

    setSession(session: SessionInfo): void {
        this._session = session;
        this._onPatch.fire({ kind: 'session', session });
    }

    setStatus(status?: SessionStatusInfo): void {
        this._status = status;
        this._onPatch.fire({ kind: 'status', status });
    }

    applyEvent(event: SseEvent): TimelinePatch | undefined {
        switch (event.type) {
            case 'session.created':
            case 'session.updated': {
                const info = event.properties.info as SessionInfo | undefined;
                if (!info) {
                    return undefined;
                }
                this._session = info;
                const patch: TimelinePatch = { kind: 'session', session: info };
                this._onPatch.fire(patch);
                return patch;
            }
            case 'session.status': {
                const status = event.properties.status as SessionStatusInfo | undefined;
                if (!status) {
                    return undefined;
                }
                this._status = status;
                const patch: TimelinePatch = { kind: 'status', status };
                this._onPatch.fire(patch);
                return patch;
            }
            case 'message.updated': {
                const info = event.properties.info as MessageInfo | undefined;
                if (!info) {
                    return undefined;
                }
                const message = this.upsertMessage(info);
                const patch: TimelinePatch = { kind: 'message', message };
                this._onPatch.fire(patch);
                return patch;
            }
            case 'message.removed': {
                const messageID = event.properties.messageID as string | undefined;
                if (!messageID) {
                    return undefined;
                }
                this._messages.delete(messageID);
                const patch: TimelinePatch = { kind: 'message', messageID };
                this._onPatch.fire(patch);
                return patch;
            }
            case 'message.part.updated': {
                const part = event.properties.part as MessagePart | undefined;
                if (!part) {
                    return undefined;
                }
                this.upsertPart(part);
                const patch: TimelinePatch = { kind: 'part', part, messageID: part.messageID };
                this._onPatch.fire(patch);
                return patch;
            }
            case 'message.part.delta': {
                const part = this.applyPartDelta(
                    event.properties.messageID as string | undefined,
                    event.properties.partID as string | undefined,
                    event.properties.field as string | undefined,
                    event.properties.delta as string | undefined,
                    event.properties.sessionID as string | undefined
                );
                if (!part) {
                    return undefined;
                }
                const patch: TimelinePatch = { kind: 'part', part, messageID: part.messageID };
                this._onPatch.fire(patch);
                return patch;
            }
            case 'message.part.removed': {
                const messageID = event.properties.messageID as string | undefined;
                const partID = event.properties.partID as string | undefined;
                if (!messageID || !partID) {
                    return undefined;
                }
                const message = this._messages.get(messageID);
                if (message) {
                    message.parts = message.parts.filter(part => part.id !== partID);
                }
                const patch: TimelinePatch = { kind: 'part-removed', messageID, partID };
                this._onPatch.fire(patch);
                return patch;
            }
            case 'session.diff': {
                const sessionID = event.properties.sessionID as string | undefined;
                const diff = (event.properties.diff || event.properties.diffs) as FileDiff[] | undefined;
                if (!sessionID || !diff) {
                    return undefined;
                }
                const timelineDiff = this.addDiff(sessionID, diff, event.properties.messageID as string | undefined);
                const patch: TimelinePatch = { kind: 'diff', diff: timelineDiff };
                this._onPatch.fire(patch);
                return patch;
            }
            case 'session.error': {
                const error = this.addError({
                    sessionID: event.properties.sessionID as string | undefined,
                    message: errorToMessage(event.properties.error),
                    error: event.properties.error
                });
                const patch: TimelinePatch = { kind: 'error', error };
                this._onPatch.fire(patch);
                return patch;
            }
            default:
                return undefined;
        }
    }

    addDiff(sessionID: string, files: FileDiff[], messageID?: string): TimelineDiff {
        const id = `${sessionID}:${messageID || 'diff'}:${Date.now()}:${this._diffs.size}`;
        const diff: TimelineDiff = {
            id,
            sessionID,
            messageID,
            files,
            time: Date.now()
        };
        this._diffs.set(id, diff);
        return diff;
    }

    addError(input: { sessionID?: string; message: string; error?: unknown }): TimelineError {
        const error: TimelineError = {
            id: `error_${Date.now()}_${this._errors.length}`,
            sessionID: input.sessionID,
            message: input.message,
            error: input.error,
            time: Date.now()
        };
        this._errors.push(error);
        return error;
    }

    mergeMessage(message: MessageWithParts): TimelineMessage {
        const next = this.upsertMessage(message.info, message.parts, false);
        this._onPatch.fire({ kind: 'message', message: next });
        return next;
    }

    private upsertMessage(info: MessageInfo, parts?: MessagePart[], fire = true): TimelineMessage {
        const existing = this._messages.get(info.id);
        const message: TimelineMessage = {
            info,
            parts: parts ? [...parts] : existing?.parts || []
        };
        this._messages.set(info.id, message);
        if (fire) {
            this._onPatch.fire({ kind: 'message', message });
        }
        return message;
    }

    private upsertPart(part: MessagePart): void {
        let message = this._messages.get(part.messageID);
        if (!message) {
            message = {
                info: {
                    id: part.messageID,
                    sessionID: part.sessionID,
                    role: 'assistant',
                    time: { created: Date.now() }
                },
                parts: []
            } as TimelineMessage;
            this._messages.set(part.messageID, message);
        }

        const index = message.parts.findIndex(existing => existing.id === part.id);
        if (index >= 0) {
            message.parts[index] = part;
        } else {
            message.parts.push(part);
        }
    }

    private applyPartDelta(messageID?: string, partID?: string, field?: string, delta?: string, sessionID?: string): MessagePart | undefined {
        if (!messageID || !partID || !field || delta === undefined) {
            return undefined;
        }

        let message = this._messages.get(messageID);
        if (!message) {
            message = {
                info: {
                    id: messageID,
                    sessionID: sessionID || this._session?.id || '',
                    role: 'assistant',
                    time: { created: Date.now() }
                },
                parts: []
            } as TimelineMessage;
            this._messages.set(messageID, message);
        }

        let part = message.parts.find(existing => existing.id === partID) as any;
        if (!part) {
            part = {
                id: partID,
                sessionID: sessionID || message.info.sessionID,
                messageID,
                type: field === 'text' ? 'text' : 'reasoning',
                [field]: ''
            };
            message.parts.push(part as MessagePart);
        }

        if (typeof part[field] === 'string') {
            part[field] += delta;
        } else {
            part[field] = delta;
        }

        return part as MessagePart;
    }

    dispose(): void {
        this._onPatch.dispose();
    }
}

function errorToMessage(error: unknown): string {
    if (!error) {
        return 'MiMoCode reported an unknown error.';
    }
    if (typeof error === 'string') {
        return error;
    }
    if (typeof error === 'object') {
        const obj = error as any;
        return obj.message || obj.data?.message || obj.name || JSON.stringify(obj);
    }
    return String(error);
}
