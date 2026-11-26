# workflow_call が解決できないときのエラーと run の記録（項目327）

PR: [j5ik2o/takt#167](https://github.com/j5ik2o/takt/pull/167)（マージ済み `3040bcd0f`）および追いの PR（後追い設計レビューの指摘対応）。

## 変えたこと

1. **エラーの中身**: `prepareWorkflowExecutionBundle` で resolver が `null` を返したとき、`Workflow bundle could not resolve call "<workflow>/<step>" (call: …; cwd: …; project: …; searched: …; excluded: …)` を投げる。
   - named の呼び出し: `searched` に project・user の候補パス、`excluded` に builtin の候補と外した理由（`enable_builtin_workflows is false` または `disabled_builtins lists "<name>"`、同名の builtin があるか）。
   - scope（`@…`）: 「installed repertoire packages」とだけ書く。path: 基点のディレクトリを書く。
   - 1行にまとめる（terminal 出力は改行を `\n` にエスケープするため）。
   - 説明は `explainNamedWorkflowLookup`（`workflowLookupDirectories.ts`）が、実際の探索 `getNamedWorkflowLookupDirs` と共通の検索計画 `buildNamedWorkflowLookupPlan` から作る。
2. **記録の順序**: `prepareWorkflowExecutionBundle` を `beginRun` の後、既存の bootstrap の `try` の中へ移した。失敗は `terminalizeBootstrapFailure` を通り、`meta.json`（`status: failed`、`reason`）と logs が残る。central 実行の資格情報チェック（`assertCentralWorkflowBundleCredentialSafety`）も同じ経路になる。
3. **doctor の偽陰性**: `validateWorkflowCallContracts` に `onUnresolvedCall` を足した。`inspectWorkflowFile`（doctor と inspect が使う）だけが渡し、named・scope の呼び出しが解決できなければエラーにする。先に `resolveWorkflowCallTarget` を通し、不正な識別子（`a//b`）は既存のメッセージを優先する。
4. docs（configuration の en/ja/zh-CN、testing/e2e.md）に、外した builtin を `workflow_call` で呼ぶと失敗し、doctor と実行時に理由が出ることを書いた。

### 範囲の外（変えていない）

- builtin を外したときに自動で探し直す・builtin を例外的に許す、といった解決の規則そのもの。
- path 呼び出し（`./x.yaml`）の doctor での扱い（従来どおり飛ばす）。
- `resolveTask`・`providerPreflight`・`taskRetryStartPath` など、ほかの箇所の `null` の扱い。
- `beginRun` 自体が失敗したときの記録。
- `beginRun` 前の `resolveAvailableSourceLineage` が `OperationLineageUnavailableError` 以外の `OperationRecoveryError`（不正な slug・祖先循環・別 journal）を投げたときの挙動（PR #167 以前からの既存挙動であり、ディレクトリ・`meta.json` は作られない）。

## 守る不変条件

- `beginRun` 直後は空の run ディレクトリ予約のみで、`meta.json` と logs はまだ作られない（正常系は `createWorkflowExecutionBootstrap`、異常系は `terminalizeBootstrapFailure` で作成する）。
- 準備（呼び出しの解決を含む）・pre-meta bootstrap・実行に失敗した run は、終端書き込みが成功した場合に `meta.json`（`failed`）と logs（開始・終了の記録）を残す（`terminalizeBootstrapFailure` の 2 段階書き込みや `fileWorkflowRunTerminalPublisher` での `meta.json` 更新〜`workflow_abort` 追記の途中に I/O 失敗・強制停止が起きた場合は部分書き込みになり得て、下の対象外に含む）。
- 解決できない呼び出しの理由には、呼び出し名・cwd・探した候補・外した候補と理由が入る。
- 準備と bootstrap が済むまで、ステップは1つも動かない。
- 終わった run の `meta.json` が `running` のまま残らない。
- 成功で終わった run の `meta.json` は `completed` になり、失敗記録や探索失敗理由を残さない。
- 1 つの run について、初期 `meta.json` 公開・`workflow_start`・終端ログ・`activeRun.finish` が二重にならない（ただし既存の `initNdjsonLog` 実行後 bootstrap 失敗時の二重追記は別件）。
- resume した 2 試行目の run は再開元とは別の slug を持ち、再開元の operation lineage が取得できるとき（`publishedResumeSource` があるとき）は準備・bootstrap 失敗時を含め終了時に `source_run_slug` を記録する。再開元の operation lineage が取得できないとき（`OperationLineageUnavailableError` フォールバック時）は新しい journal を開始し、`meta.json` に `source_run_slug` を書かない。いずれの場合も再開元 run の `meta.json` と logs を改変しない（operation journal は系譜の `operationJournalRunSlug` へ共有して追記する）。
- `reports/` を持たない run（準備や pre-meta bootstrap で失敗した 0 ステップ run など）から resume した場合、`inheritResumeReportSnapshot` が失敗するためステップ実行・完了へ進まず、`terminalizeBootstrapFailure` で `failed` 記録を残して終了する（既存の挙動。0 ステップ失敗 run からの `requeueTask` 等の見直しは別件）。
- 説明の builtin の扱いは、実際の探索と一致する（探した側か外した側のどちらか一方にだけ出る）。
- doctor が `Workflow OK` と出した workflow は、named・scope の呼び出しがすべて解決できる。

## Quint

`specs/quint/run-start-record/`（`runStartRecord.qnt`・`beginFirst.qnt`・`prepareFirst.qnt`・`runStartRecord_test.qnt`・`README.md`）。

- 実コードに合わせて `beginRun` は空ディレクトリ予約のみとし、準備後の再開元 `reports/` 継承（`inheritResumeReports`）・pre-meta bootstrap 失敗（再開元に `reports/` がある場合の `validateWorkflowReportReferences` 等による継承前失敗、`inheritResumeReportSnapshot` での `reports/` 欠如、および継承後の `publishRunMeta` 前失敗を含む）・正常系 `createWorkflowExecutionBootstrap`（`bootDone` 設定）・異常系 `terminalizeBootstrapFailure`（`publishRunMeta` + `initNdjsonLog` → `activeRun.finish` の 2 段階）をモデル化した。
- 成功終了（`MetaCompleted`・`LogComplete`）・実行失敗（`ExecFailed`・`LogAbort`）・失敗 run からの 2 試行目 resume（`RUN_1` → `RUN_2`、lineage 取得可否 `lineageAvailable` の分岐と再開元 `hasReports` による `inheritResumeReportSnapshot` 成否、継承前の pre-meta 失敗および継承後の pre-meta 失敗時の `hasReports` 保持を含む）を表現し、9 つの不変条件（`failureIsRecorded`, `unresolvedReasonExplains`, `noStepWithoutBundle`, `noRunningAfterExit`, `beginRunLeavesNoRecordYet`, `noFailureOnSuccess`, `noDuplicateRecords`, `resumePreservesIntegrity`, `noResumeCompletionWithoutSourceReports`）と 11 個の到達性 witness を定義した。
- 2 試行 resume の最長非 stutter 経路が 12 ステップのため `--max-steps 16` で検査した。
  - `quint test runStartRecord_test.qnt --main beginFirstTest`: 10 passing
  - `quint test runStartRecord_test.qnt --main prepareFirstTest`: 2 passing
  - `quint run beginFirst.qnt --main beginFirst --invariant invariant --witnesses ... --max-steps 16 --max-samples 10000`: 違反なし。全 11 witness が到達（到達割合は seed 依存。例: `--seed=0x2e8b1bddb2e882f3` で 0.70%〜46.21%）。
  - `quint run prepareFirst.qnt --main prepareFirst --invariant <条件> --max-steps 16 --max-samples 10000`（`<条件>` に `failureIsRecorded`・`unresolvedReasonExplains`・`resumePreservesIntegrity` を個別に指定。再現コマンドは `specs/quint/run-start-record/README.md` 参照）: 3 つとも期待どおり違反。
- モデル対象外（`README.md` に明記）: `beginRun` 前の `resolveAvailableSourceLineage` での `OperationRecoveryError`、`beginRun` 自体の失敗（`resolveRunSlug` の同 slug 例外を含む）、終端書き込み途中の I/O 失敗／強制停止（`terminalizeBootstrapFailure` の 2 段階書き込み途中、および `fileWorkflowRunTerminalPublisher` での `meta.json` 更新と `workflow_abort` 追記の間の部分書き込み）、`createWorkflowExecutionBootstrap` 内で `initNdjsonLog` 実行後に失敗した際の `workflow_start` 二重追記、`createWorkflowExecutionBootstrap` 成功後・`WorkflowEngine` が `reports/` を作る前の実行失敗、利用者の中断（Ctrl+C・入力キャンセルによる `meta.json` の `status: aborted`）、operation journal の系譜共有追記、並行 run の slug 競合（実装では `mkdirSync` + `EEXIST` リトライ）。

## 性質のテスト（PBT）

このブランチには fast-check が無い（#160 の revert で外れた）ため、乱択ではなく全組み合わせを流す表のテストにした（`workflow-doctor.test.ts` の `named workflow lookup explanation agrees with the lookup`）。

- 入力の集合: `enable_builtin_workflows` ∈ {未設定, true, false} × `disabled_builtins` に名前が ∈ {無い, ある} × 名前 ∈ {同名の builtin がある, 無い} × project に写しが ∈ {無い, ある}（24 通り、全部）。
- 性質: builtin は `searched` と `excluded` のどちらか一方にだけ出る／外したときの理由が設定と合う／project・user の候補は常にこの順で出る／実際の探索（`findWorkflowInLookupDirs`）の結果が説明と合う。
- 除外: なし。

## 壊しうる入力

- 境界: builtin の全体無効と個別無効が両方ある（全体無効の理由を優先して1件だけ出す）。
- 入れ子: 呼び出し先のさらに先の呼び出しが解決できない（bundle も doctor も再帰で同じ扱い）。
- 区切り: 不正な識別子 `a//b`・`..`（既存の識別子エラーが先に出る）。
- `{$param}` の呼び出し: callable を単体で診断すると、既定値の無い `workflow_ref` には discovery 読み込みが仮名（`__takt_discovery_workflow_ref___<param>`）を入れる。doctor は仮名の呼び出しを飛ばす（Devin の指摘で直した）。既定値がある `workflow_ref` は実名なので確かめる。
- 長さ・Unicode: パスや名前はそのまま連結するだけで、`meta.json`・NDJSON・CLI 出力では切り詰めない。terminal ではエスケープされる。`task_finish_hook` に渡す `TAKT_FINISH_FAILURE_REASON` のみ 4096 文字で切り詰める（`taskFinishHook.ts` の `MAX_FAILURE_REASON_CHARS`）。`takt-dash` のログ末尾表示の `sanitize` は 512 文字で丸める（仕様どおり、`meta.json` には全文が残る）。
- 並行・再開: 並行 run の slug 衝突は `reserveRunDirectory` の `mkdirSync` + `EEXIST` リトライ（`requestedRunSlug` 固定時は即時例外）で防ぐ。再開（`resumeSource`）の run でも順序は同じで、再開元の operation lineage が取れる場合は `prepareWorkflowExecutionBundle` 失敗時にも `meta.json` に `source_run_slug` と `operation_journal_run_slug` / `operation_claim_token` が残り、lineage が取れない場合（`OperationLineageUnavailableError` フォールバック）は新しい journal を始めて `source_run_slug` を書かない。再開元の `meta.json` と logs は改変されない（operation journal は系譜で共有して追記される）。また、`reports/` を持たない run（準備失敗 run など）からの再開は `inheritResumeReportSnapshot` で失敗する。
- `.yml` だけがある場合: 候補は `.yaml (or .yml)` と書く。

## 影響

- 上流（nrslib/takt）: 該当しない（フォークの `integration/takt-mcp` にだけ出す）。
- 保存済みデータ: 新しい形式は足さない。`prepareWorkflowExecutionBundle` 失敗（および central 実行の資格情報拒否）時にも既存形式の確定済み run 記録（`.takt/runs/<slug>/meta.json`、`logs/<sessionId>.jsonl` の `workflow_start` + `workflow_abort`）が生成され、`.takt/runs/` に失敗 run が増える。`trace.md` は `fileWorkflowRunTerminalPublisher` が `meta.json` の確定と `workflow_abort` 追記の後に別途生成する付随ファイルであり、生成や書き込みに失敗した場合は `RunProjectionError` が記録されて `trace.md` が残らないことがある（確定済みの `meta.json` とログは残る）。worktree 実行時は付随記録として `projectCwd/.takt/runs/<slug>/interventions.jsonl` に `terminal: failed` も記録される。`takt-dash` と Web UI は `status: "failed"`, `iterations: 0`, `workflow-bundle` なしの既存形式として安全に読める。
- 公開の設定・API: 設定キーは変えない。CLI のエラー文言が長くなり、doctor が以前 OK と出していた workflow をエラーにする（実行は以前から失敗していた）。
- `task_finish_hook`（`src/features/tasks/execute/taskFinishHook.ts`）: 発火回数（1 回）と `TAKT_FINISH_STATUS=failed` は変わらないが、次の 2 点が変わる。
  1. `TAKT_FINISH_RUN_DIR`: 以前は `prepareWorkflowExecutionBundle` 失敗時に `.takt/runs/<runSlug>` が存在せず未設定だったが、[j5ik2o/takt#167](https://github.com/j5ik2o/takt/pull/167) 後はディレクトリが作られるため設定されるようになる。
  2. `TAKT_FINISH_FAILURE_REASON`: `call:` / `cwd:` / `project:` / `searched:` / `excluded:` を含む長い 1 行メッセージになる（4096 文字上限で切り詰め）。
- `loop_analysis`（`src/features/tasks/execute/workflowExecution.ts`・`loopAnalysis.ts`）: `loop_analysis.enabled: true` かつ `goalId` なし・非 central（`loopAnalysisScheduler` が渡る構成）の場合、`prepareWorkflowExecutionBundle` 失敗でも `terminalizeBootstrapFailure` 末尾の `scheduleLoopAnalysis` が呼ばれ、0 ステップの bootstrap 失敗でもバックグラウンドワーカーが起動する副作用がある（0 ステップ失敗で回すべきかの見直しは別件）。
- 守りの仕組み: central 実行の資格情報チェックは判定を変えず、`beginRun` の後に動くだけ。拒否されたときも `meta.json` に残るのはパスと理由で、資格情報の値は書かない。

---

## 追いの PR の設計（後追い設計レビューの指摘対応）

[j5ik2o/takt#167](https://github.com/j5ik2o/takt/pull/167) の後追い設計レビュー（1回目・2回目）で挙がった指摘（テストの穴・Quint 仕様の修正・設計書の影響追記）を閉じる追いの PR。

### 何をどう変えるか

1. **単体テストの追加（`src/__tests__/workflow-execution-canonical.test.ts`）**:
   - **順序と bootstrap 失敗終端化（M1 / M1b / M3 対策）**: `createWorkflowRunLifecycle` の `beginRun` と `prepareWorkflowExecutionBundle` の呼び出し順を記録しつつ、`prepareWorkflowExecutionBundle` が未解決 `workflow_call` のエラーを投げたときに、(a) `beginRun` → `prepareWorkflowExecutionBundle` の順に呼ばれること、(b) 元のエラーで reject されること、(c) `WorkflowEngine` が呼ばれないこと、(d) `initNdjsonLog` が呼ばれること、(e) `mockProjectTerminal` が `status: 'failed'`, `iterations: 0`, かつ探索理由を含む `reason` で呼ばれることを検証する。
   - **resume 準備失敗時の系譜保持（M4 対策）**: `RunMetaManager` モックの constructor 引数を記録し、`workflow-execution-canonical.test.ts` は `run-paths.js` をモックしているため `resolveWorkflowExecutionResumeSourceLineage` を `vi.spyOn` で差し替えて有効な operation lineage（`operationJournalRunSlug`・`operationClaimToken`・`publishedResumeSource`）を返させ、`resumeSource`（`sourceRunSlug` 付き）を渡した状態で `prepareWorkflowExecutionBundle` が投げたときに、`RunMetaManager` の constructor へ `resumeSource`（`sourceRunSlug`）と `options`（`operationJournalRunSlug`・`operationClaimToken`）が渡されることを検証する。
   - 実装時に、M1（`prepareWorkflowExecutionBundle` を `beginRun` の前へ戻す）・M1b（`beginRun` の後だが `try` の外へ置く）・M4（`terminalizeBootstrapFailure` で `publishRunMeta` へ渡す `resumeSource` / `options` を落とす）をそれぞれ入れて単体テストが失敗することを確かめてから元に戻す。
2. **E2E テストの検証強化（`e2e/specs/workflow-selection-branches.e2e.ts`）**:
   - `fails with the lookup reason and still records the run` に次の検証を追加する:
     - `result.exitCode !== 0`
     - `meta.json` の `reason` に探索理由（`Workflow bundle could not resolve call "builtin-caller/develop"`、`call: development-core`、候補パス、`excluded because enable_builtin_workflows is false`）が含まれること
     - `logs/*.jsonl` に `workflow_start` と `workflow_abort` レコードがあり、`workflow_abort.reason` にも同じ探索理由が含まれること
   - 実装時に、`terminalizeBootstrapFailure` で `reason` を差し替える変異（M3）を入れてこの E2E テストが失敗することを確かめてから元に戻す。
3. **Quint 仕様の修正（`specs/quint/run-start-record/`）**:
   - 上記「Quint」節のとおり、実物の `beginRun`・pre-meta bootstrap 失敗（`inheritResumeReportSnapshot` の `reports/` 欠如を含む）・`createWorkflowExecutionBootstrap`・`terminalizeBootstrapFailure`・成功終了・2 試行 resume（`lineageAvailable` 分岐付き）に合わせたモデルへ更新し、9 不変条件・9 witness・シナリオテスト（8 + 2 件）を整備する。
4. **設計書の追記（`docs/design/workflow-call-resolve-error.md`）**:
   - 上記「影響」節の書き漏れ（`task_finish_hook`・`loop_analysis`・付随ファイル）と本節、および設計レビュー 2 回目のトリアージ表を追記する。

### 変えないこと（範囲の外・別件）

- 本番の TypeScript コード（`src/` 配下）は変更しない（実装本体は後追い設計レビューで妥当と判断済み。準備失敗 run からの resume が `inheritResumeReportSnapshot` で失敗する点も既存仕様としてモデル・設計を実物へ合わせ、改善自体は別件とする）。
- 以下の既存課題は別件（起票は中将の判断）とし、本 PR の範囲外とする:
  - `terminalizeBootstrapFailure` の 2 段階書き込み（`publishRunMeta(running)` → `activeRun.finish(failed)` の間の失敗・強制停止で `running` が残る課題）
  - `createWorkflowExecutionBootstrap` 内で `initNdjsonLog` 実行後に失敗した際の `workflow_start` 二重追記
  - `loop_analysis.enabled: true` 時に 0 ステップの bootstrap 失敗で `scheduleLoopAnalysis` を回すべきかの見直し
  - Central `requeueTask` で `reports/` 未作成 run を `sourceRunSlug` にしたときの挙動（0 ステップ失敗 run からの resume の扱い）
  - `resolveWorkflowExecutionResumeLineage` を `try` 内へ移す整理

### 追いの PR における PBT の扱い

- 本番ロジック（探索・説明・バリデーション）には変更を加えないため、新規 PBT の追加対象は無い。既存の 24 通り全組み合わせテスト（`named workflow lookup explanation agrees with the lookup`、除外なし）はそのまま維持する。

### 追いの PR で潰す変異と壊しうる入力

- **M1（順序戻し変異）**: `prepareWorkflowExecutionBundle` を `beginRun` より前へ戻す → 追加する単体テスト（(a)・(d)・(e)）と Quint（`prepareFirst`）の両方で失敗する。
- **M1b（`try` 外出し変異）**: `prepareWorkflowExecutionBundle` を `beginRun` の後・`try` の外へ置く → 追加する単体テスト（(d) `initNdjsonLog`・(e) `mockProjectTerminal`）で失敗する。
- **M2（終端化スキップ変異）**: `terminalizeBootstrapFailure` の `activeRun.finish` を飛ばす → 既存および追加の単体テスト・E2E の両方で失敗する。
- **M3（理由欠落変異）**: `terminalizeBootstrapFailure` が `meta.json` / NDJSON に書く `reason` を汎用文言へ差し替える → 単体テストと強化後の E2E の両方で失敗する。
- **M4（resume 系譜欠落変異）**: `terminalizeBootstrapFailure` が `publishRunMeta` へ渡す `resumeSource` または `options`（`operationJournalRunSlug` / `operationClaimToken`）を落とす → 追加する resume 単体テストで両方の欠落を検出し、Quint（`resumePreservesIntegrity`）では `source_run_slug` の欠落を検出する（`operationJournalRunSlug`・`operationClaimToken` はモデル対象外）。
- **resume・境界・長さ・並行**: 上記「壊しうる入力」および Quint `resumePreservesIntegrity` / `noResumeCompletionWithoutSourceReports` / `noDuplicateRecords` / `noFailureOnSuccess` / `beginRunLeavesNoRecordYet` で整理・検証する。

### 設計レビュー（2回目）指摘のトリアージ

| # | 重さ | 指摘の要点 | 判定 | 対応内容 |
|---|---|---|---|---|
| 中-1 | 中 | `resume` で `source_run_slug` を記録する不変条件が、lineage が取れない経路では実物より強い | **直す** | 設計書の不変条件・壊しうる入力を「lineage が取れるとき（`publishedResumeSource` あり）」と「取れないとき（`OperationLineageUnavailableError` フォールバック）」に分け、Quint に `lineageAvailable` 分岐・`expectedRecordedSource`・witness・テストを追加した。 |
| 中-2 | 中 | 準備失敗 run からの resume が Quint では完了でき、準備後の pre-meta bootstrap 失敗が無い | **直す** | 本番コードは既存仕様のまま（0 ステップ失敗 run の `requeueTask` 見直しは別件）とし、Quint に `hasReports`・`BootstrapOutcome`・`bootstrapPreMetaFail`・不変条件 `noResumeCompletionWithoutSourceReports`・witness・テストを追加して実物に合わせた。 |
| 中-3 | 中 | resume 準備失敗で `resumeSource` / journal 系譜を落とす変異 M4 を捕まえるテストが計画に無い | **直す** | 単体テスト計画と変異一覧に M4 対策（`RunMetaManager` constructor へ `resumeSource.sourceRunSlug`・`operationJournalRunSlug`・`operationClaimToken` が渡る検証）を追加した。 |
| 低-1 | 低 | 「再開元の保存済み記録を改変しない」は `meta.json` と logs に限る（operation journal は共有追記） | **直す** | 設計書の不変条件・壊しうる入力と Quint `README.md` の文言を「再開元の `meta.json` と logs を改変しない（operation journal は系譜で共有追記）」へ絞った。 |
| 低-2 | 低 | M1 の変種（`beginRun` の後・`try` の外 = M1b）を計画に明記する | **直す** | 単体テスト計画と変異一覧に M1b を明記し、実装時に M1・M1b の両方で落ちることを確かめるようにした。 |
| 低-3 | 低 | `beginRun` 前の `resolveAvailableSourceLineage` での `OperationRecoveryError` は記録を残さない | **直す** | 設計書の「範囲の外」と Quint `README.md` の対象外に 1 行追記した（実装自体は PR #167 以前からの挙動で変更しない）。 |
| 低-4 | 低 | Quint の `isSourceDistinct` / `isSourceExited` / `run1Snapshot` はモデル構造上つねに成り立ち、`resolveRunSlug` の同 slug 例外は未表現 | **直す** | Quint `README.md` に、構造上成り立つ範囲（ただし `RUN_1` 書き換え変異の検出には効くこと）と同 slug 例外経路が対象外であることを明記した。 |
| 低-5 | 低 | witness の割合は seed 依存。`quint verify` 結果の追記も検討 | **直す** | 設計書・`README.md` の割合表記を「全 9 witness 到達（割合は seed 依存、`--seed=...` の実測例）」へ改め、`quint verify --max-steps 12` は任意の参考コマンドとして `README.md` に添えた（標準検証は `quint test`・`quint run`）。 |
| 低-6 | 低 | 古い順序（`prepareFirst`）で破れる不変条件に `unresolvedReasonExplains` も含まれる | **直す** | `prepareFirst` で `unresolvedReasonExplains` の違反を実測確認し、設計書・`README.md`・`prepareFirstTest` に 3 不変条件（`failureIsRecorded`・`unresolvedReasonExplains`・`resumePreservesIntegrity`）の違反を明記した。 |

### 設計レビュー（3回目）指摘のトリアージ

| # | 重さ | 指摘の要点 | 判定 | 対応内容 |
|---|---|---|---|---|
| 低-A | 低 | `createWorkflowExecutionBootstrap` 成功後・`WorkflowEngine` が `reports/` を作る前の実行失敗が未モデル | **直す** | Quint `README.md` の「What is NOT modelled」と本設計書の「モデル対象外」に 1 行追記した。 |
| 低-B | 低 | いまのコードが作る `meta.json` は常に lineage を書くため、`lineageAvailable = false` の意味を明記する | **直す** | Quint `README.md` の `resolveWorkflowExecutionResumeLineage` の項に、`false` は古い形または壊れた `meta.json`（lineage 欄なし）を表す旨を追記した。 |
| 低-C | 低 | `workflow-execution-canonical.test.ts` は `run-paths.js` をモックしているため M4 テストの lineage 準備に注意が必要 | **直す** | 本設計書の M4 テスト計画に、`resolveWorkflowExecutionResumeSourceLineage` を `vi.spyOn` で差し替えて lineage を用意する手順を明記し、実装もその形にした。 |
