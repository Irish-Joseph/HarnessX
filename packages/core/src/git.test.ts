import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { GitTools } from './git';
import { Workspace } from './workspace';

const exec = promisify(execFile);
test('Git tools inspect repo and require approval for mutations', { skip: spawnSync('git', ['--version']).error ? 'git unavailable' : false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-git-test-'));
  try {
    await exec('git', ['init', '-b', 'main'], { cwd: root });
    await writeFile(path.join(root, 'file.txt'), 'hello');
    const approvals: string[] = [];
    const git = new GitTools(new Workspace(root), async request => { approvals.push(request.detail); return false; });
    assert.match(await git.run('status'), /file\.txt/);
    await assert.rejects(git.run('add', 'file.txt'), /rejected/);
    await assert.rejects(git.run('add', '../outside'), /escapes workspace/);
    assert.equal(approvals.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('approved Git stage and commit operate in the workspace without running hooks',
  { skip: spawnSync('git', ['--version']).error ? 'git unavailable' : false }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-git-mutation-test-'));
    try {
      await exec('git', ['init', '-b', 'main'], { cwd: root });
      await exec('git', ['config', 'user.name', 'HarnessX Test'], { cwd: root });
      await exec('git', ['config', 'user.email', 'harnessx@example.invalid'], { cwd: root });
      await writeFile(path.join(root, 'file.txt'), 'hello');
      const marker = path.join(root, 'hook-ran.txt');
      await mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
      await writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\nexit 1\n`);
      const approvals: string[] = [];
      const git = new GitTools(new Workspace(root), async request => { approvals.push(request.detail); return true; });
      await git.run('add', 'file.txt');
      await git.run('commit', 'test commit');
      assert.match(await git.run('log'), /test commit/);
      await assert.rejects(readFile(marker, 'utf8'), /ENOENT/);
      assert.equal(approvals.length, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
