import { ChatRequest, ChatResult, EmbeddingProvider, Model, Provider, Usage } from './types';

const timeoutMs = 120_000;
const toolSchema = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: ['files', 'search', 'read', 'edit', 'run', 'verify', 'git', 'rollback', 'finish'] },
    args: { type: 'object', properties: {
      path: { type: 'string' }, content: { type: 'string' }, query: { type: 'string' },
      command: { type: 'string' }, answer: { type: 'string' }, operation: { type: 'string' }, input: { type: 'string' }
    }, additionalProperties: false },
    reason: { type: 'string' }
  },
  required: ['tool', 'args', 'reason']
};
function endpoint(base: string, path: string): URL {
  const url = new URL(base.endsWith('/') ? base : `${base}/`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Provider URL must use HTTP or HTTPS');
  return new URL(path, url);
}
async function checked(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(`Model API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}
async function streamLines(response: Response, onLine: (line: string) => void): Promise<void> {
  if (!response.body) throw new Error('Model API returned no stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).trimEnd();
        pending = pending.slice(index + 1);
        onLine(line);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) onLine(pending.trim());
  } finally { reader.releaseLock(); }
}
function defaultModel(id: string, provider: string, overrides: Partial<Model> = {}): Model {
  return { id, provider, contextTokens: 8192, maxOutputTokens: 2048,
    inputCostPerMillion: 0, outputCostPerMillion: 0, speed: 3, capability: 3,
    available: true, ...overrides };
}
function usage(input = 0, output = 0): Usage { return { inputTokens: input, outputTokens: output }; }

export class OllamaProvider implements Provider, EmbeddingProvider {
  readonly id: string;
  constructor(readonly baseUrl = 'http://127.0.0.1:11434', id = 'ollama') { this.id = id; }
  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const response = await checked(await fetch(endpoint(this.baseUrl, 'api/tags'), { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)]) }));
    const body = await response.json() as { models?: Array<{ name: string; details?: { parameter_size?: string } }> };
    return Promise.all((body.models ?? []).map(async item => {
      let capabilities: string[] = [];
      try {
        const shown = await checked(await fetch(endpoint(this.baseUrl, 'api/show'), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: item.name }),
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)])
        }));
        capabilities = ((await shown.json()) as { capabilities?: string[] }).capabilities ?? [];
      } catch { /* Unconfirmed models remain unavailable for chat. */ }
      const size = Number(item.name.match(/(\d+(?:\.\d+)?)b/i)?.[1] ?? item.details?.parameter_size?.match(/(\d+(?:\.\d+)?)/)?.[1]);
      const coder = /qwen|coder|deepseek/i.test(item.name);
      return defaultModel(item.name, this.id, {
        contextTokens: 4096, maxOutputTokens: 1024,
        capability: Number.isFinite(size) ? size < 1 ? 2 : size < 3 ? 3 : size < 7 ? 4 : 5 : coder ? 4 : 3,
        speed: Number.isFinite(size) ? size < 1 ? 5 : size < 3 ? 4 : size < 7 ? 3 : 2 : 3,
        available: capabilities.includes('completion')
      });
    }));
  }
  async chat(request: ChatRequest): Promise<ChatResult> {
    const response = await checked(await fetch(endpoint(this.baseUrl, 'api/chat'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: request.model.id, messages: request.messages, stream: true,
        format: request.formatSchema ?? (request.json ? { ...toolSchema, properties: { ...toolSchema.properties,
          tool: { ...toolSchema.properties.tool, enum: request.allowedTools ?? toolSchema.properties.tool.enum } } } : undefined),
        options: { num_predict: request.model.maxOutputTokens } }),
      signal: AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)])
    }));
    let text = ''; let reported = usage();
    await streamLines(response, line => {
      if (!line.trim()) return;
      const item = JSON.parse(line) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; error?: string };
      if (item.error) throw new Error(item.error);
      const token = item.message?.content ?? '';
      text += token; if (token) request.onToken?.(token);
      if (item.prompt_eval_count !== undefined || item.eval_count !== undefined)
        reported = usage(item.prompt_eval_count ?? 0, item.eval_count ?? 0);
    });
    return { text, usage: reported, model: request.model.id };
  }
  async embed(modelId: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const response = await checked(await fetch(endpoint(this.baseUrl, 'api/embed'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, input: inputs }),
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)])
    }));
    const body = await response.json() as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== inputs.length) throw new Error('Invalid Ollama embeddings response');
    return body.embeddings;
  }
}

export interface CompatibleModel extends Partial<Model> { id: string }
export class OpenAICompatibleProvider implements Provider, EmbeddingProvider {
  readonly id: string;
  constructor(readonly baseUrl: string, readonly models: CompatibleModel[], readonly apiKey?: string, id = 'openai-compatible') {
    this.id = id;
  }
  async listModels(): Promise<Model[]> {
    const host = new URL(this.baseUrl).hostname.toLowerCase();
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    return this.models.map(item => defaultModel(item.id, this.id, {
      ...item,
      available: item.available !== false && (local ||
        (item.inputCostPerMillion !== undefined && item.outputCostPerMillion !== undefined))
    }));
  }
  async chat(request: ChatRequest): Promise<ChatResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await checked(await fetch(endpoint(this.baseUrl, 'chat/completions'), {
      method: 'POST', headers,
      body: JSON.stringify({ model: request.model.id, messages: request.messages,
        stream: true, stream_options: { include_usage: true }, max_tokens: request.model.maxOutputTokens }),
      signal: AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)])
    }));
    let text = ''; let reported = usage(); let data = '';
    const flush = () => {
      if (!data || data === '[DONE]') { data = ''; return; }
      const item = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
      if (item.error) throw new Error(item.error.message ?? 'Model API error');
      const token = item.choices?.[0]?.delta?.content ?? '';
      text += token; if (token) request.onToken?.(token);
      if (item.usage) reported = usage(item.usage.prompt_tokens ?? 0, item.usage.completion_tokens ?? 0);
      data = '';
    };
    await streamLines(response, line => {
      if (!line) { flush(); return; }
      if (line.startsWith('data:')) data += line.slice(5).trimStart();
    });
    flush();
    return { text, usage: reported, model: request.model.id };
  }
  async embed(modelId: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await checked(await fetch(endpoint(this.baseUrl, 'embeddings'), {
      method: 'POST', headers, body: JSON.stringify({ model: modelId, input: inputs }),
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)])
    }));
    const body = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    if (!Array.isArray(body.data) || body.data.length !== inputs.length) throw new Error('Invalid embeddings response');
    return body.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
  }
}
