import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OllamaProvider, OpenAICompatibleProvider } from './providers';

test('Ollama discovery and streaming chat use real HTTP protocol', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/api/tags') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:1.5b' }, { name: 'all-minilm:latest' }] })); return;
    }
    if (request.url === '/api/embed') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ embeddings: [[1, 0]] })); return;
    }
    if (request.url === '/api/show') {
      let body = '';
      request.on('data', chunk => body += chunk.toString('utf8'));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ capabilities: JSON.parse(body).model === 'all-minilm:latest' ? ['embedding'] : ['completion', 'tools'] }));
      });
      return;
    }
    if (request.url === '/api/chat') {
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(JSON.stringify({ message: { content: 'Hel' } }) + '\n');
      response.end(JSON.stringify({ message: { content: 'lo' }, prompt_eval_count: 7, eval_count: 2 }) + '\n'); return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
    const provider = new OllamaProvider(`http://127.0.0.1:${address.port}`);
    const [model, embeddingOnly] = await provider.listModels();
    assert.equal(model.available, true);
    assert.equal(embeddingOnly.available, false);
    let tokens = '';
    const result = await provider.chat({ model, messages: [{ role: 'user', content: 'hello' }], onToken: value => tokens += value });
    assert.equal(result.text, 'Hello'); assert.equal(tokens, 'Hello');
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2 });
    assert.deepEqual(await provider.embed(model.id, ['hello']), [[1, 0]]);
  } finally { server.close(); await once(server, 'close'); }
});
test('OpenAI-compatible SSE streaming and auth', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/v1/embeddings') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [0, 1] }] })); return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    response.setHeader('content-type', 'text/event-stream');
    response.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":" two"}}]}\n\n');
    response.end('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, [{ id: 'qwen' }], 'test-key');
    const [model] = await provider.listModels();
    const result = await provider.chat({ model, messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(result.text, 'one two');
    assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2 });
    assert.deepEqual(await provider.embed('qwen', ['hello']), [[0, 1]]);
  } finally { server.close(); await once(server, 'close'); }
});
test('remote compatible models require explicit prices before routing', async () => {
  const provider = new OpenAICompatibleProvider('https://example.com/v1', [{ id: 'paid-unknown' },
    { id: 'priced', inputCostPerMillion: 1, outputCostPerMillion: 2 }]);
  const models = await provider.listModels();
  assert.equal(models[0].available, false);
  assert.equal(models[1].available, true);
});
