import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Message, Mode, Usage } from './types';

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  mode: Mode;
  messages: Message[];
  summary: string;
  usage: Usage;
  spentUsd: number;
  actions: Array<{ at: string; kind: string; detail: string; approved?: boolean }>;
}
export class SessionStore {
  constructor(readonly directory: string) {}
  create(mode: Mode): Session {
    const now = new Date().toISOString();
    return { id: randomUUID(), createdAt: now, updatedAt: now, mode, messages: [], summary: '',
      usage: { inputTokens: 0, outputTokens: 0 }, spentUsd: 0, actions: [] };
  }
  private filename(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID');
    return path.join(this.directory, `${id}.json`);
  }
  async load(id: string): Promise<Session> {
    const parsed = JSON.parse(await readFile(this.filename(id), 'utf8')) as Session;
    if (parsed.id !== id || !Array.isArray(parsed.messages)) throw new Error('Corrupt session');
    return parsed;
  }
  async save(session: Session): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await mkdir(this.directory, { recursive: true });
    const filename = this.filename(session.id);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filename);
  }
  async list(): Promise<Session[]> {
    const { readdir } = await import('node:fs/promises');
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const results = await Promise.all(names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => this.load(n.slice(0, -5))));
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
