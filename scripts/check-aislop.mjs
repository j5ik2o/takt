/**
 * aislop の scan が `scripts/aislop-accepted.json` と食い違えば落ちる（`npm run check:aislop`）。
 * 落ちるのは次のとき。一覧の engines のどれかが動かない（設定で外された、skipped）、
 * missingToolsAllowed に無い道具が見つからない、一覧にある指摘が出なくなった、
 * 一覧に無い warn 以上の指摘がある。
 * 指摘がエンジン 1 つ分すべて出なくなったときは、直したのではなく道具が動いていない疑いとして扱う。
 * 受入 0 件のエンジン（format）は一覧の engines から外している。aislop 0.20.1 の format は
 * biome.json が無いと biome を呼ばずに 0 件を返し（`runBiomeFormat` の短絡と catch）、
 * 停止しても稼働していても scan JSON は `{issues:0, skipped:false}` で同じ形になり、
 * elapsed も非 0 のままなので稼働を判定できない。そのため format の停止検出は行わず、
 * 受入 1 件以上のエンジン（lint・code-quality・ai-slop・security）で skipped・failed・
 * 未許可 missingTools・全滅を判定する。
 * そこで scan の前に、aislop の場所から oxlint・biome・knip を解決できるかを見て、できなければ道具の名前を挙げて落ちる。
 *
 * 一覧は `.aislop/` の baseline ではなく自前で持つ。項目ごとに理由も書けるようにするため。
 * 指摘はエンジン・規則・ファイル・文言で照合し、行番号は見ない（前後の行を足しても一覧を直さずに済むように）。
 *
 * aislop は devDependencies に版を固定して入れる。aislop は oxlint・biome・knip を自分の場所から解決するので、
 * npx のキャッシュや PATH の道具には左右されない。
 *
 * aislop は既定で利用統計を外へ送る。外への送信は承認が要るので、aislop を起動するときは AISLOP_ENV で止める。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCEPTED_PATH = fileURLToPath(new URL('./aislop-accepted.json', import.meta.url));
const ROOT = path.dirname(path.dirname(ACCEPTED_PATH));
export const AISLOP_CLI = path.join(ROOT, 'node_modules', 'aislop', 'dist', 'cli.js');
const GATED_SEVERITIES = new Set(['error', 'warning']);
const SCHEMA_VERSION = '1';

/** aislop が自分の場所から解決する道具と、aislop 自身が resolve に渡す指定子。 */
export const TOOL_SPECIFIERS = {
  oxlint: 'oxlint',
  '@biomejs/biome': '@biomejs/biome/package.json',
  knip: 'knip',
};

/** aislop の利用統計と更新の確認（npm registry への問い合わせ）を止める。 */
export const AISLOP_ENV = {
  AISLOP_NO_TELEMETRY: '1',
  AISLOP_NO_UPDATE_NOTIFIER: '1',
};

/**
 * 照合キーに使う前の文言正規化。aislop の一部の規則（`ai-slop/duplicate-import` など）は
 * メッセージに import 元の行番号（`on line N`）を埋め込む（node_modules/aislop/dist/cli.js の
 * `"${spec}" is also imported on line ${firstLine}.`）。行番号は照合キーに使わない方針
 * （order.md:18「行番号の変化で落ちない」）なので、この位置情報だけを固定文言へ置き換える。
 * `spec` や `file-too-large` の制限値（400/441 など）は位置情報ではないため残す。
 */
const normalizeMessage = (message) => message.replace(/ on line \d+/g, ' on line <line>');

const keyOf = ({ engine, rule, file, message }) =>
  `${engine}\0${rule}\0${file}\0${normalizeMessage(message)}`;

/**
 * 一覧（accepted の findings）と scan の diagnostics を突き合わせる。
 * キー（engine・rule・file・message）は行番号を使わない。
 * - unlisted: 一覧に無い warn 以上の指摘（キーが一覧に無い）。
 * - resolved: 一覧にあるのに scan に出なくなった指摘（キーが scan に無い）。
 * - countMismatches: 両方に同じキーがあるが、件数が一覧と scan で違うもの。
 *   同じキーの診断が 1 件だけ増減したとき、位置の違いで resolved/unlisted を誤発火させず、
 *   件数不一致として区別する。
 */
export function compareFindings(accepted, diagnostics) {
  const acceptedCounts = new Map();
  const acceptedByKey = new Map();
  for (const finding of accepted.flatMap((group) => group.findings)) {
    const key = keyOf(finding);
    acceptedCounts.set(key, (acceptedCounts.get(key) ?? 0) + 1);
    if (!acceptedByKey.has(key)) acceptedByKey.set(key, finding);
  }

  const scannedCounts = new Map();
  const scannedSample = new Map();
  const firstLine = new Map();
  for (const diagnostic of diagnostics) {
    if (!GATED_SEVERITIES.has(diagnostic.severity)) continue;
    const finding = {
      engine: diagnostic.engine,
      rule: diagnostic.rule,
      file: diagnostic.filePath,
      message: diagnostic.message,
    };
    const key = keyOf(finding);
    scannedCounts.set(key, (scannedCounts.get(key) ?? 0) + 1);
    if (!scannedSample.has(key)) scannedSample.set(key, finding);
    if (!firstLine.has(key)) firstLine.set(key, diagnostic.line);
  }

  const unlisted = [];
  for (const key of scannedCounts.keys()) {
    if (acceptedCounts.has(key)) continue;
    unlisted.push({ ...scannedSample.get(key), line: firstLine.get(key) });
  }
  const resolved = [];
  for (const [key] of acceptedCounts) {
    if (scannedCounts.has(key)) continue;
    resolved.push(acceptedByKey.get(key));
  }
  const countMismatches = [];
  for (const [key, acceptedCount] of acceptedCounts) {
    const scannedCount = scannedCounts.get(key);
    if (scannedCount === undefined || scannedCount === acceptedCount) continue;
    countMismatches.push({
      ...acceptedByKey.get(key),
      line: firstLine.get(key),
      acceptedCount,
      scannedCount,
    });
  }

  return { unlisted, resolved, countMismatches };
}

/** resolve で解決できない道具の名前を返す。 */
export function findUnresolvableTools(resolve) {
  return Object.entries(TOOL_SPECIFIERS)
    .filter(([, specifier]) => {
      try {
        resolve(specifier);
        return false;
      } catch {
        return true;
      }
    })
    .map(([name]) => name);
}

/**
 * 一覧の engines ごとに、動いていない疑いを調べる。外された、skipped、許していない道具が無い、
 * 一覧にあるそのエンジンの指摘が resolved にすべて入った、のどれか。問題ごとに { engine, reason } を返す。
 */
export function checkEngines(list, reportEngines, resolved) {
  const count = (findings, name) => findings.filter((f) => f.engine === name).length;
  const acceptedFindings = list.accepted.flatMap((group) => group.findings);
  const problems = [];
  for (const name of list.engines) {
    const engine = reportEngines[name];
    const listed = count(acceptedFindings, name);
    if (!engine) {
      problems.push({
        engine: name,
        reason: '動いていません（.aislop/config.yml などで外されていないか確かめてください）',
      });
    } else {
      if (engine.skipped) {
        problems.push({ engine: name, reason: 'skipped になりました' });
      }
      if (engine.failed) {
        problems.push({
          engine: name,
          reason: '実行に失敗しました（failed）。npm ci をやり直しても直らなければ、aislop の実行環境を確かめてください',
        });
      }
      for (const tool of engine.missingTools ?? []) {
        if (!Object.hasOwn(list.missingToolsAllowed, tool)) {
          problems.push({
            engine: name,
            reason: `道具 ${tool} が見つかりません（npm ci をやり直してください）`,
          });
        }
      }
    }
    if (listed > 0 && count(resolved, name) === listed) {
      problems.push({
        engine: name,
        reason: `一覧にある指摘 ${listed} 件がすべて出なくなりました。道具が動いていない疑いがあります（npm ci をやり直してください。やり直しても同じなら、本当に直ったのかもしれません。そのエンジンが別の指摘を出せることを確かめてから、一覧から消してください）`,
      });
    }
  }
  return problems;
}

/** scan の JSON が、このスクリプトの読める形かを見る。読めなければ理由を投げる。 */
export function assertReportShape(report) {
  const problems = [];
  if (report?.schemaVersion !== SCHEMA_VERSION) {
    problems.push(
      `schemaVersion が ${JSON.stringify(report?.schemaVersion)} です（このスクリプトが読めるのは ${SCHEMA_VERSION}）`,
    );
  }
  if (typeof report?.engines !== 'object' || report.engines === null) {
    problems.push('engines がありません');
  }
  if (!Array.isArray(report?.diagnostics)) {
    problems.push('diagnostics が配列ではありません');
  }
  if (problems.length > 0) {
    throw new Error(
      [
        `aislop scan --json の形が、このスクリプトの想定と違います（aislop@${report?.cliVersion}）。aislop の版を上げたなら、scripts/check-aislop.mjs を新しい形に合わせてください。`,
        ...problems.map((line) => `  ${line}`),
      ].join('\n'),
    );
  }
}

/** 一覧と scan の JSON から、落ちる理由を文の配列で返す。空なら通る。 */
export function checkReport(list, report) {
  const { unlisted, resolved, countMismatches } = compareFindings(list.accepted, report.diagnostics);
  const failures = [];
  const engineProblems = checkEngines(list, report.engines, resolved);
  const suspectEngines = new Set(engineProblems.map((problem) => problem.engine));
  if (engineProblems.length > 0) {
    failures.push(
      [
        `aislop のエンジンが動いていない疑いがあります（${engineProblems.length} 件）。動かないエンジンの指摘は出ないので、そのエンジンの分は一覧と照らせません。一覧から指摘を消さずに、エンジンが動くようにしてから実行し直してください。`,
        ...engineProblems.map((problem) => `  ${problem.engine}: ${problem.reason}`),
      ].join('\n'),
    );
  }
  if (unlisted.length > 0) {
    failures.push(
      [
        `scripts/aislop-accepted.json に無い warn 以上の指摘が ${unlisted.length} 件あります。`,
        ...unlisted.map(
          (f) => `  ${f.file}:${f.line}  ${f.engine}  ${f.rule}  ${f.message}`,
        ),
        '直すか、残す理由があるなら一覧の理由が合う群（無ければ新しい群）に engine・rule・file・message を足してください。',
        'aislop は作業ツリーをそのまま読むので、追跡していない手元のファイルの指摘も出ます。',
      ].join('\n'),
    );
  }
  const fixed = resolved.filter((f) => !suspectEngines.has(f.engine));
  if (fixed.length > 0) {
    failures.push(
      [
        `一覧にあるが出なくなった指摘が ${fixed.length} 件あります。直したのなら scripts/aislop-accepted.json から消してください（群が空になったら群ごと消す）。`,
        ...fixed.map((f) => `  ${f.file}  ${f.engine}  ${f.rule}  ${f.message}`),
      ].join('\n'),
    );
  }
  const mismatched = countMismatches.filter((f) => !suspectEngines.has(f.engine));
  if (mismatched.length > 0) {
    failures.push(
      [
        `一覧と scan で同じエンジン・規則・ファイル・文言の指摘の件数が一致しないものが ${mismatched.length} 件あります（行番号は見ていません）。`,
        ...mismatched.map(
          (f) =>
            `  ${f.file}  ${f.engine}  ${f.rule}  ${f.message}  一覧 ${f.acceptedCount} 件 / scan ${f.scannedCount} 件`,
        ),
        '増えたなら scripts/aislop-accepted.json に同じ数を足し、減ったなら一覧から同じ数だけ消してください（直したのなら一覧も更新する）。',
      ].join('\n'),
    );
  }
  return failures;
}

function scan() {
  const result = spawnSync(process.execPath, [AISLOP_CLI, 'scan', '--json'], {
    cwd: ROOT,
    env: { ...process.env, ...AISLOP_ENV },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`aislop を起動できませんでした: ${result.error.message}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `aislop scan --json の出力を読めませんでした（終了コード ${result.status}）。npm ci が済んでいるか確かめてください。\n${result.stderr}`,
    );
  }
  assertReportShape(report);
  return report;
}

function main() {
  const list = JSON.parse(readFileSync(ACCEPTED_PATH, 'utf8'));
  const { resolve } = createRequire(AISLOP_CLI);
  const unresolvable = findUnresolvableTools(resolve);
  if (unresolvable.length > 0) {
    throw new Error(
      `aislop の場所から道具を解決できません: ${unresolvable.join('、')}。解決できない道具は指摘 0 件で返ることがあるので、scan の前に落とします。npm ci をやり直してください。`,
    );
  }
  const report = scan();
  const failures = checkReport(list, report);
  if (failures.length === 0) {
    console.log(
      `aislop@${report.cliVersion} の warn 以上の指摘は、scripts/aislop-accepted.json と一致します。`,
    );
    return 0;
  }
  console.error(
    [
      ...failures,
      `aislop@${report.cliVersion}（oxlint・biome・knip の版は package-lock.json で決まります）。`,
    ].join('\n\n'),
  );
  return 1;
}

if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

/** 実パスで比べる。シンボリックリンク経由の実行でも entry guard を一致させる。 */
function realPath(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}
