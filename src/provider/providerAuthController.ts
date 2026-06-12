import * as vscode from 'vscode';
import {
    ApiClient,
    ProviderAuthMethod,
    ProviderAuthMethodsResult,
    ProviderAuthPrompt,
    ProviderInfo,
    ProviderListResult
} from '../api/client';

interface ProviderPickItem extends vscode.QuickPickItem {
    providerID: string;
}

interface MethodPickItem extends vscode.QuickPickItem {
    methodIndex: number;
}

// Provider-specific guidance messages (from CLI providers.ts)
const PROVIDER_GUIDANCE: Record<string, string> = {
    'amazon-bedrock':
        'Amazon Bedrock authentication priority:\n' +
        '  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK)\n' +
        '  2. AWS credential chain (profile, access keys, IAM roles)\n\n' +
        'Configure via AWS environment variables: AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID',
    'opencode': 'Create an API key at https://opencode.ai/auth',
    'vercel': 'You can create an API key at https://vercel.link/ai-gateway-token',
    'cloudflare':
        'Cloudflare AI Gateway can be configured with:\n' +
        '  CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN',
    'cloudflare-ai-gateway':
        'Cloudflare AI Gateway can be configured with:\n' +
        '  CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN',
};

const MAX_OAUTH_RETRIES = 3;

export class ProviderAuthController {
    constructor(private readonly _apiClient: ApiClient) {}

    /**
     * Main entry: Sign In to Provider.
     * Flow: MiMo / MiMo Auto (free) / Other providers triage, then auth.
     */
    async signIn(): Promise<ProviderListResult | undefined> {
        let providers: ProviderListResult;
        let authMethods: ProviderAuthMethodsResult;
        try {
            [providers, authMethods] = await Promise.all([
                this._apiClient.getProviders(),
                this._apiClient.getProviderAuthMethods()
            ]);
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to load providers: ${err instanceof Error ? err.message : String(err)}`
            );
            return;
        }

        const connected = new Set(providers.connected || []);

        // Triage: MiMo / MiMo Auto (free) / Other (like CLI)
        const hasXiaomi = authMethods['xiaomi'] && authMethods['xiaomi'].length > 0;
        const hasMimoFree = authMethods['mimo-free'] && authMethods['mimo-free'].length > 0;

        const topChoices: vscode.QuickPickItem[] = [];
        if (hasXiaomi) {
            topChoices.push({ label: 'MiMo', description: 'recommended', detail: 'Sign in with your MiMo account' });
        }
        if (hasMimoFree) {
            topChoices.push({ label: 'MiMo Auto (free)', description: 'free tier', detail: 'Free MiMo access with fingerprint verification' });
        }
        topChoices.push({ label: 'Other providers', description: '', detail: 'OpenAI, Anthropic, Google, and more' });
        topChoices.push({ label: 'Custom Provider', description: 'create new', detail: 'Add a custom OpenAI-compatible provider' });
        topChoices.push({ label: 'Custom URL', description: 'well-known auth', detail: 'Connect to a custom MiMoCode server via URL' });

        const choice = await vscode.window.showQuickPick(topChoices, {
            placeHolder: 'Select a provider to sign in',
            title: 'MiMoCode: Sign In'
        });
        if (!choice) {
            return;
        }

        if (choice.label === 'MiMo' && hasXiaomi) {
            await this.runAuthFlow('xiaomi', 'MiMo', authMethods['xiaomi'], { isMiMo: true });
        } else if (choice.label.startsWith('MiMo Auto') && hasMimoFree) {
            await this.runMimoFreeFlow();
        } else if (choice.label === 'Custom Provider') {
            await this.runCustomProviderWizard();
        } else if (choice.label === 'Custom URL') {
            await this.runWellKnownAuth();
        } else {
            // Show full provider list with search
            await this.showOtherProviders(providers, authMethods, connected);
        }

        // Refresh providers after login
        try {
            return await this._apiClient.getProviders();
        } catch {
            return undefined;
        }
    }

    /**
     * View providers: show connected status, credential type, env vars, default model.
     */
    async viewProviders(): Promise<void> {
        let providers: ProviderListResult;
        try {
            providers = await this._apiClient.getProviders();
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to load providers: ${err instanceof Error ? err.message : String(err)}`
            );
            return;
        }

        const connected = new Set(providers.connected || []);
        const defaultMap = this.resolveDefaultMap(providers.default);

        // Detect active env vars
        const activeEnvVars: Array<{ provider: string; envVar: string }> = [];
        for (const p of providers.all || []) {
            if (p.env) {
                for (const envVar of p.env) {
                    if (process.env[envVar]) {
                        activeEnvVars.push({ provider: p.name || p.id, envVar });
                    }
                }
            }
        }

        // Connected providers
        const connectedItems: vscode.QuickPickItem[] = (providers.all || [])
            .filter(p => connected.has(p.id))
            .map(p => {
                const defaultModel = defaultMap.get(p.id);
                const modelCount = this.countModels(p);
                return {
                    label: `$(check) ${p.name || p.id}`,
                    description: defaultModel ? `default: ${defaultModel}` : '',
                    detail: modelCount > 0 ? `${modelCount} models` : undefined
                };
            });

        // Env var items
        const envItems: vscode.QuickPickItem[] = activeEnvVars.map(e => ({
            label: `$(symbol-key) ${e.provider}`,
            description: e.envVar,
            detail: 'Active environment variable'
        }));

        // Separator
        const items: vscode.QuickPickItem[] = [];
        if (connectedItems.length > 0) {
            items.push({ label: 'Connected Providers', kind: vscode.QuickPickItemKind.Separator });
            items.push(...connectedItems);
        }
        if (envItems.length > 0) {
            items.push({ label: 'Environment Variables', kind: vscode.QuickPickItemKind.Separator });
            items.push(...envItems);
        }
        if (items.length === 0) {
            items.push({
                label: 'No providers connected',
                description: 'Run "MiMoCode: Sign In to Provider" to connect'
            });
        }

        await vscode.window.showQuickPick(items, {
            placeHolder: `${connectedItems.length} connected, ${envItems.length} env var(s)`,
            title: 'MiMoCode: Providers'
        });
    }

    /**
     * Whoami: show current logged-in user info for MiMo (xiaomi).
     */
    async whoami(): Promise<void> {
        let providers: ProviderListResult;
        try {
            providers = await this._apiClient.getProviders();
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to load providers: ${err instanceof Error ? err.message : String(err)}`
            );
            return;
        }

        const connected = new Set(providers.connected || []);
        if (!connected.has('xiaomi')) {
            vscode.window.showWarningMessage('Not logged in to MiMo. Run "MiMoCode: Sign In to Provider" first.');
            return;
        }

        const xiaomi = (providers.all || []).find(p => p.id === 'xiaomi');
        const name = xiaomi?.name || 'MiMo';
        vscode.window.showInformationMessage(
            `Provider: ${name}\nStatus: Connected`,
            { modal: true }
        );
    }

    /**
     * Refresh provider status: re-fetch and notify.
     */
    async refreshProviders(): Promise<ProviderListResult> {
        const providers = await this._apiClient.getProviders();
        const count = (providers.connected || []).length;
        vscode.window.showInformationMessage(
            `MiMoCode providers refreshed. ${count} connected.`
        );
        return providers;
    }

    // ---- MiMo Auto (free) flow ----

    private async runMimoFreeFlow(): Promise<void> {
        // MiMo Auto (free) goes through the generic auth flow via the API
        // The server handles the MimoFree.verify() internally
        let authMethods: ProviderAuthMethodsResult;
        try {
            authMethods = await this._apiClient.getProviderAuthMethods();
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to load auth methods: ${err instanceof Error ? err.message : String(err)}`
            );
            return;
        }
        const methods = authMethods['mimo-free'];
        if (!methods || methods.length === 0) {
            vscode.window.showWarningMessage('No auth methods available for MiMo Auto (free).');
            return;
        }
        await this.runAuthFlow('mimo-free', 'MiMo Auto (free)', methods);
    }

    // ---- Custom provider wizard (6 steps, aligned with CLI TUI) ----

    private async runCustomProviderWizard(): Promise<void> {
        // Step 1: Provider ID
        const providerID = await vscode.window.showInputBox({
            prompt: 'Step 1/6: Provider ID',
            title: 'Custom Provider',
            placeHolder: 'e.g. my-llm',
            validateInput: v => {
                if (!v || !v.trim()) { return 'Provider ID is required'; }
                if (!/^[0-9a-z-]+$/.test(v.trim())) { return 'Only lowercase letters, numbers, and hyphens allowed'; }
                return undefined;
            }
        });
        if (!providerID) { return; }

        // Step 2: Display name
        const name = await vscode.window.showInputBox({
            prompt: 'Step 2/6: Display name',
            title: 'Custom Provider',
            placeHolder: 'e.g. My Company LLM',
            value: providerID
        });
        if (name === undefined) { return; }

        // Step 3: Base URL
        const baseURL = await vscode.window.showInputBox({
            prompt: 'Step 3/6: API Base URL',
            title: 'Custom Provider',
            placeHolder: 'https://.../v1',
            validateInput: v => {
                if (!v || !v.trim()) { return 'Base URL is required'; }
                try { new URL(v.trim()); } catch { return 'Invalid URL'; }
                return undefined;
            }
        });
        if (!baseURL) { return; }

        // Step 4: API key
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Step 4/6: API key',
            title: 'Custom Provider',
            placeHolder: 'sk-...',
            password: true,
            validateInput: v => (v && v.trim().length > 0 ? undefined : 'API key is required')
        });
        if (!apiKey) { return; }

        // Step 5: Model ID
        const modelID = await vscode.window.showInputBox({
            prompt: 'Step 5/6: First model ID',
            title: 'Custom Provider',
            placeHolder: 'e.g. claude-sonnet-4-6',
            validateInput: v => (v && v.trim().length > 0 ? undefined : 'Model ID is required')
        });
        if (!modelID) { return; }

        // Step 6: Model name
        const modelName = await vscode.window.showInputBox({
            prompt: 'Step 6/6: Model display name',
            title: 'Custom Provider',
            placeHolder: 'e.g. Claude Sonnet 4.6',
            value: modelID
        });
        if (modelName === undefined) { return; }

        // Build provider config (same structure as TUI wizard)
        const envKey = `${providerID.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
        const patch = {
            provider: {
                [providerID]: {
                    name: name.trim() || providerID,
                    npm: '@ai-sdk/openai-compatible',
                    env: [envKey],
                    options: {
                        baseURL: baseURL.trim(),
                        apiKey: apiKey.trim(),
                        setCacheKey: true
                    },
                    models: {
                        [modelID.trim()]: {
                            name: modelName.trim() || modelID.trim()
                        }
                    }
                }
            }
        };

        try {
            await this._apiClient.updateGlobalConfig(patch as any);
            vscode.window.showInformationMessage(
                `Custom provider "${name.trim() || providerID}" created successfully. ` +
                `Environment variable: ${envKey}`
            );
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to create custom provider: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    // ---- Well-known URL auth ----

    private async runWellKnownAuth(): Promise<void> {
        const url = await vscode.window.showInputBox({
            prompt: 'Enter the MiMoCode server URL',
            title: 'MiMoCode: Custom URL',
            placeHolder: 'https://example.com',
            validateInput: v => {
                if (!v || !v.trim()) { return 'URL is required'; }
                try { new URL(v.trim()); } catch { return 'Invalid URL'; }
                return undefined;
            }
        });
        if (!url) {
            return;
        }

        const cleanUrl = url.trim().replace(/\/+$/, '');
        const wellKnownUrl = `${cleanUrl}/.well-known/opencode`;

        try {
            const response = await fetch(wellKnownUrl);
            if (!response.ok) {
                vscode.window.showErrorMessage(`Failed to fetch well-known config from ${wellKnownUrl} (${response.status})`);
                return;
            }
            const data = await response.json() as {
                auth?: { command?: string[]; env?: string }
            };

            if (!data.auth?.command || data.auth.command.length === 0) {
                vscode.window.showErrorMessage('No auth command found in well-known config.');
                return;
            }

            const command = data.auth.command.join(' ');
            const envKey = data.auth.env || '';

            // Show instructions to the user
            const action = await vscode.window.showInformationMessage(
                `Run the following command to authenticate:\n\n${command}` +
                (envKey ? `\n\nThen set environment variable: ${envKey}` : ''),
                { modal: true },
                'Copy Command',
                'Done'
            );

            if (action === 'Copy Command') {
                await vscode.env.clipboard.writeText(command);
                vscode.window.showInformationMessage('Command copied to clipboard.');
            }
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to connect to ${cleanUrl}: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    // ---- Other providers list ----

    private async showOtherProviders(
        providers: ProviderListResult,
        authMethods: ProviderAuthMethodsResult,
        connected: Set<string>
    ): Promise<void> {
        const providerItems = this.buildProviderPickItems(providers, authMethods, connected);
        if (providerItems.length === 0) {
            vscode.window.showWarningMessage('No providers available for sign-in.');
            return;
        }

        const picked = await vscode.window.showQuickPick(providerItems, {
            placeHolder: 'Search and select a provider',
            title: 'MiMoCode: Sign In to Other Provider'
        });
        if (!picked) {
            return;
        }

        const methods = authMethods[picked.providerID];
        if (!methods || methods.length === 0) {
            vscode.window.showWarningMessage(`No auth methods available for ${picked.label}.`);
            return;
        }

        // Show provider-specific guidance
        const guidance = PROVIDER_GUIDANCE[picked.providerID];
        if (guidance) {
            vscode.window.showInformationMessage(guidance, { modal: false });
        }

        await this.runAuthFlow(picked.providerID, picked.label, methods);
    }

    // ---- Core auth flow ----

    private async runAuthFlow(
        providerID: string,
        providerLabel: string,
        methods: ProviderAuthMethod[],
        opts?: { isMiMo?: boolean }
    ): Promise<void> {
        // Pick method if multiple
        let methodIndex = 0;
        if (methods.length > 1) {
            const items: MethodPickItem[] = methods.map((m, i) => ({
                label: m.label,
                description: m.type,
                methodIndex: i
            }));
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select login method',
                title: `Sign in to ${providerLabel}`
            });
            if (!picked) {
                return;
            }
            methodIndex = picked.methodIndex;
        }

        const method = methods[methodIndex];

        // For API key methods, use password input
        if (method.type === 'api' && (!method.prompts || method.prompts.length === 0)) {
            const key = await vscode.window.showInputBox({
                prompt: `Enter your API key for ${providerLabel}`,
                title: `Sign in to ${providerLabel}`,
                password: true,
                validateInput: v => (v && v.trim().length > 0 ? undefined : 'API key is required')
            });
            if (!key) {
                return;
            }
            try {
                await this._apiClient.authorizeProvider(providerID, {
                    method: methodIndex,
                    inputs: { key: key.trim() }
                });
                vscode.window.showInformationMessage(`Successfully signed in to ${providerLabel}.`);
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Failed to save API key: ${err instanceof Error ? err.message : String(err)}`
                );
            }
            return;
        }

        // Collect prompt inputs
        const inputs = await this.collectPromptInputs(method, providerLabel);
        if (inputs === undefined) {
            return; // user cancelled
        }

        // Authorize with retry for MiMo
        const maxRetries = opts?.isMiMo ? MAX_OAUTH_RETRIES : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const success = await this.doAuthorizeAndCallback(
                providerID, providerLabel, methodIndex, inputs, opts?.isMiMo
            );
            if (success) {
                return;
            }
            if (opts?.isMiMo && attempt < maxRetries - 1) {
                const remaining = maxRetries - attempt - 1;
                const retry = await vscode.window.showWarningMessage(
                    `Login failed. ${remaining} attempt(s) remaining.`,
                    'Retry',
                    'Cancel'
                );
                if (retry !== 'Retry') {
                    return;
                }
            }
        }
    }

    private async doAuthorizeAndCallback(
        providerID: string,
        providerLabel: string,
        methodIndex: number,
        inputs: Record<string, string>,
        isMiMo?: boolean
    ): Promise<boolean> {
        // Authorize
        let authorization;
        try {
            authorization = await this._apiClient.authorizeProvider(providerID, {
                method: methodIndex,
                inputs: Object.keys(inputs).length > 0 ? inputs : undefined
            });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Authorization failed: ${err instanceof Error ? err.message : String(err)}`
            );
            return false;
        }

        if (!authorization) {
            vscode.window.showErrorMessage(`No authorization response from ${providerLabel}.`);
            return false;
        }

        // Show URL fallback (like CLI)
        if (authorization.url) {
            await vscode.env.openExternal(vscode.Uri.parse(authorization.url));
            // Show URL as fallback in case browser didn't open
            if (isMiMo) {
                vscode.window.showInformationMessage(
                    `Browser didn't open? Visit: ${authorization.url}`,
                    'Copy URL'
                ).then(action => {
                    if (action === 'Copy URL') {
                        vscode.env.clipboard.writeText(authorization.url);
                    }
                });
            }
        }

        if (authorization.instructions) {
            vscode.window.showInformationMessage(authorization.instructions);
        }

        if (authorization.method === 'auto') {
            return await this.handleAutoMethod(providerID, providerLabel, methodIndex);
        } else if (authorization.method === 'code') {
            return await this.handleCodeMethod(providerID, providerLabel, methodIndex);
        }

        return false;
    }

    private async handleAutoMethod(
        providerID: string,
        providerLabel: string,
        methodIndex: number
    ): Promise<boolean> {
        // Show progress indicator while waiting for browser callback
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Waiting for ${providerLabel} authorization...`,
                cancellable: true
            },
            async (_progress, token) => {
                // Try the callback (server handles the browser OAuth flow)
                try {
                    // Poll with a short delay to allow browser callback to complete
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    if (token.isCancellationRequested) {
                        return false;
                    }

                    await this._apiClient.completeProviderOAuth(providerID, {
                        method: methodIndex
                    });
                    vscode.window.showInformationMessage(`Successfully signed in to ${providerLabel}.`);
                    return true;
                } catch {
                    // Auto callback failed, offer manual code fallback
                    if (token.isCancellationRequested) {
                        return false;
                    }
                    const code = await vscode.window.showInputBox({
                        prompt: 'Paste the authorization code from the browser',
                        title: `Sign in to ${providerLabel}`,
                        placeHolder: 'Authorization code'
                    });
                    if (!code) {
                        return false;
                    }
                    try {
                        await this._apiClient.completeProviderOAuth(providerID, {
                            method: methodIndex,
                            code: code.trim()
                        });
                        vscode.window.showInformationMessage(`Successfully signed in to ${providerLabel}.`);
                        return true;
                    } catch (err2) {
                        vscode.window.showErrorMessage(
                            `OAuth callback failed: ${err2 instanceof Error ? err2.message : String(err2)}`
                        );
                        return false;
                    }
                }
            }
        );
    }

    private async handleCodeMethod(
        providerID: string,
        providerLabel: string,
        methodIndex: number
    ): Promise<boolean> {
        const code = await vscode.window.showInputBox({
            prompt: 'Paste the authorization code from the browser',
            title: `Sign in to ${providerLabel}`,
            placeHolder: 'Authorization code',
            validateInput: v => (v && v.trim().length > 0 ? undefined : 'Authorization code is required')
        });
        if (!code) {
            return false;
        }

        try {
            await this._apiClient.completeProviderOAuth(providerID, {
                method: methodIndex,
                code: code.trim()
            });
            vscode.window.showInformationMessage(`Successfully signed in to ${providerLabel}.`);
            return true;
        } catch (err) {
            vscode.window.showErrorMessage(
                `OAuth callback failed: ${err instanceof Error ? err.message : String(err)}`
            );
            return false;
        }
    }

    // ---- Prompt collection ----

    private async collectPromptInputs(
        method: ProviderAuthMethod,
        providerLabel: string
    ): Promise<Record<string, string> | undefined> {
        const inputs: Record<string, string> = {};
        if (!method.prompts || method.prompts.length === 0) {
            return inputs;
        }

        for (const prompt of method.prompts) {
            // Check `when` condition
            if (prompt.when) {
                const val = inputs[prompt.when.key];
                if (val === undefined) {
                    continue;
                }
                const matches = prompt.when.op === 'eq'
                    ? val === prompt.when.value
                    : val !== prompt.when.value;
                if (!matches) {
                    continue;
                }
            }

            const value = await this.collectSinglePrompt(prompt, providerLabel);
            if (value === undefined) {
                return undefined; // user cancelled
            }
            inputs[prompt.key] = value;
        }

        return inputs;
    }

    private async collectSinglePrompt(
        prompt: ProviderAuthPrompt,
        providerLabel: string
    ): Promise<string | undefined> {
        if (prompt.type === 'text') {
            const result = await vscode.window.showInputBox({
                prompt: prompt.message,
                placeHolder: prompt.placeholder,
                title: `Sign in to ${providerLabel}`,
                validateInput: v => (v && v.trim().length > 0 ? undefined : `${prompt.message} is required`)
            });
            return result?.trim();
        }

        if (prompt.type === 'select') {
            const items = prompt.options.map(o => ({
                label: o.label,
                description: o.hint || ''
            }));
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: prompt.message,
                title: `Sign in to ${providerLabel}`
            });
            if (!picked) {
                return undefined;
            }
            const matched = prompt.options.find(o => o.label === picked.label);
            return matched?.value;
        }

        return undefined;
    }

    // ---- Helpers ----

    private buildProviderPickItems(
        providers: ProviderListResult,
        authMethods: ProviderAuthMethodsResult,
        connected: Set<string>
    ): ProviderPickItem[] {
        const priority: Record<string, number> = {
            opencode: 0,
            openai: 1,
            'github-copilot': 2,
            google: 3,
            anthropic: 4,
            openrouter: 5,
            vercel: 6,
        };

        const withAuth = (providers.all || []).filter(p => {
            const methods = authMethods[p.id];
            return methods && methods.length > 0;
        });

        withAuth.sort((a, b) => {
            const aConn = connected.has(a.id) ? 0 : 1;
            const bConn = connected.has(b.id) ? 0 : 1;
            if (aConn !== bConn) {
                return aConn - bConn;
            }
            const aPri = priority[a.id] ?? 99;
            const bPri = priority[b.id] ?? 99;
            if (aPri !== bPri) {
                return aPri - bPri;
            }
            return (a.name || a.id).localeCompare(b.name || b.id);
        });

        return withAuth.map(p => ({
            label: (connected.has(p.id) ? '$(check) ' : '') + (p.name || p.id),
            description: connected.has(p.id) ? 'connected' : '',
            providerID: p.id
        }));
    }

    private resolveDefaultMap(
        defaultInfo: ProviderListResult['default']
    ): Map<string, string> {
        const map = new Map<string, string>();
        if (!defaultInfo) {
            return map;
        }
        if (Array.isArray(defaultInfo)) {
            for (const entry of defaultInfo) {
                map.set(entry.providerID, entry.modelID);
            }
        } else {
            for (const [providerID, modelID] of Object.entries(defaultInfo)) {
                map.set(providerID, modelID);
            }
        }
        return map;
    }

    private countModels(provider: ProviderInfo): number {
        if (!provider.models) {
            return 0;
        }
        if (Array.isArray(provider.models)) {
            return provider.models.length;
        }
        return Object.keys(provider.models).length;
    }
}
