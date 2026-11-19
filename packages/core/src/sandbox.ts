import { spawn } from 'node:child_process';
import { cp, lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Approve } from './types';

export interface CommandResult { command: string; exitCode: number; output: string; durationMs: number; truncated: boolean }
export interface SandboxOptions { image?: string; memoryMb?: number; cpus?: number; timeoutMs?: number; maxCopyMb?: number }
const excluded = new Set(['.git', '.vscode-test', 'dist', 'build', 'coverage', '.next', '.venv']);
function protectedName(name: string): boolean {
  return excluded.has(name) || /^\.env(?:\.|$)/i.test(name) || /\.(pem|key|p12)$/i.test(name) ||
    /^(id_rsa|id_ed25519|credentials|secrets?\.json)$/i.test(name);
}
export class DockerSandbox {
  readonly image: string;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly timeoutMs: number;
  readonly maxCopyMb: number;
  constructor(readonly root: string, options: SandboxOptions = {}) {
    this.image = options.image ?? 'node:22-bookworm-slim';
    this.memoryMb = options.memoryMb ?? 512;
    this.cpus = options.cpus ?? 1;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxCopyMb = options.maxCopyMb ?? 256;
    if (this.memoryMb < 64 || this.cpus <= 0 || this.timeoutMs < 1000) throw new Error('Invalid sandbox limits');
  }
  async run(command: string, approve: Approve, signal?: AbortSignal): Promise<CommandResult> {
    if (!command.trim() || command.length > 4000 || command.includes('\0')) throw new Error('Invalid command');
    if (!await approve({ kind: 'command', title: 'Run command in Docker sandbox', detail: command })) throw new Error('Command rejected');
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'harnessx-'));
    let copied = 0;
    try {
      await cp(this.root, temporary, { recursive: true, force: true, filter: async source => {
        const name = path.basename(source);
        if (protectedName(name)) return false;
        const info = await lstat(source);
        if (info.isSymbolicLink()) return false;
        if (!info.isDirectory()) copied += info.size;
        if (copied > this.maxCopyMb * 1024 * 1024) throw new Error('Sandbox copy limit exceeded');
        return true;
      } });
      const containerName = `harnessx-${randomUUID()}`;
      const args = ['run', '--name', containerName, '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', `${this.memoryMb}m`,
        '--cpus', String(this.cpus), '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m',
        '--mount', `type=bind,source=${temporary},target=/workspace`, '-w', '/workspace',
        this.image, 'sh', '-lc', command];
      const started = Date.now();
      return await new Promise<CommandResult>((resolve, reject) => {
        const child = spawn('docker', args, { windowsHide: true, shell: false });
        let output = ''; let truncated = false;
        const append = (chunk: Buffer) => {
          const data = chunk.toString('utf8');
          if (output.length + data.length <= 64_000) output += data;
          else { output += data.slice(0, Math.max(0, 64_000 - output.length)); truncated = true; }
        };
        child.stdout.on('data', append); child.stderr.on('data', append);
        let timedOut = false;
        const stop = () => {
          const cleanup = spawn('docker', ['rm', '-f', containerName], { windowsHide: true, shell: false });
          cleanup.on('error', () => undefined);
          child.kill();
        };
        const timer = setTimeout(() => { timedOut = true; stop(); }, this.timeoutMs);
        const abort = () => stop();
        signal?.addEventListener('abort', abort, { once: true });
        child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
        child.once('close', code => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (signal?.aborted) reject(new Error('Command cancelled'));
          else if (timedOut) reject(new Error(`Sandbox command timed out after ${this.timeoutMs} ms`));
          else resolve({ command, exitCode: code ?? -1, output, durationMs: Date.now() - started, truncated });
        });
      });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
