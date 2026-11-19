export type Mode = 'ask' | 'plan' | 'agent';
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message { role: Role; content: string }
export interface Usage { inputTokens: number; outputTokens: number }
export interface Model {
  id: string;
  provider: string;
  contextTokens: number;
  maxOutputTokens: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  speed: number;
  capability: number;
  available: boolean;
}
export interface ChatRequest {
  model: Model;
  messages: Message[];
  json?: boolean;
  allowedTools?: string[];
  formatSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}
export interface ChatResult { text: string; usage: Usage; model: string }
export interface Provider {
  id: string;
  listModels(signal?: AbortSignal): Promise<Model[]>;
  chat(request: ChatRequest): Promise<ChatResult>;
}
export interface EmbeddingProvider {
  embed(modelId: string, inputs: string[], signal?: AbortSignal): Promise<number[][]>;
}
export interface TaskOptions {
  mode: Mode;
  prompt: string;
  modelId?: string;
  maxUsd: number;
  maxSteps: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onProgress?: (event: Progress) => void;
}
export interface Progress { step: number; maxSteps: number; message: string; model?: string }
export interface ApprovalRequest {
  kind: 'edit' | 'command';
  title: string;
  detail: string;
  path?: string;
  before?: string;
  after?: string;
}
export type Approve = (request: ApprovalRequest) => Promise<boolean>;
