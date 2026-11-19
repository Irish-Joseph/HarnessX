import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from './workspace';
import { SessionStore } from './sessions';

test('workspace search, protected paths, edit and rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-workspace-test-'));
  try {
    await writeFile(path.join(root, 'code.ts'), 'export function greet() { return "hello" }\n');
    await writeFile(path.join(root, '.env'), 'SECRET=private');
    const workspace = new Workspace(root);
    assert.equal((await workspace.search('greet'))[0].path, 'code.ts');
    assert.ok(!(await workspace.files()).includes('.env'));
    await assert.rejects(workspace.read('.env'), /Protected path/);
    await assert.rejects(workspace.read('../outside'), /escapes workspace/);
    await workspace.edit('code.ts', 'export const answer = 42;\n');
    assert.match(await readFile(path.join(root, 'code.ts'), 'utf8'), /answer/);
    await workspace.rollback();
    assert.match(await readFile(path.join(root, 'code.ts'), 'utf8'), /greet/);
    await workspace.edit('new.ts', 'new file');
    await workspace.rollback();
    await assert.rejects(readFile(path.join(root, 'new.ts')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('session persists messages and usage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-session-test-'));
  try {
    const store = new SessionStore(root);
    const session = store.create('ask');
    session.messages.push({ role: 'user', content: 'hello' });
    session.usage.inputTokens = 10;
    await store.save(session);
    assert.deepEqual((await store.load(session.id)).messages, session.messages);
    assert.equal((await store.list())[0].usage.inputTokens, 10);
    await assert.rejects(store.load('../bad'), /Invalid session ID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('semantic search ranks embeddings and reuses cached file vectors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-semantic-test-'));
  try {
    await writeFile(path.join(root, 'alpha.ts'), 'export function login() { return true }');
    await writeFile(path.join(root, 'beta.ts'), 'export function renderButton() { return false }');
    const workspace = new Workspace(root);
    let calls = 0;
    const embedder = { embed: async (_model: string, inputs: string[]) => {
      calls++;
      return inputs.map(input => /login|auth/i.test(input) ? [1, 0] : [0, 1]);
    } };
    const first = await workspace.semanticSearch('authentication', embedder, 'embedding-model');
    assert.equal(first[0].path, 'alpha.ts');
    await workspace.semanticSearch('authentication', embedder, 'embedding-model');
    assert.equal(calls, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rollback survives a new Workspace instance and refuses overwritten files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-history-test-'));
  const history = await mkdtemp(path.join(os.tmpdir(), 'harnessx-history-store-'));
  try {
    await writeFile(path.join(root, 'file.ts'), 'before');
    await new Workspace(root, history).edit('file.ts', 'after');
    const restarted = new Workspace(root, history);
    await writeFile(path.join(root, 'file.ts'), 'user change');
    await assert.rejects(restarted.rollback(), /changed since edit/);
    await writeFile(path.join(root, 'file.ts'), 'after');
    await restarted.rollback();
    assert.equal(await readFile(path.join(root, 'file.ts'), 'utf8'), 'before');
  } finally { await rm(root, { recursive: true, force: true }); await rm(history, { recursive: true, force: true }); }
});
