# 組み込みで失敗したタスクの再試行を、組み込みの worker に限る

- Issue: [#209](https://github.com/j5ik2o/takt/issues/209)（レビュー: [#193 の指摘](https://github.com/j5ik2o/takt/pull/193#discussion_r4723193140)）
- 基点: [#193](https://github.com/j5ik2o/takt/pull/193) の枝 `j5ik2o/takt-sync-upstream-main`（595d6a826）
- 上流: nrslib/takt の main（1b1e6bb7c）は worker pool の取り込み（#2073）のあと `src/features/workerPool` に変更が無く、同じ形のまま。フォークで直す。

## 結論

振り分けは、`merge_task` と同じ 2 か所で決める。

1. `BuiltinProjectRuntime.inspect()` が、元の run に結びついた再試行に `builtinOnly: true` を付けて pool に渡し、`workerPoolAvailability`（`src/core/worker-pool/scheduler.ts:5-9`）がそのタスクの候補を組み込みの worker に限る。
2. 遠隔の claim（`RemoteTaskLifecycle.claim`、`src/infra/task/remoteTaskLifecycle.ts:226`）も、同じ記録には割り当てを返さない。

「元の run に結びついた再試行」は、`remote_assignment` が無く、`source_run_slug`・`resume_mode`・`start_step`・`resume_point`・`restart_point`・`source_resume_point` のどれかを持つ記録とする。この 6 つは、遠隔の再試行を元の SHA からやり直すときに上流のコードが消す欄（`remoteTaskLifecycle.ts:76-77`）と同じで、「前の作業場所の run を前提にする欄」として上流がすでに選んでいる。判定は 1 つの関数にして、2 か所から呼ぶ。

## 何が起きているか

- `inspect()`（`src/features/workerPool/builtinProjectRuntime.ts:112-116`）は、`remote_assignment` があるときだけ `remoteOnly`（と `retryWorker`）を付ける。組み込みで失敗したタスクを再試行すると、`buildRetryTaskRecord`（`src/infra/task/taskRecordMutations.ts:125-160`）は `remote_assignment` を持たないまま、`source_run_slug`・`resume_mode` などを付けて `pending` に戻す。
- `workerPoolAvailability` は `mergeTask` でも `remoteOnly` でもないタスクの候補に、遠隔の worker も残す（`scheduler.ts:5-9`）。遠隔の worker が先に pull すると、そのタスクが割り当てられる。
- 遠隔の claim は `previous`（`remote_assignment`）が無いので `workLocation: null` で新しいクローンを作る（`remoteTaskLifecycle.ts:247-253`）。`prepareRemoteExecutionInput`（`src/features/workerPool/remoteExecutionInput.ts:103-104`）は `resumeSource` に `source_run_slug` を入れるが、その run は組み込みの側の `.takt/runs/` にしか無い。遠隔では元の run を再開できない。

組み込みの worker は自分の `.takt/runs/` を持つので、同じタスクを組み込みで claim すれば元の run から再開できる。

## 振り分けをどこで決めるか

### 採る形：pool の候補（scheduler）と、遠隔の claim の両方

`merge_task` がすでにこの形をとっている。scheduler は `mergeTask` のタスクの候補を組み込みに限り（`scheduler.ts:5`）、遠隔の claim も `merge_task === true` の記録を断る（`remoteTaskLifecycle.ts:226`）。同じ形にそろえる。

- 主な決め所は scheduler である。待ちの理由（`setWaitingReasons`）も同じ `workerPoolAvailability` から出るので、組み込みの枠が空くのを待っていることが、タスクの一覧に正しく出る。
- 遠隔の claim の判定は、遠隔の worker がプロトコルで別のタスク名を送ってきたときの守り。pool が割り当てないタスクが遠隔で始まることはないが、`merge_task` と同じ場所に同じ判定を置くことで、読む人が 2 つの規則を同じものとして読める。

### 採らない形

- **遠隔の claim だけで断る**：scheduler は遠隔の worker に割り当て続け、claim が毎回 `null` を返す。そのあいだ組み込みの枠が空いても、その dispatch では組み込みに回らない。待ちの理由も「遠隔の worker を待っている」と読める形のまま残る。
- **遠隔で元の run を再開できるようにする**（組み込みの run の記録を入力に入れて送る）：run の記録、作業ツリー、セッションを遠隔へ運ぶ仕組みが新しく要る。#209 の期待（組み込みの worker だけを候補に残す）より大きい。
- **遠隔に回すときに、再開の欄を消して元の SHA からやり直す**：遠隔の再試行が登録の削除や切断のときにとる形（`remoteTaskLifecycle.ts:70-77`）と同じだが、組み込みの枠があるのに、利用者が頼んだ再開を黙ってやり直しに変える。組み込みの枠が 0 のときの扱いは、上げる点の 1 番目にした。

## 直し方

| ファイル | 場所 | 変えること |
|---|---|---|
| `src/infra/task/taskRecordMutations.ts`（または同じ層の新しい小さなモジュール） | 新しい関数 `resumesLocalRun(task: TaskRecord): boolean` | `task.remote_assignment === undefined` かつ 6 つの欄のどれかが `undefined` でない |
| `src/core/worker-pool/types.ts` | `PoolTask` | `builtinOnly?: boolean` を足す |
| `src/core/worker-pool/scheduler.ts:5-6` | `workerPoolAvailability` の `eligible` | `(!task.mergeTask && !task.builtinOnly \|\| worker.kind === 'builtin')` にする |
| `src/features/workerPool/builtinProjectRuntime.ts:112-116` | `inspect` | `resumesLocalRun(task)` のとき `builtinOnly: true` を付ける |
| `src/infra/task/remoteTaskLifecycle.ts:226` | `claim` | `record.merge_task === true` と並べて `resumesLocalRun(record)` なら `{ kind: 'claim', assignment: null }` |

`scheduler.ts:29`・`:35-38` の並べ替えと、再試行の予約を先に回す判定は `remoteOnly` と `retryWorker` だけを見ている。`builtinOnly` はそこに入れない。組み込みの再試行は、ほかの組み込みのタスクと同じ順で回る。

`docs/worker-pool.md` の「Verification and operational limits」にある「PR merge tasks and tasks without origin cannot progress while it is 0」に、組み込みで失敗したタスクの再試行（元の run から再開するもの）も並べる。ja・zh-CN の同じ段落も同じく直す。

## red のテスト（Sonnet が書く）

既存の試験は変えない。新しいファイル `src/__tests__/worker-pool-local-resume-routing.test.ts`（単体）に置き、`tsconfig.tests.json` に足す。

| # | 試験の名前 | 確かめること | 本番のどこを外せば落ちるか |
|---|---|---|---|
| R1 | `keeps a local resume retry off remote workers in the pool schedule` | `scheduleWorkerPool` に、`builtinOnly: true` のタスク 1 つと、遠隔の worker（`origin` あり）だけを渡すと、割り当てが空。組み込みの worker を足すと、組み込みに割り当たる。`workerPoolAvailability` の理由は空きを待つ形になる | `scheduler.ts` の `builtinOnly` の条件 |
| R2 | `marks a pending retry that resumes a local run as builtin only` を `it.each(['source_run_slug', 'start_step', 'resume_point'])` | `tasks.yaml` に、`remote_assignment` が無く、その欄を持つ `pending` のゴールタスクを置いて `inspect()` を呼ぶ。返るタスクに `builtinOnly: true` があり、`remoteOnly` は無い。`remote_assignment` を持つ再試行には `builtinOnly` が無い | `inspect` の `builtinOnly` の付与、または `resumesLocalRun` |
| R3 | `does not assign a local resume retry to a remote claim` | `worker-pool-remote-task.test.ts` と同じ fixture で、`source_run_slug` と `resume_mode` を持ち `remote_assignment` の無い `pending` の記録に遠隔の claim を送る。返事は `{ kind: 'claim', assignment: null }` で、記録は `pending` のまま `remote_assignment` が付かない | `remoteTaskLifecycle.ts` の claim の判定 |

## 上げる点

1. **組み込みの枠が 0 のとき**（運用の形）。`daemon.builtin_worker.concurrency: 0` で遠隔だけを使う環境では、組み込みで失敗したタスクの再試行は、待ちの理由「No executable worker is available: worker concurrency is 0」のまま進まない。PR の merge のタスクも今同じ扱いである。推しは、この設計ではこのままにし、文書に書くこと。遠隔で元の SHA からやり直す形は、利用者が頼んだ再開を黙って変えるので、入れるなら別の issue で、利用者が選べる形にする。
2. **`start_step` だけの再試行も組み込みに限るか**。`takt retry` で開始のステップだけを指定した再試行も、6 つの欄に入るので組み込みに限る。前の run のレポートを読まないステップなら遠隔でも走れるかもしれないが、それを見分ける情報は記録に無い。上流がやり直しで消す欄と同じにそろえることを推す。

## 範囲の外

- 遠隔で失敗したタスクの再試行（`remote_assignment` があるもの）。今の `remoteOnly` と `retryWorker` の扱いのまま変えない。
- worker の枠の数え方、並べ替えの順。
