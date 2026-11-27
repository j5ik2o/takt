# 外から起動した takt-mcp にゴールの停止・再開の道具を出す

- Issue: [j5ik2o/takt#179](https://github.com/j5ik2o/takt/issues/179)
- 基点: `integration/takt-mcp`（`e0d653c67`）
- 上流: `nrslib/takt` の main（`bba6f2315`）も `src/features/mcp/server.ts` の `goalExecutionConnection` があるときだけ 4 つを登録しており、同じ穴がある（コードだけ確認。上流の issue は確認していないが、依頼ではこの登録を外へ出す issue は無いとされている。上流には触れない）。
- Quint: `specs/quint/goal-execution-tools/`
- この文書は設計だけを書く。`src/` と試験は変えていない。

## 何が起きているか

`takt-mcp --tool-set all` で外から起動したサーバーには、`takt_pause_goal` /
`takt_resume_goal` / `takt_abort_goal` / `takt_finish_goal` が登録されず、呼ぶと
`Tool not found` になる。

- 登録は `src/features/mcp/server.ts:275-309` の `if (options.toolSet === 'manager')` の中だけで、
  さらに `const connection = options.goalExecutionConnection`（`:282`）が `undefined` でないときだけ
  4 つを `registerTool` する（`:289-308`）。
- `goalExecutionConnection` を渡すのは manager の接続だけ（`src/features/manager/managerMcpConnection.ts:14`）。
  外から起動する入口は渡さない（`src/app/mcp/index.ts:83-91` の stdio、`:141-147` の HTTP。
  `createServerOptions`（`:74-82`）は `managerAssignment` を `manager` のときだけ埋める）。
- 4 つは `TAKT_MCP_MANAGER_TOOL_NAMES`（`server.ts:135`）にも入っていない。manager の会話でだけ
  `src/features/manager/turnExecutor.ts:19-23` が allowlist に足している。外から起動したサーバーには、
  ほかに 4 つを足す経路が無い。
- いまの穴を固定している試験がある。`src/__tests__/it-goal-mcp-stdio.test.ts` の
  「keeps goal execution unavailable for $toolSet connection」は、`all` / `read-only` /
  接続の無い `manager` で 4 つが一覧に出ず、呼ぶとエラーになることを確かめている。実装ではこの
  期待を `all` についてだけ裏返す（試験コードはこの設計では書かない）。

## 何をどう変えるか

### 1. 登録

`server.ts` の 4 つの登録を `if (options.toolSet === 'manager')` の外へ出し、次の条件で 1 回だけ
登録する。manager のときは今と同じく `goalExecutionConnection.assertConnected()` を通してから
操作する（外からの `all` には接続が無いので通さない）。

| `toolSet` | `goalExecutionConnection` | 4 つ | driver |
|---|---|---|---|
| `all` | 有無を問わない | 出す（新しい） | `external` |
| `manager` | ある | 出す（今と同じ） | `manager` |
| `manager` | ない | 出さない（今と同じ） | — |
| `read-only` | 有無を問わない | 出さない（今と同じ） | — |
| `undefined` | 有無を問わない | 出さない（今と同じ。既定の `createTaktMcpServer` を変えない） | — |

- 4 つの `title` / `description` / `inputSchema` は 1 つの定義（定数）にまとめ、manager と
  `all` で同じものを使う。文面が片方だけ古くならないようにする。
- 操作本体は今の関数をそのまま使う。`all` では `projectInput` が `cwd` を書き換えない
  （manager のときだけ担当のルートへ寄せる。`server.ts:207-208`）ので、呼び出し元の絶対パスを
  `assertCwdAllowedByMcpRoot` で検査する今の経路になる。`allowedProjectRoot` は
  `createTaktMcpServer` の既定（`process.cwd()` の realpath）で、`all` の他の書き込み道具と同じ。
- 4 つの登録は `operation(..., launchAfterOperation=false)` を使う（manager と同じ）。操作の後に
  `ensureManagerRun` を自動で呼ばない。resume 自身が `ensureDaemon` と `ensureManagerRun` を呼ぶ
  既存の挙動もそのまま使う。

### 2. 4 つの道具の引数と結果（manager 側と揃える）

manager 側の定義をそのまま使う。外部だけの引数・結果は無い。

| 道具 | 入力（strict） | 成功時の結果（JSON） |
|---|---|---|
| `takt_pause_goal` | `cwd`, `goalId` | `{"goalId":"<uuid>","executionStatus":"paused"}` |
| `takt_resume_goal` | `cwd`, `goalId` | `{"goalId":"<uuid>","executionStatus":"active"}` |
| `takt_abort_goal` | `cwd`, `goalId`, `reason` | `{"goalId":"<uuid>","executionStatus":"aborted"}` |
| `takt_finish_goal` | `cwd`, `goalId`, `reason` | `{"workLogEntryId":"<uuid>","targetSha":"<sha>","goal":{...}}` |

- 入力は `goalWriteInputSchema`（`cwd` は絶対パス、`goalId` は UUID）と、`abortGoalInputSchema` /
  `finishGoalInputSchema`（`reason` は必須）で、manager と同一（`src/features/mcp/schemas.ts:81,98-100`、
  `src/features/mcp/goalFinishSchemas.ts:5-7`）。
- 結果は `changeGoalExecution` の `jsonResult({ goalId, executionStatus })` と、
  `finishTaktAbortedGoal` の `integrationSummary({ goal, workLogEntryId, targetSha })` をそのまま返す
  （`goalExecutionOperations.ts:46-59`、`goalFinishOperations.ts:89-107`、`goalResponse.ts:71-83`）。
- エラーは今と同じ封筒で、`isError: true` と `"<context>: <message>"` の 1 行。context は
  pause/resume/abort が `Goal execution change failed`、finish が `Goal finish failed`
  （`goalExecutionOperations.ts:46-47`、`goalWrite.ts:55`）。
- `takt_abort_goal` の `reason` は保存しない（作業記録に残すのは呼び出し元の責任）。この説明も
  manager と同じ文面を使う。
- `executionStatus` の遷移規則（active だけ pause、paused だけ resume、aborted は resume 不可、
  active/paused だけ abort、aborted かつ status が created/awaiting_merge だけ finish）は
  `src/infra/goals/state.ts` の既存のもので、外からでも同じエラーになる。

### 3. 同じゴールを二重に動かさない

#### 3-1. 「manager の接続が同じゴールを実行中」の定義

この設計では、**4 つの道具のどれかが同じゴールに対して処理中**（読み取りと検証を始めてから、
保存と保存後の処理を終えるまで）を「実行中」とする。manager の会話がそのゴールのタスクを実行して
いることは含めない。pause は実行中のタスクを止めるための道具であり、タスクが動いていることを理由に
pause を拒むと目的を果たせないため。タスクの停止・無効化は保存後の処理として同じ操作の中で行う。

#### 3-2. ゴールごとの driver lease

`src/infra/goals/driver-lease.ts`（新設、実装は別コミット）に、ゴールごとの排他を置く。

- 場所: `.takt/goals/<goalId>/driver.json`（`goal.json` と同じディレクトリ。ゴールを消すと一緒に消える）。
- 中身（1 行の JSON、0600）:
  `{"driver":"manager"|"external","operation":"pause"|"resume"|"abort"|"finish","pid":1234,"processStartTime":"...","startedAt":"<ISO>","token":"<uuid>"}`
- 取り方: `writeNewPrivateFileWithMode`（既存を拒む原子的な公開。`src/shared/utils/private-file.ts:194`）で
  作る。**待たない**。取れなければその場で失敗する。`goal-execution.lock` のような待ち合わせはしない。
  これは「二重に動かさない」を、待って直列化するのではなく、後の呼び出しを明確なエラーにするため。
- 生きた持ち主の判定: `isRecordedProcessAlive(pid, { startTime: processStartTime })`
  （`src/infra/fs/file-lock.ts:212`）と `getSelfProcessIdentity` / `sameProcessIdentity`
  （`src/infra/task/process.ts`）。PID が生きていて開始時刻が食い違わないときは「生きている」。
  開始時刻を比べられないときも生きている扱いにする（fail-closed）。
- 死んだ持ち主: PID が無い、または PID はあるが開始時刻が両方取れて食い違う（PID の再利用）。
  中身を読み直して変わっていなければ外し、1 回だけ取り直す。既存のロックの回収と同じ考え方。
- 読めない・壊れた中身: 外さずに競合として失敗する（書き込み途中の他人のファイルを消さない）。
- 同じプロセスが外し損ねた lease: プロセス内の `Map` に記録し、次に同じゴールを操作するときに
  外す（#169 の `orphanedLocks` と同じ扱い）。解放に失敗しても、操作が成功していれば結果は成功の
  まま返し、`log.warn` に残す。プロセスが死ねば、次の呼び出しが PID と開始時刻で回収する。
- ロック順: driver lease → `goal.json.lock` → `goal-execution.lock`。lease を持ったまま
  `GoalStore.update` が今の 2 つを取る。逆向きに取る経路は無い（lease は 4 つの道具だけが使う）。

#### 3-3. 条件

`withGoalDriverLease(cwd, goalId, driver, operation, signal, action)` を、pause / resume / abort
では `changeGoalExecution` の入力検査の直後から保存後の処理までの内側に置き、finish では
`finishTaktAbortedGoal` が `goalWrite` を呼ぶところを囲む。どちらも、ゴールの状態を読んで
変える部分の全体が lease の下に入る。

- lease が無い、または死んだ持ち主のもの: 取って処理を続ける。
- 生きた持ち主がいる: 保存も保存後の処理もせず、**その場で失敗**する。manager が持っていれば
  external は失敗し、external が持っていれば manager も失敗する（対称。片方だけ止めると
  「同じゴールを二重に動かさない」が成り立たない）。同じサーバーの並行呼び出しも同じ扱い。
- lease は `finally` で外す。`signal` の中断でも外す。外した後に結果を返す。
- 4 つ以外のゴール道具（`takt_enqueue_goal_task`、`takt_merge_goal_task`、`takt_complete_goal`
  など）は lease を取らない。これらは `goalWrite` が保存済みの `executionStatus` を見て、
  paused / aborted のゴールを既に拒む。`takt_stop_goal_task` / `takt_remove_goal_task` は別の
  規則で、この設計では変えない。4 つに範囲を絞る。

### 4. エラーの文面

`takt_abort_goal` の `reason` 不足など、既存の入力エラーは今のまま。競合は次の文面で、既存の
`errorResult` の封筒（`isError: true`、`"<context>: <message>"`）に載せる。

manager が持っているとき:

```text
Goal <goalId> is already being changed by the manager connection (PID <pid>, <operation>, started <startedAt>). Retry after it finishes.
```

別の takt-mcp が持っているとき:

```text
Goal <goalId> is already being changed by another takt-mcp process (PID <pid>, <operation>, started <startedAt>). Retry after it finishes.
```

同じサーバーの並行呼び出しのとき:

```text
Goal <goalId> is already being changed by this takt-mcp server (PID <pid>, <operation>, started <startedAt>). Retry after it finishes.
```

lease が読めない・壊れているとき（外さない）:

```text
Goal <goalId> has an unreadable driver lease (.takt/goals/<goalId>/driver.json). Another TAKT process may be changing it; retry after it finishes.
```

`<pid>` と `<startedAt>` は lease に保存した値、`<operation>` は `pause` / `resume` / `abort` /
`finish`。中身やパスワードなどの秘密は出さない。

### 5. 権限

新しい権限は足さない。`takt-mcp` を呼べる者（stdio の起動元、または HTTP の Bearer token を持つ
者）は、この 4 つもそのまま呼べる。

- `--enable-goal-execution-tools` のような新しいフラグは作らない（既に削除済み）。
- 承認（approval）やツール許可の追加はしない。manager の会話の allowlist
  （`turnExecutor.ts:19-23`）は今のままで、外から起動したサーバーには allowlist が無い。
- `read-only` は今までどおり 4 つを出さない。読み取り専用を守る手段は `--tool-set read-only` の
  まま。`TAKT_MCP_READ_ONLY_TOOL_NAMES` と `TAKT_MCP_MANAGER_TOOL_NAMES` は変えない。
- 外からの HTTP の token 検査（`src/infra/mcp/serverHttpTransport.ts`）と、manager の
  ローカル接続の検査（`src/features/mcp/localConnection.ts`）は変えない。

## 変えないもの

- **manager 側の道具**: `takt_pause_goal` / `takt_resume_goal` / `takt_abort_goal` /
  `takt_finish_goal` の名前・入力・成功時の結果・既存のエラーは変えない。変わるのは、同じゴールを
  同時に動かそうとしたときに競合エラーで失敗する点だけが増える（3 節。4 つの道具の契約を保つために必要）。
  manager の会話で使う allowlist（`turnExecutor.ts`）と `TAKT_MCP_MANAGER_TOOL_NAMES` も変えない。
- **#188 との境界**: 「同じ保存で manager 通知の失敗と終了フックの失敗の警告が 2 種類並ぶ」問題には
  触れない。finish の保存後の通知も今の経路のまま。
- **#170 との境界**: ゴールタスク失敗の完了通知の再送（`completion_publication_pending`）には
  触れない。finish は完了の記録を保存するだけで、通知の再送や再公開を足さない。
- **#2073（クラウドの worker）と #2102（index の時刻）**: このコミットに混ぜない。
- デーモンの IPC（`processProtocol.ts`）に新しい要求を足さない。外からの 4 つは、manager と同じ
  保存済みファイルと git の経路だけを使う。
- `takt_stop_goal_task` / `takt_remove_goal_task` / ゴールの削除（TUI の `Ctrl+G` だけ）は変えない。

## Quint

`specs/quint/goal-execution-tools/` に、manager の接続（M）と外の takt-mcp（X）が 1 つのゴールを
動かす状態機械を書いた。

- `goalExecutionTools.qnt`: `DESIGN = "Current"` は今のコード（相互排除なし）、`"Fixed"` は
  driver lease あり。begin（読む・検証する）→ commit（保存と保存後の処理）/ abandon（保存済みの
  状態が拒む）→ crash（begin と commit の間で死ぬ）。
- `goalExecutionTools_test.qnt`: `Current` で M と X が同時に begin できること、`Fixed` で
  manager が持つ間の external の拒否、終了後の external の実行、死んだ持ち主の lease の回収、
  aborted からの resume の拒否、aborted でないゴールの finish の拒否を固定する。
- 不変条件は 1 つの `safety` にまとめ、`quint run --invariant safety` 1 回で検査した。結果は
  `specs/quint/goal-execution-tools/README.md` に書いた（`Current` は反例、`Fixed` は 10,000
  サンプル・max-steps 16・seed 0x2a で反例なし。witness は `wExternalRefusedByManager` 697/10000、
  `wExternalFinish` 3/10000、`wStaleLeaseReclaimed` 1004/10000、`wDoubleDrive` 0/10000）。
- モデルに含めないもの: 実行中タスクの停止・無効化、resume の daemon / manager 起動、finish の
  ブランチ解決と未取り込み判定、lease のファイル実装（回収・解放の失敗）、複数ホスト。

## 実装で触るファイル（この設計では変えていない）

- `src/features/mcp/server.ts`: 4 つの定義を共通化し、`all` と manager（接続あり）で登録する。
  manager のときだけ `assertConnected` を通す。
- `src/infra/goals/driver-lease.ts`（新設）: 3-2 の lease。
- `src/features/mcp/goalExecutionOperations.ts` / `goalFinishOperations.ts`: 呼び出し元の driver を
  受け取り、処理全体を `withGoalDriverLease` で囲む。
- 試験: `src/__tests__/it-goal-mcp-stdio.test.ts` の「4 つは `all` でも出ない」期待を `all` に
  ついて裏返す。`all` の 4 つ（入力・結果・エラー）と、manager が実行中の external の拒否、
  死んだ lease の回収、`read-only` と接続なし manager が出さないことを足す。manager 側の
  `it-manager-mcp-connection.test.ts` / `it-manager-conversation-plan.test.ts` /
  `claude-executor.test.ts` の allowlist 期待は変えない。

## 前提と決めたこと

- 外からの `takt-mcp` はプロジェクトの中で起動され、`cwd` は `process.cwd()` の下にある
  （`all` の他の書き込み道具と同じ制約）。外の絶対パスを許す新しい権限は足さない。
- manager の 1 つの接続（会話）は 1 つの担当に属し、1 つのターンで複数の道具を並行に呼びうる。
  同じサーバー内の並行呼び出しも lease で拒む。
- 4 つの道具は「同じゴールの状態を変える操作」として lease を取る。ゴールのタスク実行そのものは
  lease の対象外（pause の目的を壊さないため）。
- lease の解放に失敗したプロセスが生き続け、そのゴールを二度と操作しない場合、外部はそのゴールを
  操作できない（安全側）。プロセスの再起動か、次の同じゴールの操作で回収される。従来のロックの
  解放失敗（#169）と同じ扱いで、新しい回避策はこの設計に含めない。
- PID と開始時刻は呼び出しを実行したホストで見る。複数ホストで同じ `.takt/` を共有する構成は、
  既存のロックと同じく対象外。

採否（2026-11-27）: 「実行中」は 4 つの道具の処理中に限る。タスク実行中の外からの pause と abort は成功する。lease（driver.json、相手が持っている間は manager 側の同じ 4 つも external 同士も失敗する、死んだ PID の回収は 3-2）は認め、壊れた lease は消さない。新しい権限は足さない。
