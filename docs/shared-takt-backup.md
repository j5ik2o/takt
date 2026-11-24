# 共有 TAKT の設定と managed provider の日次バックアップ

フォークの共有 TAKT の設定置き場（`~/.takt`）を、1日1回、別の場所へ写す運用手順です。本家に提案する内容ではありません。

2026-11-24 に設定置き場が消え、ローカルスナップショットから復旧しました（[#112](https://github.com/j5ik2o/takt/issues/112)）。この手順は、同じことが起きたときに、設定と managed provider を前日の状態へ戻せるようにするためのものです。

この文書を書いた時点では、実機の `~/.takt` に対してどのコマンドも実行していません。動作は、一時ディレクトリに作った設定置き場で確かめています。実機での日次登録と保全先は、まだ決めていません（[日次の登録](#日次の登録)を参照）。

## 道具

`scripts/shared-takt-backup.mjs` を使います。Node.js だけで動きます。macOS と Linux が対象です。

| コマンド | すること |
|---|---|
| `backup` | 設定と managed provider を、新しい世代として保全先へ写す |
| `verify` | 世代の中身（内容、大きさ、権限）を記録と照合し、記録にないものが混ざっていないことも確かめる |

この道具が書き込むのは保全先だけです。設定置き場は読むだけで、復元のコマンドはありません。復元は、世代を別の場所へ手でコピーして確かめ、手で入れ替えます（[復元の確認](#復元の確認)、[実際に戻すとき](#実際に戻すとき)）。

## 写すもの

設定置き場の直下にある、次のものを写します。ないものは飛ばします。

- 設定: `config.yaml`、`runtime.yaml`、`preferences/`、`workflows/`、`facets/`、`personas/`、`agents/`、`schemas/`、`provider-options/`、`steps/`、`companions/`、`facet-pools/`、`repertoire/`
- managed provider: `claude-sdk/`、`codex/`、`opencode/`、`pi/`、`deepseek-harness/`。それぞれ、`sdk` リンクと、リンクが指している世代のディレクトリだけを写します。インストール途中の作業ディレクトリ、ロックファイル、使われなくなった古い世代は写しません。

次のものは写しません。

- 実行時の状態: `logs/`、`analytics/`、`workspaces/`、`conversations/`、`manager-inbox/`、`daemon.json` など、上の一覧にないもの

シンボリックリンクは、リンクのまま写します。ただし、リンクを実際にたどった先が、写す対象（`workflows/` や `pi/` など、上の一覧の1項目）の外になると、`backup` は失敗します（`EXTERNAL_LINK`）。絶対パスのリンク、たどれないリンク、対象そのものがリンクの場合（`workflows` が別の場所へのリンクなど）も同じです。`verify` も世代の中のリンクを同じ方法で確かめます。リンク先の中身は保全できず、世代をコピーして確かめるときに、コピーの外のファイルを読み書きすることになるためです。リンクを実ファイルに置き換えてから実行します。managed provider の中にあるリンク（`node_modules/.bin` など）は対象の中を指すので、そのまま写ります。

`config.yaml` は必須です。ない、空、または通常のファイルでないと、`backup` は失敗します（`CONFIG_MISSING`）。ファイルが1つもない対象があると、`note:` の行で知らせます。

## 保全先

保全先は `--dest` で指定します。既定の場所はありません。次のどれかに当たると、何も書かずに失敗します。

- 設定置き場の中にある、または設定置き場を含む（`DEST_OVERLAPS_SOURCE`）。写す対象の設定置き場、`TAKT_CONFIG_DIR` の場所、`~/.takt` の3つを、それぞれ確かめます。`--source` や `TAKT_CONFIG_DIR` で別の場所を指定していても、`~/.takt` は保全先にできません
- 保全先のパスの途中、または保全先そのものがシンボリックリンク（`DEST_IS_LINK`）。リンクを含まない実際のパスを指定します。macOS の `/tmp` は `/private/tmp` へのリンクなので、`/private/tmp/...` と書きます
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

世代は既定で7つ残します（`--keep` で変更）。世代どうしはファイルを共有しません。1つの世代が壊れても、ほかの世代には及びません。そのかわり、世代ごとに全量の容量を使います。5つの provider をすべて入れた設定置き場（52,404 ファイル）で、1世代あたり約 1.4GB でした。7世代で約 10GB、14世代で約 20GB になります。保全先を決めるときに、空き容量と `--keep` を合わせて決めます。

## 1回の実行

```sh
node scripts/shared-takt-backup.mjs backup --dest <保全先>
```

`--source` を省くと、`TAKT_CONFIG_DIR`、なければ `~/.takt` を写します。成功すると1行を出力して終了コード 0 で終わります。

```text
backup ok generation=20261124T180000Z files=18676 bytes=177454071 targets=config.yaml,runtime.yaml,opencode,pi
```

### 失敗したとき

新しい世代は、保全先の作業用ディレクトリに作ります。すべてのファイルが元と一致し、作った世代が `verify` と同じ照合に通ってから、`generations/` へ名前を付け替え、`latest` を向け、ログに記録します。古い世代を消すのは、その後です。`latest` を向けるまでのどこかで失敗した場合は、作りかけの世代を取り除いて終了コード 1 で終わります。取り除けなかった作りかけは、次の実行が最初に取り除き、残す世代の数には入れません。それまでの世代と `latest` は変わりません。

次の場合は失敗にします。

| 状況 | コード |
|---|---|
| 設定置き場がない | `SOURCE_MISSING` |
| 設定置き場に、写す対象のファイルが1つもない | `NOTHING_TO_COPY` |
| `config.yaml` がない、空、または通常のファイルでない | `CONFIG_MISSING` |
| たどった先が写す対象の外になるシンボリックリンクがある | `EXTERNAL_LINK` |
| `latest` の世代でファイルがあった対象が、今回はない、またはファイルが1つもない | `TARGET_DISAPPEARED` |
| `latest` の世代で中身のあったファイルが0バイトになっている | `FILE_EMPTIED` |
| 対象の中に、ファイル・ディレクトリ・リンク以外のものがある | `UNSUPPORTED_FILE` |
| managed provider の `sdk` リンクが、使える世代を指していない | `MANAGED_PROVIDER_BROKEN` |
| 写している間に、ファイルや `sdk` リンクが変わった（`takt install` と重なった場合など） | `SOURCE_CHANGED` |
| 前の世代の記録が壊れている | `GENERATION_DAMAGED` |
| 別のバックアップが実行中 | `LOCKED` |
| 前の実行がロックを残したまま終わった | `LOCK_STALE` |
| 読めないファイルがある、ディスクが足りないなど | OS のエラーコード（`EACCES`、`ENOSPC` など） |

`TARGET_DISAPPEARED` と `FILE_EMPTIED` は、設定置き場の一部が消えた、または空になったまま、欠けた世代で古い世代を押し出すのを防ぐためのものです。意図した変更の場合（provider をアンインストールした、ファイルを空にしたなど）は、1回だけ `--accept-removed` を付けて実行します。

`LOCK_STALE` のときは、メッセージにあるプロセスが動いていないことを確かめてから、保全先の `.lock` を消します。ロックを自動では引き継ぎません。2つの実行が同時に引き継ぐと、片方がもう片方の作りかけを消すことがあるためです。

新しい世代を作って `latest` を向けた後の失敗は2つあります。どちらも終了コード 1 で終わりますが、新しい世代は使えます。

- `LOG_FAILED`: ログに記録できなかった。古い世代は1つも消しません
- `PRUNE_FAILED`: 古い世代を消せなかった

失敗した日は、原因を直してから同じコマンドをもう一度実行します。

### ログ

端末と `backup.log` に出すのは、対象の名前、世代の名前、件数、結果、失敗のコードとパスだけです。ファイルの中身は出しません。この道具が想定していないエラーは、メッセージを出さず、種類だけを記録します。

`backup.log` には、保全先が使える状態なら、成功でも失敗でも1回の実行につき1行を書きます（`PRUNE_FAILED` のときだけ、成功の行と失敗の行の2行。`LOG_FAILED` のときは書けません）。保全先そのものが使えない場合（上の「保全先」の4つ）は、保全先に書かず、端末への出力と終了コードだけで知らせます。

```sh
tail -n 1 <保全先>/backup.log
```

## 復元の確認

バックアップが使えることを、実機の設定置き場に触れずに確かめる手順です。日次の登録を始めたときと、TAKT の版を切り替えた後に行います。すべて手で行います。コマンドを実行する前に、書き込み先が設定置き場でも保全先でもないことを、そのつど目で確かめます。

1. **世代を照合する。** `--generation` を省くと、`latest` が指す世代が対象です。出力の `targets=` に、その世代に入っている対象が並びます。

   ```sh
   node scripts/shared-takt-backup.mjs verify --dest <保全先>
   ```

2. **新しい一時ディレクトリへコピーする。** コピー先は `mktemp` で作った、ほかに何もないディレクトリの中にします。`cp -a` は、権限とリンクを保ってコピーします。

   ```sh
   RESTORE=$(mktemp -d /tmp/takt-restore.XXXX)
   echo "$RESTORE"                    # 設定置き場でも保全先でもないこと
   cp -a <保全先>/generations/<世代の名前>/data "$RESTORE/takt"
   ```

3. **コピーが世代と同じであることを確かめる。** 先に、コピーの外へ出るリンクがないことを確かめます。`backup` と `verify` はそういうリンクを通しませんが、ここでも確かめます。次のコマンドは、リンクを実際にたどった先がコピーの外になるものと、たどれないものを表示します。何も出力されなければ合格です。

   ```sh
   COPY=$(realpath "$RESTORE/takt")
   find "$COPY" -type l | while IFS= read -r link; do
     [ -e "$link" ] || { echo "$link"; continue; }
     case "$(realpath "$link" 2>/dev/null)" in "$COPY"/*) ;; *) echo "$link" ;; esac
   done
   ```

   続けて中身を比べます。何も出力されなければ同じです。認証情報の入るファイルの権限も見ます（`config.yaml` が元と同じ、通常は `-rw-------`）。

   ```sh
   diff -r <保全先>/generations/<世代の名前>/data "$RESTORE/takt"
   ls -l "$RESTORE/takt/config.yaml"
   ```

   managed provider の中にリンクの循環があると、`Directory loop detected` という行が出ることがあります。この行は違いではありません。

4. **設定の読み取りと managed provider の整合性を確かめる。** ビルド済みの TAKT のチェックアウト（`dist/` がある）で実行します。`TAKT_CONFIG_DIR` をコピー先に向けるので、TAKT はコピーだけを読みます。

   ```sh
   echo "$RESTORE/takt"               # 手順 2 のコピー先であること
   TAKT_CONFIG_DIR="$RESTORE/takt" node --input-type=module -e '
   const root = process.cwd() + "/dist/infra/";
   (await import(root + "config/global/globalConfigCore.js")).loadGlobalConfig();
   console.log("config: readable");
   const { inspectProviderInstallation } = await import(root + "managed-providers/loader.js");
   for (const provider of ["claude-sdk", "codex", "opencode", "pi", "deepseek-harness"]) {
     console.log(provider + ": " + (await inspectProviderInstallation(provider)).state);
   }'
   ```

   ```text
   config: readable
   claude-sdk: ready
   codex: ready
   opencode: ready
   pi: ready
   deepseek-harness: missing
   ```

   設定を読み込めないときは、`config: readable` が出ずにエラーで終わります。エラーの文には設定の値が含まれることがあるので、記録や連絡に貼るときは確かめます。provider ごとの行は、TAKT が `takt install` のときに行うのと同じ整合性確認（導入時に記録したハッシュとの照合と、SDK の読み込み）の結果です。

   | 表示 | 意味 |
   |---|---|
   | `ready` | 整合性確認に通り、使っている TAKT が指定する版と同じ |
   | `stale` | 整合性確認には通ったが、使っている TAKT が指定する版と違う。`takt update` で更新できる |
   | `missing` | 世代に入っていない（手順 1 の `targets=` にない）か、入っているが整合性確認に通らない |

   合格の条件は3つです。手順 1 の `targets=` に、`config.yaml` と、導入しているはずの provider がすべて並んでいること。`config: readable` が出ること。`targets=` にある provider が、すべて `ready` か `stale` であること。

   この確認は、TAKT のプログラムにコピー先を読ませます。TAKT の整合性確認は、確認した場所を修復することがあります。`TAKT_CONFIG_DIR` に実機の設定置き場を指定しないでください。

5. **一時ディレクトリを消す。**

   ```sh
   echo "$RESTORE"                    # 手順 2 で作った一時ディレクトリであること
   rm -rf "$RESTORE"
   ```

## 実際に戻すとき

設定置き場が消えた、または壊れたときの手順です。入れ替えは手で行います。常駐するコマンドと daemon の止め方は、[共有 TAKT の切替手順](shared-takt-switch.md)の手順 2 と 3 に従います。

1. **常駐するコマンドと daemon を止める。**
2. **使う世代を決める。** 「復元の確認」の手順 1〜4 を行い、合格する世代を選びます。最新の世代が壊れているときは、`verify --generation <名前>` で前の世代を確かめます。
3. **戻す中身を、設定置き場と同じディスクに用意する。** 設定置き場の外の、まだ存在しない場所へコピーし、手順 3 と同じ `diff` で確かめます。

   ```sh
   ls -d ~/takt-restore-<日付>         # No such file であること
   cp -a <保全先>/generations/<世代の名前>/data ~/takt-restore-<日付>
   diff -r <保全先>/generations/<世代の名前>/data ~/takt-restore-<日付>
   ```

4. **いまの設定置き場を確認して、別の名前へ移す。** 残っている場合だけ行います。消さずに残します。

   ```sh
   ls -la ~/.takt
   mv ~/.takt ~/.takt.broken-<日付>
   ```

5. **用意した中身を、設定置き場の場所へ移す。** 移す前に、`~/.takt` が存在しないことを確かめます。

   ```sh
   ls -d ~/.takt                      # No such file であること
   mv ~/takt-restore-<日付> ~/.takt
   ```

6. **`takt manager` を起動する。**

バックアップに入っていない実行時の状態（ワークスペースの登録、会話の記録など）は戻りません。`missing` になった provider は、`takt install <provider>` で入れ直します。世代の中のディレクトリは、所有者が書き込めない権限だった場合でも、所有者の書き込み権限を付けて保存しています。

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
