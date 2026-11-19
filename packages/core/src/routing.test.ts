import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { compactMessages, routeModels } from './routing';
import { Model } from './types';

const local: Model = { id: 'local', provider: 'ollama', contextTokens: 8192, maxOutputTokens: 1024,
  inputCostPerMillion: 0, outputCostPerMillion: 0, speed: 5, capability: 3, available: true };
const paid: Model = { ...local, id: 'paid', provider: 'remote', capability: 5,
  inputCostPerMillion: 2, outputCostPerMillion: 2 };
test('routing respects zero budget and preferred model', () => {
  const messages = [{ role: 'user' as const, content: 'debug code' }];
  assert.deepEqual(routeModels([paid, local], messages, 0).map(m => m.id), ['local']);
  assert.equal(routeModels([paid, local], messages, 1, 'paid')[0].id, 'paid');
});
test('routing rejects models with inadequate context', () => {
  assert.deepEqual(routeModels([{ ...local, contextTokens: 64 }], [{ role: 'user', content: 'hello' }], 0), []);
});
test('complex tasks prefer a more capable local model', () => {
  const small = { ...local, id: 'qwen:0.5b', capability: 2, speed: 5 };
  const larger = { ...local, id: 'qwen:1.5b', capability: 3, speed: 4 };
  assert.equal(routeModels([small, larger], [{ role: 'user', content: 'Fix code' }], 0, undefined, 5)[0].id, larger.id);
});
test('context compaction retains latest conversation', () => {
  const messages = [{ role: 'system' as const, content: 'rules' }, ...Array.from({ length: 10 }, (_, n) => ({ role: 'user' as const, content: `${n} ${'x'.repeat(80)}` }))];
  const compact = compactMessages(messages, 160);
  assert.equal(compact[0].content, 'rules');
  assert.equal(compact.at(-1)?.content, messages.at(-1)?.content);
  assert.ok(compact.length < messages.length);
});
test('routing accepts long history after context compaction', () => {
  const messages = [{ role: 'system' as const, content: 'rules' },
    ...Array.from({ length: 30 }, () => ({ role: 'user' as const, content: 'x'.repeat(300) })),
    { role: 'user' as const, content: 'latest request' }];
  assert.equal(routeModels([{ ...local, contextTokens: 512, maxOutputTokens: 128 }], messages, 0).length, 1);
});
