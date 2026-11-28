# worker の token を起動引数から外す

- Issue: [#211](https://github.com/j5ik2o/takt/issues/211)（レビュー: [#193 の指摘](https://github.com/j5ik2o/takt/pull/193#discussion_r4723193298)）
- 基点: [#193](https://github.com/j5ik2o/takt/pull/193) の枝 `j5ik2o/takt-sync-upstream-main`（595d6a826）
- 上流: nrslib/takt の main（1b1e6bb7c）は worker pool の取り込み（#2073）のあと `src/features/workerPool` と `src/app/worker-pool-project` に変更が無く、同じ形のまま。フォークで直す。
- 受け取り方の形は元帥が決めた（環境変数かファイルのパス。`--token` は残して警告する）。この文書は、その形の細部を決める。

## 結論

`takt worker` は token を次のどれか 1 つから受け取る。

| 渡し方 | 形 | 扱い |
|---|---|---|
| 環境変数 | `TAKT_WORKER_TOKEN=<token>` | 推す渡し方。起動引数に残らない |
| ファイル | `--token-file <path>` | ファイルの権限が 600（グループと他人に読み書き実行の権限が無い）であることを確かめてから読む |
| 起動引数 | `--token <token>` | 今の使い方を壊さないために受け付ける。使われたら「ps から読める」と stderr に 1 行警告する |

2 つ以上が同時に与えられたら、起動を止める（元帥の決定、11/28）。止めるときの文には、重なった渡し方の名前を書き、token の値は書かない。どれも無ければ、今と同じく起動を止める。標準入力からは受け取らない。

## 何が起きているか

- `src/app/cli/commands.ts:63-70` の `takt worker` は、`--url` と `--token` を起動引数で受け取る。同じ機械の利用者は `ps` で token を読める。
- `src/features/workerPool/workerCommands.ts:29` は、子（タスクの実行のプロセス）へ渡す環境変数から、値に token を含むものを除く。子の起動引数は `process.execArgv` と入口のファイルだけで（`src/features/workerPool/remoteTaskExecutor.ts:82`）、token は載らない。残るのは、worker 自身の起動引数である。
- `docs/worker-pool.md:72-79` の起動スクリプトは `--token "$WORKER_REGISTRATION_TOKEN"` で渡し、「The token is passed as a process argument」と書いている。ja・zh-CN の同じ文書、`docs/cli-reference.md:133`（ja・zh-CN も）、`docs/design/worker-pool.md:87` も同じ渡し方を書いている。

## 決めること

### 1. 重なったとき

優先順は置かず、2 つ以上が与えられたら起動を止める。止めるときの文は、与えられた渡し方の名前を、`TAKT_WORKER_TOKEN`、`--token-file`、`--token` の順で、与えられたものだけ並べる。値も、ファイルのパスも書かない。

> Worker token was given more than once (TAKT_WORKER_TOKEN, --token-file). Give it in exactly one way.

3 つとも与えられたときは「(TAKT_WORKER_TOKEN, --token-file, --token)」になる。終了コードは 0 以外で、接続の前に止まる。`--token` が重なりに含まれるときも、5 節の `--token` の警告は出さない（止める文だけを出す）。

理由。

- 優先順を置くと、黙って捨てられる token ができる。サービスの環境に古い `TAKT_WORKER_TOKEN` が残っていて、手で `--token-file` を足して試したとき、どちらで繋いだかが起動の表示から分からない。登録ごとに token が違うので、違う登録で繋がると、別の worker の接続を閉じる（同じ登録の新しい接続は前の接続を閉じる。`docs/worker-pool.md:66`）。
- 止めれば、利用者は不要な方を消すだけで済む。今の `--token` だけの使い方は、ほかの渡し方を足さないかぎり、そのまま動く。

### 2. ファイルの権限が 600 でないとき

起動を止める。読む前に `stat` で確かめ、次のどれかなら止める。

- 通常のファイルでない（ディレクトリなど）。シンボリックリンクは辿った先を見る（Kubernetes の secret のボリュームは、リンクの先に実体を置くため）。
- 権限に、グループか他人のビットがある（`(mode & 0o077) !== 0`）。600 と 400 は通る。

文面はパスと権限の 8 進数だけを書き、中身は書かない。

> Worker token file /run/secrets/takt-worker-token must not be accessible by group or others (mode 644). Run: chmod 600 /run/secrets/takt-worker-token

- 読んだ中身は、前後の空白と改行を落とす。空なら止める（「Worker token file ... is empty」）。中身の形は確かめない。形の誤りは、今と同じく daemon 側の登録の照合（`src/infra/worker-pool/workerRegistry.ts:16-18`）で「not registered」として返る。
- Windows では POSIX の権限が無いので、権限は確かめない。文書にそう書く。
- 権限は起動のときに 1 回だけ確かめる。起動のあとでファイルが変わっても読み直さない。

### 3. token をログやエラーに出さない

- 新しく足す文面（重なり、権限、空、`--token` の警告）は、渡し方の名前とパスだけを書く。
- ファイルの読みの失敗は、`ENOENT`・`EACCES` などの code とパスだけを書く。中身を含む例外の文面（JSON の解析など）は作らない。中身は解析しない。
- 接続のあとの文面は今のまま。遠隔の失敗の理由は、すでに token を `[REDACTED]` に置き換えている（`src/features/workerPool/remoteWorker.ts:85`）。

### 4. 子へ渡すときに引数に載せない

- 子の起動引数は今と同じく `process.execArgv` と入口だけにする。token を引数に足さない。
- 子へ渡す環境変数は、今の「値に token を含むものを除く」（`workerCommands.ts:29`）のままにする。`TAKT_WORKER_TOKEN` の値は token そのものなので、この除外で消える。重なりを止める（1 節）ので、`TAKT_WORKER_TOKEN` が別の値で残ることはない。
- `--token-file` のパスは子へ渡さない（環境変数にも引数にも載せない）。

### 5. `--token` の警告

`--token` が使われたら、接続の前に stderr に 1 行を出す。値は書かない。

> --token leaves the worker token in the process arguments, where other users of this machine can read it with ps. Use TAKT_WORKER_TOKEN or --token-file instead.

`--token` はこの設計では消さない。`commands.ts` のオプションの説明を「Worker registration token (deprecated: visible to ps; use TAKT_WORKER_TOKEN or --token-file)」にする。

### 6. 標準入力は使わない

worker は、クラウドの起動スクリプトやサービスから起動する（`docs/worker-pool.md:70-79`）。サービスの標準入力はたいてい `/dev/null` で、起動スクリプトから token を流し込む形は、環境変数やファイルより書き方が増える。環境変数とファイルで足りるので、標準入力は入れない。

## 直し方（muse が書く）

| ファイル | 場所 | 変えること |
|---|---|---|
| `src/features/workerPool/workerToken.ts`（新規） | `resolveWorkerToken(input: { token?: string; tokenFile?: string }, environment: NodeJS.ProcessEnv): { token: string; warnings: string[] }` | 1〜2 節のとおりに 1 つの渡し方を選び、ファイルなら権限を確かめて読む。`--token` なら 5 節の警告を返す |
| `src/app/cli/commands.ts:63-70` | `takt worker` | `--token-file <path>` を足す。`--url` が無いときだけを今の文面で止め、token は `resolveWorkerToken` に任せる。警告を stderr に書く。説明文から「using --url and --token」を「using --url and TAKT_WORKER_TOKEN or --token-file」にする |
| `docs/worker-pool.md:72-79`（ja・zh-CN も） | 起動スクリプト | 下の形に直し、「The token is passed as a process argument ...」の文を、環境変数とファイルの渡し方の説明に替える |
| `docs/cli-reference.md:133`（ja・zh-CN も） | `takt worker` の行 | `takt worker --url <url>` と、`TAKT_WORKER_TOKEN` / `--token-file <path>` / `--token <token>`（警告つき）を書く |
| `docs/design/worker-pool.md:87` | 例 | 環境変数の形にする |

起動スクリプトの新しい形（`docs/worker-pool.md`）。

```sh
#!/bin/sh
set -eu
: "${WORKER_DAEMON_URL:?Set the daemon HTTPS URL}"
: "${TAKT_WORKER_TOKEN:?Inject the worker registration token}"
export TAKT_WORKER_TOKEN
exec takt worker --url "$WORKER_DAEMON_URL"
```

ファイルで渡す形。

```sh
exec takt worker --url "$WORKER_DAEMON_URL" --token-file /run/secrets/takt-worker-token
```

## red のテスト（Sonnet が書く）

`docs/design/193-worker-pool-requests.md` の「#211」の節に、1 件 1 行で並べた。

## 決まったこと（元帥の答え、11/28）

1. 重なったら起動を止める。止める文に、どれとどれが重なったかを書き、token の値は書かない（1 節）。

## 上げる点

1. **`--token` をいつ消すか**。この設計では消さず、警告だけにした。消す時期は別に決める。
2. **権限の確かめが Windows で効かない**。Windows の利用者には、ファイルの ACL を自分で絞ることを文書で頼むだけになる。

## 範囲の外

- daemon 側の登録の token の保存と照合（`workerRegistry.ts`）。
- `takt worker add` が token を stdout に 1 回出す形（`workerCommands.ts:8-11`）。
- 接続の中で token を送る形（`Authorization: Bearer`）。
