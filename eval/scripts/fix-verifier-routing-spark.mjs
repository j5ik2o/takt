import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const evalDir = fileURLToPath(new URL('../', import.meta.url));
const suite = 'fix-verifier-routing-spark-direct';
const model = 'deepseek-v4.1-flash';
const fixture = join(evalDir, 'fixtures/fix-verifier-state-closure');
const preparedPrompt = join(evalDir, 'prompts/fix-verifier-state-routing.phase3.md');

function sparkEndpoint() {
  try {
    const url = new URL(process.env.TAKT_EVAL_SPARK_BASE_URL?.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    return url;
  } catch {
    throw new Error('Set TAKT_EVAL_SPARK_BASE_URL to the local Spark OpenAI-compatible API base URL (including /v1 if used).');
  }
}

async function fixtureContext() {
  const files = ['package.json'];
  for (const directory of ['src', 'reports-seed']) {
    const names = await readdir(join(fixture, directory), { recursive: true, withFileTypes: true });
    for (const entry of names) {
      if (entry.isFile()) files.push(relative(fixture, join(entry.parentPath, entry.name)));
    }
  }
  const sections = await Promise.all(files.sort().map(async path => {
    const contents = await readFile(join(fixture, path), 'utf8');
    const label = path.replaceAll('\\', '/').replace(/^reports-seed\//, '.takt/runs/eval/reports/');
    return `### ${label}\n\n${contents.trimEnd()}`;
  }));
  return `## Fixture files (supplied inline for direct API evaluation)\n\n${sections.join('\n\n')}`;
}

async function loadCase() {
  const template = await readFile(preparedPrompt, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Prepare the shared Phase 3 prompt first with node eval/scripts/prepare.mjs fix-verifier-state-routing (requires a build).');
  });
  const configDir = join(evalDir, 'agents/fix-verifier');
  const cases = parse(await readFile(join(evalDir, 'cases/fix-verifier-state-routing.yaml'), 'utf8'));
  if (cases.length !== 1 || !template.includes('{{scenario}}')
      || cases[0].assert?.length !== 1 || cases[0].assert[0].type !== 'regex') {
    throw new Error('The shared fix-verifier routing case must have one scenario and one regex assertion.');
  }
  const [test] = cases;
  const scenarioPath = resolve(configDir, test.vars.scenario.replace(/^file:\/\//, ''));
  const scenario = await readFile(scenarioPath, 'utf8');
  return {
    prompt: template,
    test: { ...test, vars: { scenario: `${scenario.trimEnd()}\n\n${await fixtureContext()}` } },
  };
}

function sparkProvider(endpoint) {
  const apiKey = process.env.TAKT_EVAL_SPARK_API_KEY?.trim();
  return {
    id: () => suite,
    async callApi(prompt) {
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
          signal: AbortSignal.timeout(180_000),
          redirect: 'manual',
        });
      } catch {
        return { error: 'Spark request failed (connection or timeout).' };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { error: `Spark returned HTTP ${response.status}.` };
      }
      let data;
      try {
        data = await response.json();
      } catch (error) {
        return { error: error instanceof SyntaxError ? 'Spark returned invalid JSON.' : 'Spark response read failed.' };
      }
      if (data?.model && data.model !== model) return { error: 'Spark reported a different model.' };
      const choice = Array.isArray(data?.choices) && data.choices.length === 1 ? data.choices[0] : undefined;
      const output = choice?.message?.content;
      if (data?.model !== model || data.error || choice?.finish_reason !== 'stop'
          || choice?.message?.role !== 'assistant' || choice.message.refusal
          || typeof output !== 'string' || !output.trim()) {
        return { error: 'Spark returned no usable completion.' };
      }
      return { output, metadata: { promptSha256: createHash('sha256').update(prompt).digest('hex') } };
    },
  };
}

async function main() {
  const endpoint = sparkEndpoint();
  const { prompt, test } = await loadCase();
  const provider = sparkProvider(endpoint);
  process.env.PROMPTFOO_DISABLE_TELEMETRY = '1';
  process.env.PROMPTFOO_DISABLE_UPDATE = '1';
  process.env.PROMPTFOO_DISABLE_SHARING = '1';
  const { evaluate } = await import('promptfoo');
  const started = Date.now();
  const evaluation = await evaluate({
    description: suite,
    prompts: [prompt],
    providers: [provider],
    tests: [test],
    sharing: false,
    writeLatestResults: false,
  }, { cache: false, maxConcurrency: 1, showProgressBar: false });

  const result = evaluation.results.length === 1 ? evaluation.results[0] : undefined;
  const passed = result?.gradingResult?.componentResults?.[0]?.pass;
  const error = result?.response?.error ?? (typeof passed === 'boolean' ? undefined : 'Promptfoo did not produce a grade.');
  const status = error ? 'ERROR' : passed ? 'PASS' : 'FAIL';
  const evidence = {
    suite, model, case: test.description, status, error,
    promptSha256: result?.response?.metadata?.promptSha256,
    tags: result?.response?.output?.match(/\[FIX-VERIFIER:[123]\]/g) ?? [],
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
  };
  const base = resolve('.tmp');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, `${suite}-`));
  const path = join(directory, 'summary.json');
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${status} ${suite}${error ? ` (${error})` : ''}\nEvidence: ${path}`);
  process.exitCode = error ? 2 : passed ? 0 : 1;
}

main().catch(error => {
  console.error(`ERROR ${suite}: ${error.message}`);
  process.exitCode = 2;
});
