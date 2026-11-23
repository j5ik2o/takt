import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

async function run(t, endpoint, apiKey = '', env = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'takt-spark-routing-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await new Promise((resolve, reject) => {
    execFile(process.execPath, [join(repo, 'eval/scripts/fix-verifier-routing-spark.mjs')], {
      cwd,
      env: { ...process.env, TAKT_EVAL_SPARK_BASE_URL: endpoint, TAKT_EVAL_SPARK_API_KEY: apiKey, ...env },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
  return result;
}

async function evidence(result) {
  const path = result.stdout.match(/^Evidence: (.+)$/m)?.[1];
  assert.ok(path, result.stdout);
  const contents = await readFile(path, 'utf8');
  assert.doesNotMatch(contents, /local-test-token|127\.0\.0\.1/);
  return JSON.parse(contents);
}

async function spark(t, reply) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method, path: request.url, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    reply(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

function completion(content, model = 'deepseek-v4.1-flash', finish = 'stop') {
  return JSON.stringify({ model, choices: [{ message: { role: 'assistant', content }, finish_reason: finish }] });
}

test('missing Spark configuration exits before evaluation', async (t) => {
  const result = await run(t, '');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /TAKT_EVAL_SPARK_BASE_URL/);
});

test('direct Spark request includes the shared case and fixture and uses the existing regex', async (t) => {
  const stub = await spark(t, response => response.end(completion('[FIX-VERIFIER:2]')));
  const result = await run(t, stub.url, 'local-test-token', { OPENAI_API_KEY: 'unused-external-key' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /PASS/);
  const summary = await evidence(result);
  assert.equal(summary.status, 'PASS');
  assert.deepEqual(summary.tags, ['[FIX-VERIFIER:2]']);
  assert.match(summary.promptSha256, /^[a-f0-9]{64}$/);
  assert.equal(stub.requests.length, 1);
  const [request] = stub.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.authorization, 'Bearer local-test-token');
  assert.equal(request.body.model, 'deepseek-v4.1-flash');
  const prompt = request.body.messages.map(message => message.content).join('\n');
  assert.match(prompt, /OBL-FAILED/);
  assert.match(prompt, /\[FIX-VERIFIER:2\]/);
  for (const file of [
    'package.json',
    'src/run-result.ts', 'src/dispatch-run-result.ts', 'src/terminal-summary.ts', 'src/progress-telemetry.ts',
    'reports-seed/00-review-target.md', 'reports-seed/review-resolution.md',
    'reports-seed/fix-plan.md', 'reports-seed/fix-report.md',
  ]) {
    const contents = await readFile(join(repo, 'eval/fixtures/fix-verifier-state-closure', file), 'utf8');
    assert.ok(prompt.includes(contents.trimEnd()), `missing contents of ${file}`);
  }
});

for (const [name, reply, exit, summary] of [
  ['wrong answer', res => res.end(completion('[FIX-VERIFIER:1]')), 1, /FAIL/],
  ['HTTP failure', res => res.writeHead(503).end('private diagnostic local-test-token'), 2, /HTTP 503/],
  ['broken transport', res => res.destroy(), 2, /request failed/],
  ['malformed JSON', res => res.end('<html>invalid</html>'), 2, /invalid JSON/],
  ['malformed choices', res => {
    const data = JSON.parse(completion('[FIX-VERIFIER:2]'));
    res.end(JSON.stringify({ ...data, choices: { 0: data.choices[0] } }));
  }, 2, /usable completion/],
  ['missing answer', res => res.end(completion(' ')), 2, /usable completion/],
  ['truncated answer', res => res.end(completion('[FIX-VERIFIER:2]', undefined, 'length')), 2, /usable completion/],
  ['different model', res => res.end(completion('[FIX-VERIFIER:2]', 'other-model')), 2, /different model/],
  ['redirect', res => res.writeHead(307, { Location: '/unexpected' }).end(), 2, /HTTP 307/],
]) {
  test(`classifies ${name}`, async (t) => {
    const stub = await spark(t, reply);
    const apiKey = name === 'HTTP failure' ? 'local-test-token' : '';
    const result = await run(t, stub.url, apiKey);
    assert.equal(result.code, exit, result.stderr);
    assert.match(result.stdout + result.stderr, summary);
    assert.doesNotMatch(result.stdout + result.stderr, /local-test-token|127\.0\.0\.1/);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].authorization, apiKey ? `Bearer ${apiKey}` : undefined);
    assert.equal((await evidence(result)).status, exit === 1 ? 'FAIL' : 'ERROR');
  });
}
