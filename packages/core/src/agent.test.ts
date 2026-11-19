import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from './agent';
import { DockerSandbox } from './sandbox';
import { SessionStore } from './sessions';
import { Workspace } from './workspace';
import { Approve, ChatRequest, ChatResult, Model, Provider } from './types';

const model: Model = { id: 'test-model', provider: 'scripted', contextTokens: 8192, maxOutputTokens: 512,
  inputCostPerMillion: 0, outputCostPerMillion: 0, speed: 3, capability: 3, available: true };
class ScriptedProvider implements Provider {
  id = 'scripted';
  constructor(private readonly answers: string[]) {}
  async listModels(): Promise<Model[]> { return [model]; }
  async chat(request: ChatRequest): Promise<ChatResult> {
    assert.ok(request.messages.every(message => message.role !== 'tool'));
    const text = this.answers.shift(); if (text === undefined) throw new Error('No scripted answer');
    request.onToken?.(text);
    return { text, model: model.id, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}
test('agent inspects, requests edit approval, edits, and persists session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-agent-test-'));
  try {
    await writeFile(path.join(root, 'hello.txt'), 'old');
    const store = new SessionStore(path.join(root, 'sessions'));
    const approvals: string[] = [];
    const harness = new Harness([new ScriptedProvider([
      '{"tool":"read","args":{"path":"hello.txt"}}',
      '{"tool":"edit","args":{"path":"hello.txt","content":"new"}}',
      '{"tool":"finish","args":{"answer":"Updated hello.txt"}}'
    ])], new Workspace(root), new DockerSandbox(root), store, async request => { approvals.push(request.kind); return true; });
    const session = store.create('agent');
    const result = await harness.run(session, { mode: 'agent', prompt: 'Update hello.txt', maxSteps: 5, maxUsd: 0 });
    assert.match(result.answer, /^Updated hello\.txt/);
    assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'new');
    assert.deepEqual(approvals, ['edit']);
    assert.equal((await store.load(session.id)).actions.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Ask streams response without tool execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-ask-test-'));
  try {
    let stream = '';
    const store = new SessionStore(path.join(root, 'sessions'));
    const harness = new Harness([new ScriptedProvider(['hello'])], new Workspace(root), new DockerSandbox(root), store,
      async () => { throw new Error('Approval was not expected'); });
    const result = await harness.run(store.create('ask'), { mode: 'ask', prompt: 'Say hello', maxSteps: 1, maxUsd: 0, onToken: token => stream += token });
    assert.equal(result.answer, 'hello'); assert.equal(stream, 'hello');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Plan uses only validated repository paths and observed code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-plan-test-'));
  try {
    await writeFile(path.join(root, 'answer.js'), 'module.exports = 1;\n');
    await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
    const store = new SessionStore(path.join(root, 'sessions'));
    let selectedSchema: unknown;
    const provider: Provider = { id: 'scripted', listModels: async () => [model], chat: async request => {
      selectedSchema = request.formatSchema;
      return { text: '{"paths":["answer.js","invented.js"]}', model: model.id,
        usage: { inputTokens: 10, outputTokens: 10 } };
    } };
    const harness = new Harness([provider], new Workspace(root), new DockerSandbox(root), store,
      async () => { throw new Error('Plan should not request approval'); });
    const result = await harness.run(store.create('plan'), { mode: 'plan', prompt: 'Fix answer.js', maxSteps: 1, maxUsd: 0 });
    assert.ok(selectedSchema);
    assert.match(result.answer, /answer\.js/);
    assert.match(result.answer, /npm test/);
    assert.doesNotMatch(result.answer, /invented\.js/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('agent rejects placeholder edits before approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-placeholder-test-'));
  try {
    await writeFile(path.join(root, 'answer.js'), 'module.exports = 1;');
    const store = new SessionStore(path.join(root, 'sessions'));
    const harness = new Harness([new ScriptedProvider([
      '{"tool":"edit","args":{"path":"answer.js","content":"<tool_response>"}}',
      '{"tool":"finish","args":{"answer":"Could not edit"}}'
    ])], new Workspace(root), new DockerSandbox(root), store, async () => { throw new Error('Unexpected approval'); });
    await harness.run(store.create('agent'), { mode: 'agent', prompt: 'Edit answer.js', maxUsd: 0, maxSteps: 2 });
    assert.equal(await readFile(path.join(root, 'answer.js'), 'utf8'), 'module.exports = 1;');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('agent summarizes successful automatic verification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-verification-test-'));
  try {
    await writeFile(path.join(root, 'answer.js'), 'module.exports = 1;');
    await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
    const store = new SessionStore(path.join(root, 'sessions'));
    class PassingSandbox extends DockerSandbox {
      override async run(command: string, approve: Approve) {
        assert.equal(command, 'npm test');
        assert.equal(await approve({ kind: 'command', title: 'Verify', detail: command }), true);
        return { command, exitCode: 0, output: 'passed', durationMs: 1, truncated: false };
      }
    }
    const harness = new Harness([new ScriptedProvider([
      '{"tool":"edit","args":{"path":"answer.js","content":"module.exports = 2;"}}',
      '{"tool":"finish","args":{"answer":""}}'
    ])], new Workspace(root), new PassingSandbox(root), store, async () => true);
    const result = await harness.run(store.create('agent'), { mode: 'agent', prompt: 'Fix answer.js', maxUsd: 0, maxSteps: 2 });
    assert.match(result.answer, /Edited answer\.js/);
    assert.match(result.answer, /verification passed/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('harness switches models after a provider fails before streaming', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-fallback-test-'));
  try {
    let attempts = 0;
    const failing: Provider = { id: 'failing', listModels: async () => [{ ...model, id: 'fast', provider: 'failing', speed: 5 }],
      chat: async () => { attempts++; throw new Error('Service unavailable'); } };
    const working: Provider = { id: 'working', listModels: async () => [{ ...model, id: 'backup', provider: 'working', speed: 2 }],
      chat: async () => ({ model: 'backup', text: 'Recovered', usage: { inputTokens: 2, outputTokens: 2 } }) };
    const store = new SessionStore(path.join(root, 'sessions'));
    const harness = new Harness([failing, working], new Workspace(root), new DockerSandbox(root), store, async () => false);
    const result = await harness.run(store.create('ask'), { mode: 'ask', prompt: 'Help', maxUsd: 0, maxSteps: 1 });
    assert.equal(result.answer, 'Recovered');
    assert.equal(attempts, 2);
    assert.deepEqual(result.modelIds, ['working/backup']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
