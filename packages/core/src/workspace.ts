import { lstat, readFile, readdir, realpath, rename, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EmbeddingProvider } from './types';

const excluded = new Set(['.git', '.vscode-test', 'node_modules', 'dist', 'build', '.next', 'coverage', '.venv', 'venv']);
function forbidden(name: string): boolean {
  return excluded.has(name) || /^\.env(?:\.|$)/i.test(name) ||
    /^(id_rsa|id_ed25519|credentials|secrets?\.json)$/i.test(name) || /\.(pem|key|p12)$/i.test(name);
}
export interface SearchHit { path: string; line: number; score: number; snippet: string }
export interface EditRecord { path: string; before: string | null; after: string; historyFile?: string }
export class Workspace {
  private undoStack: EditRecord[] = [];
  private embeddingCache = new Map<string, number[]>();
  constructor(readonly root: string, readonly historyDirectory?: string) {}
  async resolve(relative: string): Promise<string> {
    if (!relative || path.isAbsolute(relative)) throw new Error('Path must be relative to workspace');
    const base = await realpath(this.root);
    const target = path.resolve(base, relative);
    if (target === base || !target.startsWith(base + path.sep)) throw new Error('Path escapes workspace');
    let current = base;
    for (const part of path.relative(base, target).split(path.sep)) {
      if (!part || part === '..') throw new Error('Invalid path');
      if (forbidden(part)) throw new Error('Protected path');
      current = path.join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink paths are not allowed'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async read(relative: string): Promise<string> {
    const target = await this.resolve(relative);
    const value = await readFile(target);
    if (value.length > 1_000_000 || value.includes(0)) throw new Error('File is binary or too large');
    return value.toString('utf8');
  }
  async files(limit = 5000): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (found.length >= limit) return;
      for (const entry of await readdir(path.join(this.root, dir), { withFileTypes: true })) {
        if (forbidden(entry.name) || entry.isSymbolicLink()) continue;
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(relative);
        else if (entry.isFile()) found.push(relative.replaceAll('\\', '/'));
        if (found.length >= limit) break;
      }
    };
    await walk(''); return found;
  }
  async search(query: string, maxHits = 20): Promise<SearchHit[]> {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])].filter(t => t.length >= 2);
    if (!terms.length) return [];
    const hits: SearchHit[] = [];
    for (const file of await this.files()) {
      let content: string;
      try { content = await this.read(file); } catch { continue; }
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        const lower = line.toLowerCase();
        const matched = terms.filter(t => lower.includes(t));
        if (matched.length) hits.push({ path: file, line: index + 1,
          score: matched.length * 10 + Number(file.toLowerCase().includes(terms[0])) * 5,
          snippet: line.trim().slice(0, 240) });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, maxHits);
  }
  async semanticSearch(query: string, provider: EmbeddingProvider, modelId: string,
    signal?: AbortSignal, maxChunks = 120): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const chunks: Array<{ path: string; line: number; snippet: string; key: string }> = [];
    for (const file of await this.files(500)) {
      if (chunks.length >= maxChunks) break;
      let content: string;
      try { content = await this.read(file); } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let start = 0; start < lines.length && chunks.length < maxChunks; start += 40) {
        const snippet = lines.slice(start, start + 40).join('\n').slice(0, 1800);
        if (!snippet.trim()) continue;
        const key = `${modelId}:${createHash('sha256').update(file + ':' + snippet).digest('hex')}`;
        chunks.push({ path: file, line: start + 1, snippet, key });
      }
    }
    const queryVector = (await provider.embed(modelId, [query], signal))[0];
    for (let offset = 0; offset < chunks.length; offset += 8) {
      const missing = chunks.slice(offset, offset + 8).filter(item => !this.embeddingCache.has(item.key));
      if (!missing.length) continue;
      const vectors = await provider.embed(modelId, missing.map(item => `${item.path}\n${item.snippet}`), signal);
      missing.forEach((item, index) => this.embeddingCache.set(item.key, vectors[index]));
      while (this.embeddingCache.size > 300) this.embeddingCache.delete(this.embeddingCache.keys().next().value!);
    }
    const cosine = (a: number[], b: number[]): number => {
      if (!a.length || a.length !== b.length) return 0;
      let dot = 0; let an = 0; let bn = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] ** 2; bn += b[i] ** 2; }
      return an && bn ? dot / Math.sqrt(an * bn) : 0;
    };
    return chunks.map(item => ({ path: item.path, line: item.line,
      score: cosine(queryVector, this.embeddingCache.get(item.key) ?? []), snippet: item.snippet.slice(0, 600) }))
      .sort((a, b) => b.score - a.score).slice(0, 20);
  }
  async edit(relative: string, after: string): Promise<EditRecord> {
    if (Buffer.byteLength(after) > 1_000_000) throw new Error('Edit exceeds 1 MB');
    const target = await this.resolve(relative);
    let before: string | null;
    try { before = await this.read(relative); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      before = null;
    }
    const record: EditRecord = { path: relative, before, after };
    if (this.historyDirectory) {
      await mkdir(this.historyDirectory, { recursive: true });
      record.historyFile = path.join(this.historyDirectory,
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
      await writeFile(record.historyFile, JSON.stringify({ path: relative, before, after }), { encoding: 'utf8', mode: 0o600 });
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.harnessx-tmp`;
    try { await writeFile(temporary, after, 'utf8'); await rename(temporary, target); }
    catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (record.historyFile) await unlink(record.historyFile).catch(() => undefined);
      throw error;
    }
    this.undoStack.push(record); return record;
  }
  async rollback(): Promise<EditRecord> {
    let record = this.undoStack.pop();
    if (!record && this.historyDirectory) {
      const names = (await readdir(this.historyDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      })).filter(name => /^\d{4}-.*\.json$/.test(name)).sort().reverse();
      if (names.length) {
        const filename = path.join(this.historyDirectory, names[0]);
        record = { ...JSON.parse(await readFile(filename, 'utf8')) as EditRecord, historyFile: filename };
      }
    }
    if (!record) throw new Error('No edit to roll back');
    const current = await this.read(record.path);
    if (current !== record.after) { this.undoStack.push(record); throw new Error('File changed since edit; rollback refused'); }
    const target = await this.resolve(record.path);
    if (record.before === null) await unlink(target);
    else {
      const temporary = `${target}.${randomUUID()}.harnessx-tmp`;
      await writeFile(temporary, record.before, 'utf8');
      await rename(temporary, target);
    }
    if (record.historyFile) await unlink(record.historyFile);
    return record;
  }
}
