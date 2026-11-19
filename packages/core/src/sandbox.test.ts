import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DockerSandbox } from './sandbox';

test('Docker sandbox is isolated and requires approval', { skip: process.env.HARNESSX_TEST_DOCKER !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessx-sandbox-test-'));
  try {
    await writeFile(path.join(root, 'input.txt'), 'original');
    await writeFile(path.join(root, '.env'), 'SECRET=private');
    const sandbox = new DockerSandbox(root, { timeoutMs: 90_000 });
    await assert.rejects(sandbox.run('echo should-not-run', async () => false), /rejected/);
    const result = await sandbox.run('test ! -f .env && cat input.txt && echo changed > input.txt && node --version', async () => true);
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /original/);
    assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
  } finally { await rm(root, { recursive: true, force: true }); }
});
