import * as vscode from 'vscode';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ApprovalRequest, DockerSandbox, Harness, OllamaProvider, OpenAICompatibleProvider,
  Provider, Session, SessionStore, Workspace } from '@harnessx/core';

type Endpoint = { id: string; baseUrl: string; apiKeyEnv?: string; models: Array<string | { id: string; contextTokens?: number; maxOutputTokens?: number; inputCostPerMillion?: number; outputCostPerMillion?: number; speed?: number; capability?: number }> };
type WebMessage = { type: string; prompt?: string; mode?: 'ask' | 'plan' | 'agent'; modelId?: string; sessionId?: string };

class PreviewProvider implements vscode.TextDocumentContentProvider {
  readonly scheme = 'harnessx-preview';
  private contents = new Map<string, string>();
  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? ''; }
  create(content: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${this.scheme}:/${randomUUID()}`);
    this.contents.set(uri.toString(), content);
    return uri;
  }
  clear(uri: vscode.Uri): void { this.contents.delete(uri.toString()); }
}

export class ChatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private controller?: AbortController;
  private current?: Session;
  private readonly preview = new PreviewProvider();
  private readonly store: SessionStore;
  private readonly workspace?: Workspace;
  constructor(private readonly context: vscode.ExtensionContext) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceKey = createHash('sha256').update(root ?? 'no-workspace').digest('hex').slice(0, 16);
    this.store = new SessionStore(path.join(context.globalStorageUri.fsPath, 'sessions', workspaceKey));
    if (root) this.workspace = new Workspace(root,
      path.join(context.globalStorageUri.fsPath, 'history', workspaceKey));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(this.preview.scheme, this.preview));
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebMessage) => void this.handle(message));
    void this.refresh();
  }
  private send(type: string, data: unknown): void { void this.view?.webview.postMessage({ type, data }); }
  private providers(): Provider[] {
    const config = vscode.workspace.getConfiguration('harnessx');
    const result: Provider[] = [new OllamaProvider(config.get<string>('ollamaUrl', 'http://127.0.0.1:11434'))];
    for (const item of config.get<Endpoint[]>('compatibleProviders', [])) {
      if (!item.id || !item.baseUrl || !Array.isArray(item.models)) continue;
      const models = item.models.map(model => typeof model === 'string' ? { id: model } : model);
      result.push(new OpenAICompatibleProvider(item.baseUrl, models,
        item.apiKeyEnv ? process.env[item.apiKeyEnv] : undefined, item.id));
    }
    return result;
  }
  private harness(): Harness {
    if (!this.workspace) throw new Error('Open a workspace folder to use HarnessX');
    const config = vscode.workspace.getConfiguration('harnessx');
    const sandbox = new DockerSandbox(this.workspace.root, {
      image: config.get<string>('sandboxImage'), memoryMb: config.get<number>('sandboxMemoryMb'),
      timeoutMs: config.get<number>('sandboxTimeoutMs')
    });
    const embeddingModel = config.get<string>('embeddingModel', '').trim();
    const providers = this.providers();
    const ollama = providers[0] as OllamaProvider;
    return new Harness(providers, this.workspace, sandbox, this.store, request => this.approve(request),
      embeddingModel ? { provider: ollama, modelId: embeddingModel } : undefined);
  }
  private async approve(request: ApprovalRequest): Promise<boolean> {
    if (request.kind === 'edit') {
      const before = this.preview.create(request.before ?? '');
      const after = this.preview.create(request.after ?? '');
      try {
        await vscode.commands.executeCommand('vscode.diff', before, after, `HarnessX: ${request.path ?? 'Edit'} (review)`);
        const choice = await vscode.window.showWarningMessage(`Apply proposed edit to ${request.path}?`, { modal: true, detail: request.detail }, 'Apply');
        return choice === 'Apply';
      } finally { this.preview.clear(before); this.preview.clear(after); }
    }
    const choice = await vscode.window.showWarningMessage('Run this command in the Docker sandbox?',
      { modal: true, detail: request.detail }, 'Run');
    return choice === 'Run';
  }
  private async refresh(): Promise<void> {
    try {
      const [models, sessions] = await Promise.all([this.harness().models(), this.store.list()]);
      this.send('state', { models: models.filter(model => model.available), sessions: sessions.map(s => ({ id: s.id, updatedAt: s.updatedAt,
        title: s.messages.find(m => m.role === 'user')?.content.slice(0, 50) ?? 'New session' })),
        current: this.current?.id, usage: this.current?.usage, spentUsd: this.current?.spentUsd });
      if (!models.some(model => model.available)) this.send('notice', 'No chat model available. Start Ollama and pull a model, or configure an OpenAI-compatible endpoint with pricing.');
    } catch (error) { this.send('error', (error as Error).message); }
  }
  private async handle(message: WebMessage): Promise<void> {
    try {
      if (message.type === 'refresh') { await this.refresh(); return; }
      if (message.type === 'new') { this.current = undefined; this.send('history', []); await this.refresh(); return; }
      if (message.type === 'stop') { this.controller?.abort(); return; }
      if (message.type === 'load' && message.sessionId) {
        this.current = await this.store.load(message.sessionId);
        this.send('history', this.current.messages.filter(m => m.role === 'user' || m.role === 'assistant'));
        await this.refresh(); return;
      }
      if (message.type !== 'send' || !message.prompt?.trim()) return;
      if (this.controller) throw new Error('A task is already running');
      const harness = this.harness();
      const config = vscode.workspace.getConfiguration('harnessx');
      const session = this.current ?? this.store.create(message.mode ?? 'ask');
      this.current = session;
      this.controller = new AbortController();
      this.send('started', { prompt: message.prompt, mode: message.mode });
      try {
        const result = await harness.run(session, {
          prompt: message.prompt, mode: message.mode ?? 'ask', modelId: message.modelId || undefined,
          maxUsd: config.get<number>('maxUsdPerTask', 0), maxSteps: config.get<number>('maxAgentSteps', 12),
          signal: this.controller.signal,
          onToken: token => this.send('token', token), onProgress: event => this.send('progress', event)
        });
        this.send('done', { answer: result.answer, models: result.modelIds, usage: result.session.usage,
          spentUsd: result.session.spentUsd });
      } finally { this.controller = undefined; await this.refresh(); }
    } catch (error) { this.send('error', (error as Error).message); }
  }
  async rollback(): Promise<void> {
    if (!this.workspace) throw new Error('Open a workspace folder');
    const record = await this.workspace.rollback();
    void vscode.window.showInformationMessage(`Rolled back ${record.path}`);
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomUUID().replaceAll('-', '');
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<header><h1>HarnessX</h1><div class="row"><select id="sessions" aria-label="Session"><option value="">New session</option></select><button id="new" title="New session">New</button></div>
<div class="row"><select id="mode" aria-label="Mode"><option value="ask">Ask</option><option value="plan">Plan</option><option value="agent">Agent</option></select><select id="model" aria-label="Model"><option value="">Auto model</option></select><button id="refresh" title="Refresh models">↻</button></div><div id="usage" class="muted">No usage yet</div></header>
<main id="messages" aria-live="polite"></main><div id="progress" class="status"></div><div id="error" class="status"></div>
<footer><textarea id="prompt" placeholder="Ask about your code, plan a task, or run an agent..." aria-label="Prompt"></textarea><div class="row"><button id="send">Send</button><button id="stop" disabled>Stop</button><span class="muted">Agent edits and commands require approval</span></div></footer>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
