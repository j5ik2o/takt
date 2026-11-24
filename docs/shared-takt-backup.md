# 共有 TAKT の設定と managed provider の日次バックアップ

フォークの共有 TAKT の設定置き場（`~/.takt`）を、1日1回、別の場所へ写す運用手順です。本家に提案する内容ではありません。

2026-11-24 に設定置き場が消え、ローカルスナップショットから復旧しました（[#112](https://github.com/j5ik2o/takt/issues/112)）。この手順は、同じことが起きたときに、設定と managed provider を前日の状態へ戻せるようにするためのものです。

この文書を書いた時点では、実機の `~/.takt` に対してどのコマンドも実行していません。動作は、一時ディレクトリに作った設定置き場で確かめています。実機での日次登録と保全先は、まだ決めていません（[日次の登録](#日次の登録)を参照）。

## 道具

`scripts/shared-takt-backup.mjs` を使います。Node.js だけで動き、TAKT のビルドは `check` のときだけ必要です。macOS と Linux が対象です。

| コマンド | すること |
|---|---|
| `backup` | 設定と managed provider を、新しい世代として保全先へ写す |
| `verify` | 世代の中身（内容、大きさ、権限）を、記録と照合する |
| `restore` | 照合に通った世代を、新しいディレクトリへ書き出す |
| `check` | 書き出したディレクトリを世代の記録と照合し、設定の読み取りと managed provider の整合性確認を行う |

どのコマンドも、設定置き場には書き込みません。`backup` は設定置き場を読むだけです。`restore` と `check` は、設定置き場と重なる場所を指定すると何もせずに失敗します。設定置き場へ戻す操作は、利用者が手で行います（[実際に戻すとき](#実際に戻すとき)）。

## 写すもの

設定置き場の直下にある、次のものを写します。ないものは飛ばします。

- 設定: `config.yaml`、`runtime.yaml`、`preferences/`、`workflows/`、`facets/`、`personas/`、`agents/`、`schemas/`、`provider-options/`、`steps/`、`companions/`、`facet-pools/`、`repertoire/`
- managed provider: `claude-sdk/`、`codex/`、`opencode/`、`pi/`、`deepseek-harness/`。それぞれ、`sdk` リンクと、リンクが指している世代のディレクトリだけを写します。インストール途中の作業ディレクトリ、ロックファイル、使われなくなった古い世代は写しません。

次のものは写しません。

- 実行時の状態: `logs/`、`analytics/`、`workspaces/`、`conversations/`、`manager-inbox/`、`daemon.json` など、上の一覧にないもの
- シンボリックリンクの先: リンクはリンクのまま写します。設定置き場の外を指すリンクがあると、`backup` は件数を `note:` の行で知らせます。対象そのものがリンクの場合（`workflows` が別の場所へのリンクなど）や、ファイルが1つもない場合も、`note:` の行で知らせます。リンク先の中身は保全されません

## 保全先

保全先は `--dest` で指定します。既定の場所はありません。次のどれかに当たると、何も書かずに失敗します。

- 設定置き場の中にある、または設定置き場を含む。リンクをたどった先が設定置き場の中になる場合も同じです（`DEST_OVERLAPS_SOURCE`）。`--source` で別の場所を写すときも、使用中の設定置き場（`TAKT_CONFIG_DIR`、なければ `~/.takt`）は同じように保全先にできません
- 保全先そのものがシンボリックリンク（`DEST_IS_LINK`）
- 所有者以外に権限がある（`DEST_NOT_PRIVATE`。`chmod 700` で直します）。`config.yaml` には認証情報が入ることがあるためです。保全先がなければ `0700` で作ります
- 保全先の中の `generations` や `backup.log` が、この道具の作るものと違う（シンボリックリンクになっている、`backup.log` がほかのファイルへのハードリンクになっているなど。`DEST_UNSAFE`）

保全先の中は次の形になります。

```text
<保全先>/
  generations/
    20261124T180000Z/     世代。名前は UTC の作成時刻
      manifest.json       対象、ファイルごとのパス・大きさ・権限・SHA-256
      data/               設定置き場と同じ相対パスの写し
  latest                  最新の世代を指すリンク
  backup.log              実行の記録（JSON、1行ずつ）
```

ファイルの権限は元と同じにします（`config.yaml` が `0600` なら、写しも `0600`）。`verify` は、内容に加えて権限が記録と同じかも確かめます。

世代は既定で7つ残します（`--keep` で変更）。世代どうしはファイルを共有しません。1つの世代が壊れても、ほかの世代には及びません。そのかわり、世代ごとに全量の容量を使います。pi と opencode だけを入れた設定置き場で、1世代あたり約 240MB でした。5つの provider をすべて入れると 1GB を超える見込みで、7世代では 8GB 前後になります。保全先を決めるときに、空き容量と `--keep` を合わせて決めます。

## 1回の実行

```sh
node scripts/shared-takt-backup.mjs backup --dest <保全先>
```

`--source` を省くと、`TAKT_CONFIG_DIR`、なければ `~/.takt` を写します。成功すると1行を出力して終了コード 0 で終わります。

```text
backup ok generation=20261124T180000Z files=18676 bytes=177454071 targets=config.yaml,runtime.yaml,opencode,pi
```

### 失敗したとき

新しい世代は、保全先の作業用ディレクトリに作ります。すべてのファイルが元と一致し、作った世代が `verify` と同じ照合に通ってから、`generations/` へ名前を付け替え、`latest` を向け、ログに記録します。古い世代を消すのは、その後です。どこかで失敗した場合は、作りかけの世代を取り除いて終了コード 1 で終わります。それまでの世代と `latest` は変わりません。

次の場合は失敗にします。

| 状況 | コード |
|---|---|
| 設定置き場がない | `SOURCE_MISSING` |
| 設定置き場に、写す対象のファイルが1つもない | `NOTHING_TO_COPY` |
| `latest` の世代でファイルがあった対象が、今回はない、またはファイルが1つもない | `TARGET_DISAPPEARED` |
| `config.yaml` が0バイト、または `latest` の世代で中身のあったファイルが0バイトになっている | `FILE_EMPTIED` |
| 対象の中に、ファイル・ディレクトリ・リンク以外のものがある | `UNSUPPORTED_FILE` |
| managed provider の `sdk` リンクが、使える世代を指していない | `MANAGED_PROVIDER_BROKEN` |
| 写している間に、ファイルや `sdk` リンクが変わった（`takt install` と重なった場合など） | `SOURCE_CHANGED` |
| 前の世代の記録が壊れている | `GENERATION_DAMAGED` |
| 別のバックアップが実行中 | `LOCKED` |
| 前の実行がロックを残したまま終わった | `LOCK_STALE` |
| 読めないファイルがある、ディスクが足りないなど | OS のエラーコード（`EACCES`、`ENOSPC` など） |

`TARGET_DISAPPEARED` と `FILE_EMPTIED` は、設定置き場の一部が消えた、または空になったまま、欠けた世代で古い世代を押し出すのを防ぐためのものです。意図した変更の場合（provider をアンインストールした、ファイルを空にしたなど）は、1回だけ `--accept-removed` を付けて実行します。

`LOCK_STALE` のときは、メッセージにあるプロセスが動いていないことを確かめてから、保全先の `.lock` を消します。ロックを自動では引き継ぎません。2つの実行が同時に引き継ぐと、片方がもう片方の作りかけを消すことがあるためです。

新しい世代を作れた後で、古い世代を消せなかった場合は `PRUNE_FAILED` になります。新しい世代は使えます。

失敗した日は、原因を直してから同じコマンドをもう一度実行します。

### ログ

端末と `backup.log` に出すのは、対象の名前、世代の名前、件数、結果、失敗のコードとパスだけです。ファイルの中身は出しません。この道具が想定していないエラーは、メッセージを出さず、種類だけを記録します。

`backup.log` には、保全先が使える状態なら、成功でも失敗でも1回の実行につき1行を書きます（`PRUNE_FAILED` のときだけ、成功の行と失敗の行の2行）。保全先そのものが使えない場合（上の「保全先」の4つ）は、保全先に書かず、端末への出力と終了コードだけで知らせます。

```sh
tail -n 1 <保全先>/backup.log
```

## 復元の確認

バックアップが使えることを、実機の設定置き場に触れずに確かめる手順です。日次の登録を始めたときと、TAKT の版を切り替えた後に行います。

`check` は TAKT のプログラムを読み込むので、ビルド済みのチェックアウト（`dist/` がある）で実行します。別の場所にある TAKT を使うときは `--takt <そのディレクトリ>` を付けます。

1. **世代を照合する。** `--generation` を省くと、`latest` が指す世代が対象です。

   ```sh
   node scripts/shared-takt-backup.mjs verify --dest <保全先>
   ```

2. **新しいディレクトリへ書き出す。** 書き出し先は、まだ存在しない場所を指定します。すでにある場所（空でも）、設定置き場やその中、保全先の中は拒否します。

   ```sh
   RESTORE=$(mktemp -d /tmp/takt-restore.XXXX)
   node scripts/shared-takt-backup.mjs restore --dest <保全先> --to "$RESTORE/takt"
   ```

   書き出しが途中で失敗した場合は、書き出し先を消してからやり直します。

3. **書き出した中身を確かめる。**

   ```sh
   node scripts/shared-takt-backup.mjs check --dest <保全先> --config-dir "$RESTORE/takt"
   ```

   ```text
   generation: 20261124T180000Z
   restored: complete
   config: readable
   claude-sdk: ready
   codex: ready
   opencode: ready
   pi: ready
   deepseek-harness: absent
   check ok
   ```

   `check` は次の3つを確かめます。

   - `restored`: 世代の記録にあるものが、書き出し先にすべて同じ内容・同じ権限であること。欠けや違いがあると、最初の1件のパスと理由を出します
   - `config`: 書き出し先を `TAKT_CONFIG_DIR` にして、TAKT 自身が設定を読み込めること
   - provider ごとの行: TAKT が `takt install` のときに行うのと同じ整合性確認（導入時に記録したハッシュとの照合と、SDK の読み込み）

   | 表示 | 意味 |
   |---|---|
   | `ready` | 整合性確認に通り、使っている TAKT が指定する版と同じ |
   | `stale` | 整合性確認には通ったが、使っている TAKT が指定する版と違う。`takt update` で更新できる |
   | `absent` | 世代に入っていない（もともと導入していない） |
   | `missing` | 世代に入っているが、整合性確認に通らない |

   `restored` が `complete` でない、`config` が `unreadable`、`missing` が1つでもある、のどれかで `check failed` を出し、終了コード 1 で終わります。`restored` が `complete` でないときは、そこで打ち切ります（`config: not checked`）。設定の読み込みと provider の確認は行いません。

   TAKT の整合性確認は、確認した場所を修復することがあります。そのため `check` も、設定置き場やその中を `--config-dir` に指定すると拒否します。

4. **一時ディレクトリを消す。**

   ```sh
   rm -rf "$RESTORE"
   ```

## 実際に戻すとき

設定置き場が消えた、または壊れたときの手順です。この道具は設定置き場へ書き込まないので、最後の入れ替えは手で行います。常駐するコマンドと daemon の止め方は、[共有 TAKT の切替手順](shared-takt-switch.md)の手順 2 と 3 に従います。

1. **常駐するコマンドと daemon を止める。**
2. **使う世代を決める。** 「復元の確認」の手順 1〜3 を行い、`check ok` になる世代を選びます。最新の世代が壊れているときは、`--generation <名前>` で前の世代を指定します。書き出し先は、設定置き場と同じディスクの、設定置き場の外にします（例: `~/takt-restore-<日付>/takt`。親の `~/takt-restore-<日付>` は先に `mkdir` で作ります）。この書き出し先を、そのまま次の手順で使います。
3. **いまの設定置き場を確認して、別の名前へ移す。** 残っている場合だけ行います。消さずに残します。

   ```sh
   ls -la ~/.takt
   mv ~/.takt ~/.takt.broken-<日付>
   ```

4. **書き出した中身を、設定置き場の場所へ移す。** 移す前に、`~/.takt` が存在しないことを確かめます。

   ```sh
   ls -d ~/.takt                      # No such file であること
   mv ~/takt-restore-<日付>/takt ~/.takt
   ```

5. **`takt manager` を起動する。**

バックアップに入っていない実行時の状態（ワークスペースの登録、会話の記録など）は戻りません。`missing` になった provider は、`takt install <provider>` で入れ直します。

## 日次の登録

実機での登録と保全先は、副元帥と調整してから決めます。この文書の時点では登録していません。決めることは次の4点です。

- 保全先（設定置き場と同じディスクでよいか、別のディスクにするか）と、残す世代の数（1世代ごとに全量の容量を使います）
- 実行する時刻（実行中の作業が少ない時間帯。`takt install` と重なると `SOURCE_CHANGED` で失敗します）
- 失敗の知らせ方（終了コードと `backup.log` の `result` を、何が見るか）
- 実行時の状態（`workspaces/` など）を対象に加えるか

登録の例です。macOS では launchd を使います。`~/Library/LaunchAgents/jp.takt.shared-backup.plist` に次の内容を置き、`launchctl bootstrap gui/$(id -u) <plist のパス>` で登録します。パスは実際の場所に置き換えます。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>jp.takt.shared-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/takt/scripts/shared-takt-backup.mjs</string>
    <string>backup</string>
    <string>--dest</string>
    <string>/path/to/backup</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
```

cron を使う場合は次の1行です。

```text
0 4 * * * /path/to/node /path/to/takt/scripts/shared-takt-backup.mjs backup --dest /path/to/backup
```

スクリプトは、切替で消えない場所（版ごとのディレクトリではなく、更新を続けるチェックアウトなど）から実行します。
