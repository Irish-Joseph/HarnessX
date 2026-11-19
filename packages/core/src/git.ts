import { spawn } from 'node:child_process';
import { Approve } from './types';
import { Workspace } from './workspace';

export type GitOperation = 'status' | 'diff' | 'log' | 'branch' | 'add' | 'commit' | 'new_branch' | 'push';
export class GitTools {
  constructor(readonly workspace: Workspace, readonly approve: Approve) {}
  async run(operation: GitOperation, input = ''): Promise<string> {
    let args: string[];
    let mutation = false;
    switch (operation) {
      case 'status': args = ['status', '--short', '--branch']; break;
      case 'diff':
        if (input) { await this.workspace.resolve(input); args = ['diff', '--no-ext-diff', '--', input]; }
        else args = ['diff', '--no-ext-diff'];
        break;
      case 'log': args = ['log', '-5', '--oneline']; break;
      case 'branch': args = ['branch', '--show-current']; break;
      case 'add':
        if (!input) throw new Error('Path required for git add');
        await this.workspace.resolve(input); args = ['add', '--', input]; mutation = true; break;
      case 'commit':
        if (!input.trim() || input.length > 200) throw new Error('Commit message must be 1-200 characters');
        args = ['commit', '-m', input]; mutation = true; break;
      case 'new_branch':
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/.test(input) || input.includes('..') || input.endsWith('/'))
          throw new Error('Invalid branch name');
        args = ['switch', '-c', input]; mutation = true; break;
      case 'push': args = ['push', 'origin', 'HEAD']; mutation = true; break;
      default: throw new Error(`Unsupported Git operation: ${operation}`);
    }
    if (mutation && !await this.approve({ kind: 'command', title: 'Git operation approval', detail: `git ${args.join(' ')}` }))
      throw new Error('Git operation rejected');
    return new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        { cwd: this.workspace.root, shell: false, windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '' } });
      let output = '';
      const append = (chunk: Buffer) => { output += chunk.toString('utf8').slice(0, Math.max(0, 64_000 - output.length)); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const timer = setTimeout(() => child.kill(), 30_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`git ${operation} exited ${code}: ${output}`)); });
    });
  }
}
