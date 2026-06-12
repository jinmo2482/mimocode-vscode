import * as http from 'http';

export interface SessionInfo {
    id: string;
    title?: string;
    version?: string;
    projectID?: string;
    directory: string;
    parentID?: string;
    share?: { url?: string } | boolean;
    time: {
        created: number;
        updated: number;
        archived?: number;
    };
    permission?: unknown;
}

export type Session = SessionInfo;

export interface MessageBase {
    id: string;
    sessionID: string;
    agentID?: string;
    role: 'user' | 'assistant';
    time: {
        created: number;
        completed?: number;
    };
}

export interface UserMessageInfo extends MessageBase {
    role: 'user';
    agent: string;
    model?: {
        providerID: string;
        modelID: string;
        variant?: string;
    };
    summary?: {
        title?: string;
        body?: string;
        diffs?: FileDiff[];
    };
}

export interface AssistantMessageInfo extends MessageBase {
    role: 'assistant';
    parentID?: string;
    modelID?: string;
    providerID?: string;
    mode?: string;
    agent?: string;
    path?: {
        cwd: string;
        root: string;
    };
    summary?: boolean;
    cost?: number;
    tokens?: TokenUsage;
    structured?: unknown;
    variant?: string;
    finish?: string;
    error?: NamedApiError;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

export interface TokenUsage {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: {
        read: number;
        write: number;
    };
}

export interface NamedApiError {
    name: string;
    data?: Record<string, unknown>;
    message?: string;
}

interface PartBase {
    id: string;
    sessionID: string;
    messageID: string;
}

export interface TextPart extends PartBase {
    type: 'text';
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
    time?: {
        start: number;
        end?: number;
    };
    metadata?: Record<string, unknown>;
}

export interface ReasoningPart extends PartBase {
    type: 'reasoning';
    text: string;
    metadata?: Record<string, unknown>;
    time?: {
        start: number;
        end?: number;
    };
}

export type ToolStateStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ToolState {
    status: ToolStateStatus;
    input?: Record<string, unknown>;
    raw?: string;
    title?: string;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    time?: {
        start: number;
        end?: number;
        compacted?: number;
    };
    attachments?: FilePart[];
}

export interface ToolPart extends PartBase {
    type: 'tool';
    callID: string;
    tool: string;
    state: ToolState;
    metadata?: Record<string, unknown>;
}

export interface StepStartPart extends PartBase {
    type: 'step-start';
    snapshot?: string;
}

export interface StepFinishPart extends PartBase {
    type: 'step-finish';
    reason: string;
    snapshot?: string;
    cost?: number;
    tokens?: TokenUsage;
}

export interface PatchPart extends PartBase {
    type: 'patch';
    hash: string;
    files: string[];
}

export interface SnapshotPart extends PartBase {
    type: 'snapshot';
    snapshot: string;
}

export interface FilePart extends PartBase {
    type: 'file';
    mime: string;
    filename?: string;
    url: string;
    source?: unknown;
}

export interface AgentPart extends PartBase {
    type: 'agent';
    name: string;
    source?: {
        value: string;
        start: number;
        end: number;
    };
}

export interface SubtaskPart extends PartBase {
    type: 'subtask';
    prompt: string;
    description: string;
    agent: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    command?: string;
}

export interface RetryPart extends PartBase {
    type: 'retry';
    attempt: number;
    error: NamedApiError;
    time: {
        created: number;
    };
}

export interface CheckpointPart extends PartBase {
    type: 'checkpoint';
    checkpointDir: string;
    checkpointNumber: number;
    coveredUpTo: string;
}

export interface CompactionPart extends PartBase {
    type: 'compaction';
    auto: boolean;
    overflow?: boolean;
    tail_start_id?: string;
}

export type KnownMessagePart =
    | TextPart
    | ReasoningPart
    | ToolPart
    | StepStartPart
    | StepFinishPart
    | PatchPart
    | SnapshotPart
    | FilePart
    | AgentPart
    | SubtaskPart
    | RetryPart
    | CheckpointPart
    | CompactionPart;

export type MessagePart = KnownMessagePart | (PartBase & { type: string; [key: string]: unknown });

export interface MessageWithParts {
    info: MessageInfo;
    parts: MessagePart[];
}

export interface ProviderModel {
    id: string;
    name?: string;
    contextWindow?: number;
    [key: string]: unknown;
}

export interface ProviderInfo {
    id: string;
    name: string;
    models?: Record<string, ProviderModel> | ProviderModel[];
    env?: string[];
    [key: string]: unknown;
}

export interface ProviderListResult {
    all: ProviderInfo[];
    default?: Record<string, string> | Array<{ providerID: string; modelID: string }>;
    connected?: string[];
}

export interface ProviderAuthWhen {
    key: string;
    op: 'eq' | 'neq';
    value: string;
}

export interface ProviderAuthPromptText {
    type: 'text';
    key: string;
    message: string;
    placeholder?: string;
    when?: ProviderAuthWhen;
}

export interface ProviderAuthPromptSelectOption {
    label: string;
    value: string;
    hint?: string;
}

export interface ProviderAuthPromptSelect {
    type: 'select';
    key: string;
    message: string;
    options: ProviderAuthPromptSelectOption[];
    when?: ProviderAuthWhen;
}

export type ProviderAuthPrompt = ProviderAuthPromptText | ProviderAuthPromptSelect;

export interface ProviderAuthMethod {
    type: 'oauth' | 'api';
    label: string;
    prompts?: ProviderAuthPrompt[];
}

export type ProviderAuthMethodsResult = Record<string, ProviderAuthMethod[]>;

export interface ProviderAuthAuthorization {
    url: string;
    method: 'auto' | 'code';
    instructions: string;
}

export interface PromptOptions {
    model?: { providerID: string; modelID: string };
    modelRef?: string;
    agent?: string;
}

export interface ConfigInfo {
    model?: string;
    provider?: Record<string, unknown>;
    agent?: Record<string, unknown>;
    mode?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ContextPayload {
    currentFile?: {
        path: string;
        languageId: string;
        content: string;
    };
    selection?: {
        text: string;
        startLine: number;
        endLine: number;
    };
    openFiles?: Array<{
        path: string;
        isActive: boolean;
    }>;
    workspaceRoot?: string;
}

export interface PromptTextPartInput {
    type: 'text';
    text: string;
    id?: string;
    synthetic?: boolean;
}

export interface FileDiff {
    path?: string;
    filePath?: string;
    oldPath?: string;
    newPath?: string;
    original?: string;
    modified?: string;
    originalContent?: string;
    newContent?: string;
    hunks?: Array<{
        header?: string;
        lines?: Array<{ type?: string; content?: string; oldLine?: number; newLine?: number }> | string[];
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}

export interface SessionStatusInfo {
    type?: string;
    message?: string;
    [key: string]: unknown;
}

export class ApiError extends Error {
    constructor(
        public statusCode: number,
        public body: string,
        public method: string,
        public path: string
    ) {
        super(`API ${method} ${path} failed with ${statusCode}: ${body}`);
        this.name = 'ApiError';
    }
}

export class ApiClient {
    private timeout = 120000;

    constructor(private getBaseUrl: () => string) {}

    private async request<T>(
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path: string,
        body?: unknown,
        timeout = this.timeout
    ): Promise<T> {
        const url = `${this.getBaseUrl()}${path}`;
        const options: http.RequestOptions = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        return new Promise((resolve, reject) => {
            const req = http.request(url, options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => {
                    const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
                    if (!ok) {
                        reject(new ApiError(res.statusCode || 0, data, method, path));
                        return;
                    }

                    if (!data.trim()) {
                        resolve(undefined as T);
                        return;
                    }

                    try {
                        resolve(JSON.parse(data) as T);
                    } catch {
                        resolve(data as T);
                    }
                });
            });

            req.on('error', reject);
            if (timeout > 0) {
                req.setTimeout(timeout, () => {
                    req.destroy();
                    reject(new Error(`Request timeout: ${method} ${path}`));
                });
            }

            if (body !== undefined) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    async listSessions(opts: { directory?: string; roots?: boolean; start?: number; search?: string; limit?: number } = {}): Promise<SessionInfo[]> {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(opts)) {
            if (value !== undefined) {
                params.set(key, String(value));
            }
        }
        return this.request('GET', `/session${params.size ? `?${params.toString()}` : ''}`);
    }

    async newSession(opts?: { title?: string; directory?: string }): Promise<SessionInfo> {
        return this.request('POST', '/session', opts || {});
    }

    async getSession(sessionId: string): Promise<SessionInfo> {
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}`);
    }

    async updateSession(sessionId: string, updates: { title?: string; time?: { archived?: number } }): Promise<SessionInfo> {
        return this.request('PATCH', `/session/${encodeURIComponent(sessionId)}`, updates);
    }

    async deleteSession(sessionId: string): Promise<boolean> {
        return this.request('DELETE', `/session/${encodeURIComponent(sessionId)}`);
    }

    async getSessionStatus(): Promise<Record<string, SessionStatusInfo>> {
        return this.request('GET', '/session/status');
    }

    async getMessages(sessionId: string, opts: { agentId?: string; limit?: number; before?: string } = {}): Promise<MessageWithParts[]> {
        const params = new URLSearchParams();
        if (opts.agentId) {
            params.set('agent_id', opts.agentId);
        }
        if (opts.limit !== undefined) {
            params.set('limit', String(opts.limit));
        }
        if (opts.before) {
            params.set('before', opts.before);
        }
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}/message${params.size ? `?${params.toString()}` : ''}`);
    }

    async getMessage(sessionId: string, messageId: string): Promise<MessageWithParts> {
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`);
    }

    async sendPrompt(
        sessionId: string,
        prompt: string,
        context?: ContextPayload,
        opts: PromptOptions = {}
    ): Promise<MessageWithParts> {
        const body = {
            ...opts,
            parts: this.buildPromptParts(prompt, context)
        };
        const result = await this.request<MessageWithParts | undefined>('POST', `/session/${encodeURIComponent(sessionId)}/message`, body, 0);
        if (!result || !result.info || !Array.isArray(result.parts)) {
            throw new Error('MiMoCode returned an incomplete assistant message.');
        }
        return result;
    }

    async sendPromptAsync(
        sessionId: string,
        prompt: string,
        context?: ContextPayload,
        opts: PromptOptions = {}
    ): Promise<void> {
        const body = {
            ...opts,
            parts: this.buildPromptParts(prompt, context)
        };
        await this.request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
    }

    async abortSession(sessionId: string): Promise<boolean> {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/abort`);
    }

    async forkSession(sessionId: string, messageID?: string): Promise<SessionInfo> {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/fork`, messageID ? { messageID } : {});
    }

    async revertSession(sessionId: string, messageID: string): Promise<SessionInfo> {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/revert`, { messageID });
    }

    async getDiff(sessionId: string, messageID: string): Promise<FileDiff[]> {
        const params = new URLSearchParams({ messageID });
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}/diff?${params.toString()}`);
    }

    async getConfig(): Promise<ConfigInfo> {
        return this.request('GET', '/config');
    }

    async updateConfig(config: ConfigInfo): Promise<ConfigInfo> {
        return this.request('PATCH', '/config', config);
    }

    async updateGlobalConfig(config: ConfigInfo): Promise<ConfigInfo> {
        return this.request('PATCH', '/global/config', config);
    }

    async getProviders(): Promise<ProviderListResult> {
        return this.request('GET', '/provider');
    }

    async getProviderAuthMethods(): Promise<ProviderAuthMethodsResult> {
        return this.request('GET', '/provider/auth');
    }

    async authorizeProvider(
        providerID: string,
        input: { method: number; inputs?: Record<string, string> }
    ): Promise<ProviderAuthAuthorization | undefined> {
        return this.request('POST', `/provider/${encodeURIComponent(providerID)}/oauth/authorize`, input);
    }

    async completeProviderOAuth(
        providerID: string,
        input: { method: number; code?: string }
    ): Promise<boolean> {
        return this.request('POST', `/provider/${encodeURIComponent(providerID)}/oauth/callback`, input);
    }

    async getAgents(): Promise<Array<{ name: string; description?: string; [key: string]: unknown }>> {
        return this.request('GET', '/agent');
    }

    async getCommands(): Promise<Array<{ name: string; description?: string; [key: string]: unknown }>> {
        return this.request('GET', '/command');
    }

    async getPath(): Promise<{ home: string; state: string; config: string; worktree: string; directory: string }> {
        return this.request('GET', '/path');
    }

    async appendTuiPrompt(text: string): Promise<boolean> {
        return this.request('POST', '/tui/append-prompt', { text });
    }

    async setModel(modelRef: string): Promise<ConfigInfo> {
        const config = await this.getConfig();
        return this.updateConfig({ ...config, model: modelRef });
    }

    normalizeModels(result: ProviderListResult): Array<{ label: string; description?: string; providerID: string; modelID: string }> {
        const models: Array<{ label: string; description?: string; providerID: string; modelID: string }> = [];
        for (const provider of result.all || []) {
            const providerID = provider.id || String((provider as any).providerID || provider.name);
            const rawModels = provider.models || [];
            const entries = Array.isArray(rawModels)
                ? rawModels.map(model => [model.id, model] as const)
                : Object.entries(rawModels);
            for (const [modelID, model] of entries) {
                if (!modelID) {
                    continue;
                }
                models.push({
                    label: `${providerID}/${modelID}`,
                    description: model?.name || provider.name,
                    providerID,
                    modelID
                });
            }
        }
        return models;
    }

    private buildPromptParts(prompt: string, context?: ContextPayload): PromptTextPartInput[] {
        const parts: PromptTextPartInput[] = [{ type: 'text', text: prompt }];
        if (context?.selection && context.currentFile) {
            const startLine = context.selection.startLine + 1;
            const endLine = context.selection.endLine + 1;
            parts.push({
                type: 'text',
                text: `\n\nSelection from @${context.currentFile.path}#L${startLine}-${endLine}:\n\`\`\`${context.currentFile.languageId}\n${context.selection.text}\n\`\`\``,
                synthetic: true
            });
        } else if (context?.currentFile) {
            parts.push({
                type: 'text',
                text: `\n\nCurrent file: @${context.currentFile.path}`,
                synthetic: true
            });
        }
        return parts;
    }
}
