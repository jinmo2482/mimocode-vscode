import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ServerManager, ServerState } from './server/serverManager';
import { ApiClient } from './api/client';
import { SseClient } from './api/sseClient';
import { ChatPanelProvider } from './chat/chatPanelProvider';
import { EditorContext } from './context/editorContext';
import { MentionProvider } from './context/mentionProvider';
import { DiffManager } from './diff/diffManager';
import { TerminalBridge } from './terminal/terminalBridge';
import { StatusBarManager } from './statusbar/statusBarManager';
import { ConfigManager } from './config/configManager';
import { SessionTreeProvider } from './tree/sessionTreeProvider';
import { ProviderAuthController } from './provider/providerAuthController';

function getWorkspaceRootForServer(): string | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (folder) return folder.uri.fsPath;
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

let serverManager: ServerManager;
let apiClient: ApiClient;
let sseClient: SseClient;
let chatPanel: ChatPanelProvider;
let editorContext: EditorContext;
let mentionProvider: MentionProvider;
let diffManager: DiffManager;
let terminalBridge: TerminalBridge;
let statusBar: StatusBarManager;
let configManager: ConfigManager;
let sessionTreeProvider: SessionTreeProvider;
let providerAuthController: ProviderAuthController;

export async function activate(context: vscode.ExtensionContext) {
    configManager = new ConfigManager();
    const config = configManager.getConfig();

    const instanceId = crypto.randomUUID();

    serverManager = new ServerManager({
        port: config.server.port,
        mimoPath: config.server.path,
        autoStart: config.server.autoStart,
        cwd: getWorkspaceRootForServer(),
        instanceId
    });
    apiClient = new ApiClient(() => serverManager.baseUrl);
    sseClient = new SseClient();
    editorContext = new EditorContext();
    mentionProvider = new MentionProvider();
    diffManager = new DiffManager();
    terminalBridge = new TerminalBridge(sseClient, apiClient, configManager);
    statusBar = new StatusBarManager(serverManager);
    chatPanel = new ChatPanelProvider(
        context.extensionUri,
        apiClient,
        sseClient,
        editorContext,
        mentionProvider,
        diffManager
    );
    sessionTreeProvider = new SessionTreeProvider(apiClient, getWorkspaceRootForServer);
    providerAuthController = new ProviderAuthController(apiClient);

    // Wire webview sign-in button to the auth controller
    chatPanel.setSignInHandler(async () => {
        try {
            const providers = await providerAuthController.signIn();
            await chatPanel.refreshProviders();
            if (providers) {
                const connected = providers.connected || [];
                if (connected.length > 0) {
                    await promptModelSelection(apiClient, chatPanel, providers);
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Sign in failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });

    // serverManager is NOT in subscriptions — deactivate() handles its async stop.
    context.subscriptions.push(
        sseClient,
        diffManager,
        terminalBridge,
        statusBar,
        mentionProvider,
        configManager,
        chatPanel
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, chatPanel),
        vscode.window.registerTreeDataProvider('mimocode.sessionsView', sessionTreeProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mimocode.openChat', () => chatPanel.show()),
        vscode.commands.registerCommand('mimocode.focusChat', () => chatPanel.show()),
        vscode.commands.registerCommand('mimocode.askSelection', async () => {
            const selection = editorContext.getSelection();
            if (selection) {
                await chatPanel.sendWithContext(selection.text);
            } else {
                const currentFile = editorContext.getCurrentFile();
                if (currentFile) {
                    await chatPanel.sendWithContext(`Please inspect @${currentFile.path}`);
                }
            }
        }),
        vscode.commands.registerCommand('mimocode.newSession', async () => {
            await chatPanel.newSession();
            sessionTreeProvider.refresh();
        }),
        vscode.commands.registerCommand('mimocode.acceptDiff', async () => diffManager.acceptCurrentDiff()),
        vscode.commands.registerCommand('mimocode.rejectDiff', async () => diffManager.rejectCurrentDiff()),
        vscode.commands.registerCommand('mimocode.acceptAllDiffs', async () => diffManager.acceptAll()),
        vscode.commands.registerCommand('mimocode.rejectAllDiffs', async () => diffManager.rejectAll()),
        vscode.commands.registerCommand('mimocode.abort', async () => chatPanel.abort()),
        vscode.commands.registerCommand('mimocode.switchSession', async (sessionId: string) => {
            await chatPanel.switchSession(sessionId);
        }),
        vscode.commands.registerCommand('mimocode.refreshSessions', () => sessionTreeProvider.refresh()),
        vscode.commands.registerCommand('mimocode.openTerminal', async () => terminalBridge.openTerminal(false)),
        vscode.commands.registerCommand('mimocode.openNewTerminal', async () => terminalBridge.openTerminal(true)),
        vscode.commands.registerCommand('mimocode.insertFileReference', async () => terminalBridge.insertActiveFileReference()),
        vscode.commands.registerCommand('mimocode.signInProvider', async () => {
            try {
                const providers = await providerAuthController.signIn();
                await chatPanel.refreshProviders();
                if (providers) {
                    const connected = providers.connected || [];
                    if (connected.length > 0) {
                        await promptModelSelection(apiClient, chatPanel, providers);
                    }
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Sign in failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
        vscode.commands.registerCommand('mimocode.viewProviders', async () => {
            try {
                await providerAuthController.viewProviders();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to view providers: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
        vscode.commands.registerCommand('mimocode.refreshProviders', async () => {
            try {
                await providerAuthController.refreshProviders();
                chatPanel.refreshProviders();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to refresh providers: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
        vscode.commands.registerCommand('mimocode.whoami', async () => {
            try {
                await providerAuthController.whoami();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to get user info: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
        vscode.commands.registerCommand('mimocode.setModel', async () => {
            const models = chatPanel.getModels();
            if (models.length === 0) {
                vscode.window.showWarningMessage('No models available. Please sign in to a provider first.');
                return;
            }
            const selected = await vscode.window.showQuickPick(models, {
                placeHolder: 'Select a MiMoCode model'
            });
            if (selected) {
                await chatPanel.setModel(selected.label);
            }
        }),
        vscode.commands.registerCommand('mimocode.setVariant', async () => {
            const variants = chatPanel.getVariantOptions();
            if (variants.length === 0) {
                vscode.window.showWarningMessage('No reasoning effort options available for the current model.');
                return;
            }
            const items = [{ label: 'default', description: 'No reasoning effort override' }, ...variants.map(v => ({ label: v }))];
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select reasoning effort'
            });
            if (selected) {
                await chatPanel.setVariant(selected.label === 'default' ? undefined : selected.label);
            }
        })
    );

    sseClient.onStateChange(state => statusBar.setSseState(state));
    serverManager.onStateChange(state => {
        if (state === ServerState.Running) {
            sseClient.connect(serverManager.baseUrl);
        } else if (state === ServerState.Stopped || state === ServerState.Error) {
            sseClient.disconnect();
        }
    });

    configManager.onConfigChange(newConfig => {
        serverManager.updateConfig({
            port: newConfig.server.port,
            mimoPath: newConfig.server.path,
            autoStart: newConfig.server.autoStart,
            cwd: getWorkspaceRootForServer(),
            instanceId
        });
        void vscode.window.showInformationMessage('MiMoCode settings changed. Restart the MiMoCode server for port/path changes to apply.');
    });

    if (config.server.autoStart) {
        await serverManager.start();
        sseClient.connect(serverManager.baseUrl);
    }
}

async function promptModelSelection(
    apiClient: ApiClient,
    chatPanel: ChatPanelProvider,
    providers: import('./api/client').ProviderListResult
): Promise<void> {
    const models = apiClient.normalizeModels(providers);
    if (models.length === 0) {
        return;
    }
    const connected = new Set(providers.connected || []);
    models.sort((a, b) => {
        const aConn = connected.has(a.providerID) ? 0 : 1;
        const bConn = connected.has(b.providerID) ? 0 : 1;
        return aConn - bConn;
    });
    const selected = await vscode.window.showQuickPick(models, {
        placeHolder: 'Select a default model'
    });
    if (selected) {
        await apiClient.setModel(selected.label);
        await chatPanel.refreshProviders();
        vscode.window.showInformationMessage(`MiMoCode model set to ${selected.label}`);
    }
}

export async function deactivate(): Promise<void> {
    try {
        sseClient?.disconnect();
    } catch {
        // ignore
    }

    try {
        await serverManager?.stop();
    } catch (err) {
        console.error('[MiMoCode] Failed to stop server during deactivate:', err);
    }

    try {
        serverManager?.dispose();
    } catch {
        // ignore
    }
}
