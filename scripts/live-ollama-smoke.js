const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Harness, OllamaProvider, Workspace, DockerSandbox, SessionStore } = require('../packages/core/dist');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnessx-live-smoke-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'harnessx-live-sessions-'));
  try {
    await fs.writeFile(path.join(root, 'answer.js'), 'module.exports = 1;\n');
    await fs.writeFile(path.join(root, 'answer.test.js'),
      'const test = require("node:test"); const assert = require("node:assert/strict"); test("answer", () => assert.equal(require("./answer"), 2));\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'harnessx-live-smoke', version: '1.0.0',
      scripts: { test: 'node --test' } }, null, 2));
    const provider = new OllamaProvider(process.env.HARNESSX_OLLAMA_URL || 'http://127.0.0.1:11434');
    const models = await provider.listModels();
    const modelId = process.env.HARNESSX_LIVE_MODEL || models.find(model => /qwen.*coder/i.test(model.id))?.id;
    if (!modelId || !models.some(model => model.id === modelId)) throw new Error('Requested Ollama model is not installed');
    const workspace = new Workspace(root);
    const sessions = new SessionStore(storage);
    const approve = async request => {
      const allowed = request.kind === 'edit' ? request.path?.replace(/^\.\//, '') === 'answer.js' &&
        /^module\.exports\s*=\s*2;?\s*$/.test(request.after ?? '') :
        request.detail === 'npm test';
      console.log(`approval ${request.kind}: ${request.path ?? request.detail} ${request.kind === 'edit' ? JSON.stringify((request.after ?? '').slice(0, 100)) : ''} => ${allowed}`);
      return allowed;
    };
    const harness = new Harness([provider], workspace, new DockerSandbox(root, { timeoutMs: 30_000 }), sessions, approve);
    const ask = await harness.run(sessions.create('ask'), { mode: 'ask', prompt: 'Reply with exactly PONG and nothing else.',
      modelId, maxUsd: 0, maxSteps: 1 });
    assert.equal(ask.answer.trim(), 'PONG');
    const plan = await harness.run(sessions.create('plan'), { mode: 'plan',
      prompt: 'Plan how to make answer.test.js pass by changing answer.js.', modelId, maxUsd: 0, maxSteps: 1 });
    assert.ok(plan.answer.trim());
    assert.match(plan.answer, /answer\.js/);
    assert.match(plan.answer, /npm test/);
    assert.doesNotMatch(plan.answer, /invented|missing|foo\.js/i);
    const agent = await harness.run(sessions.create('agent'), { mode: 'agent',
      prompt: 'In the repository root, change only answer.js to exactly `module.exports = 2;` so answer.test.js passes. Read answer.js and answer.test.js, edit answer.js, run npm test, and report the result. Do not use a src/ path.',
      modelId, maxUsd: 0, maxSteps: 8, onProgress: event => process.stdout.write(`step ${event.step}: ${event.message}\n`) });
    console.log(JSON.stringify({ actions: agent.session.actions.map(action => ({ kind: action.kind, detail: action.detail.slice(0, 300), approved: action.approved })),
      result: agent.answer, file: await fs.readFile(path.join(root, 'answer.js'), 'utf8') }));
    assert.match(await fs.readFile(path.join(root, 'answer.js'), 'utf8'), /module\.exports\s*=\s*2/);
    const successfulTest = agent.session.messages.filter(message => message.role === 'tool').some(message => {
      try { return JSON.parse(message.content).exitCode === 0; } catch { return false; }
    });
    assert.ok(successfulTest || /Automatic verification passed/.test(agent.answer), 'Agent did not pass sandboxed verification');
    console.log(JSON.stringify({ model: modelId, ask: ask.answer, plan: plan.answer.slice(0, 160),
      agent: agent.answer, actions: agent.session.actions.map(action => action.kind), usage: agent.session.usage }));
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
