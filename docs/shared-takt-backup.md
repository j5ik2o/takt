# 共有 TAKT の設定と managed provider の日次バックアップ

フォークの共有 TAKT の設定置き場（`~/.takt`）を、1日1回、別の場所へ写す運用手順です。本家に提案する内容ではありません。

2026-11-24 に設定置き場が消え、ローカルスナップショットから復旧しました（[#112](https://github.com/j5ik2o/takt/issues/112)）。この手順は、同じことが起きたときに、設定と managed provider を前日の状態へ戻せるようにするためのものです。

この文書を書いた時点では、実機の `~/.takt` に対してどのコマンドも実行していません。動作は、一時ディレクトリに作った設定置き場で確かめています。実機での日次登録と保全先は、まだ決めていません（[日次の登録](#日次の登録)を参照）。

## 道具

`scripts/shared-takt-backup.mjs` を使います。Node.js だけで動き、TAKT のビルドは `check` のときだけ必要です。macOS と Linux が対象です。

| コマンド | すること |
|---|---|
| `backup` | 設定と managed provider を、新しい世代として保全先へ写す |
| `verify` | 世代の中身を、記録したハッシュと照合する |
| `restore` | 照合に通った世代を、空のディレクトリへ書き出す |
| `check` | 書き出したディレクトリで、設定の読み取りと managed provider の整合性確認を行う |

## 写すもの

設定置き場の直下にある、次のものを写します。ないものは飛ばします。

- 設定: `config.yaml`、`runtime.yaml`、`preferences/`、`workflows/`、`facets/`、`personas/`、`agents/`、`schemas/`、`provider-options/`、`steps/`、`companions/`、`facet-pools/`、`repertoire/`
- managed provider: `claude-sdk/`、`codex/`、`opencode/`、`pi/`、`deepseek-harness/`。それぞれ、`sdk` リンクと、リンクが指している世代のディレクトリだけを写します。インストール途中の作業ディレクトリ、ロックファイル、使われなくなった古い世代は写しません。

次のものは写しません。

- 実行時の状態: `logs/`、`analytics/`、`workspaces/`、`conversations/`、`manager-inbox/`、`daemon.json` など、上の一覧にないもの
- シンボリックリンクの先: リンクはリンクのまま写します。設定置き場の外を指すリンクがあると、`backup` は件数を `note:` の行で知らせます。リンク先の中身は保全されません

## 保全先

保全先は `--dest` で指定します。既定の場所はありません。

- 設定置き場の外に置きます。設定置き場の中、または設定置き場を含むディレクトリは拒否します。
- 所有者だけが読める場所にします。なければ `0700` で作ります。すでにあって、グループや他の利用者に権限がある場合は、何も書かずに失敗します（`chmod 700` で直します）。`config.yaml` には認証情報が入ることがあるためです。

保全先の中は次の形になります。

```text
<保全先>/
  generations/
    20261124T180000Z/     世代。名前は UTC の作成時刻
      manifest.json       対象、ファイルごとのパス・大きさ・権限・SHA-256
      data/               設定置き場と同じ相対パスの写し
  latest                  最新の世代を指すリンク
  backup.log              1回の実行につき1行（JSON）
```

世代は既定で7つ残します（`--keep` で変更）。前の世代と中身が同じファイルは、ハードリンクで共有します。managed provider は合計で 1GB を超えることがありますが、変わっていなければ世代を重ねても容量はほとんど増えません。

## 1回の実行

```sh
node scripts/shared-takt-backup.mjs backup --dest <保全先>
```

`--source` を省くと、`TAKT_CONFIG_DIR`、なければ `~/.takt` を写します。成功すると1行を出力して終了コード 0 で終わります。

```text
backup ok generation=20261124T180000Z files=18676 bytes=177454071 targets=config.yaml,runtime.yaml,opencode,pi
```

### 失敗したとき

新しい世代は、保全先の作業用ディレクトリに作ります。すべてのファイルが元のハッシュと一致してから、`generations/` へ名前を付け替えます。途中で失敗した場合は、作業用ディレクトリを消して終了コード 1 で終わります。それまでの世代と `latest` は変わりません。古い世代を消すのは、新しい世代ができた後だけです。

次の場合は失敗にします。

| 状況 | コード |
|---|---|
| 設定置き場がない | `SOURCE_MISSING` |
| 設定置き場に、写す対象が1つもない | `NOTHING_TO_COPY` |
| 前の世代で写した対象が、今回はない | `TARGET_DISAPPEARED` |
| managed provider の `sdk` リンクが、使える世代を指していない | `MANAGED_PROVIDER_BROKEN` |
| 写している間に、ファイルや `sdk` リンクが変わった（`takt install` と重なった場合など） | `SOURCE_CHANGED` |
| 別のバックアップが実行中 | `LOCKED` |
| 読めないファイルがある、ディスクが足りないなど | OS のエラーコード（`EACCES`、`ENOSPC` など） |

`TARGET_DISAPPEARED` は、設定置き場の一部が消えたまま、欠けた世代で古い世代を押し出すのを防ぐためのものです。対象を意図して消した場合（provider をアンインストールしたなど）は、1回だけ `--accept-removed` を付けて実行します。

失敗した日は、原因を直してから同じコマンドをもう一度実行します。

### ログ

端末と `backup.log` に出すのは、対象の名前、世代の名前、件数、結果、失敗のコードとパスだけです。ファイルの中身は出しません。この道具が想定していないエラーは、メッセージを出さず、種類だけを記録します。

```sh
tail -n 1 <保全先>/backup.log
```

`manifest.json` と `backup.log` は保全先の中にあり、保全先と同じく所有者だけが読めます。

## 復元の確認

バックアップが使えることを、実機の設定置き場に触れずに確かめる手順です。日次の登録を始めたときと、TAKT の版を切り替えた後に行います。

`check` は TAKT のプログラムを読み込むので、ビルド済みのチェックアウト（`dist/` がある）で実行します。別の場所にある TAKT を使うときは `--takt <そのディレクトリ>` を付けます。

1. **世代を照合する。**

   ```sh
   node scripts/shared-takt-backup.mjs verify --dest <保全先>
   ```

2. **一時ディレクトリへ書き出す。** 書き出し先は、存在しないか、空のディレクトリでなければなりません。中身のあるディレクトリには書きません。

   ```sh
   RESTORE=$(mktemp -d /tmp/takt-restore.XXXX)
   node scripts/shared-takt-backup.mjs restore --dest <保全先> --to "$RESTORE/takt"
   ```

   書き出しが途中で失敗した場合は、書き出し先を消してからやり直します。

3. **設定の読み取りと managed provider の整合性を確かめる。**

   ```sh
   node scripts/shared-takt-backup.mjs check --config-dir "$RESTORE/takt"
   ```

   ```text
   config: readable
   claude-sdk: ready
   codex: ready
   opencode: ready
   pi: ready
   deepseek-harness: absent
   check ok
   ```

   `check` は、書き出し先を `TAKT_CONFIG_DIR` にして、TAKT 自身の設定の読み込みと、`takt install` が行うのと同じ整合性確認（導入時に記録したハッシュとの照合と、SDK の読み込み）を実行します。provider ごとの結果は次のとおりです。

   | 表示 | 意味 |
   |---|---|
   | `ready` | 整合性確認に通り、使っている TAKT が指定する版と同じ |
   | `stale` | 整合性確認には通ったが、使っている TAKT が指定する版と違う。`takt update` で更新できる |
   | `absent` | バックアップに入っていない（もともと導入していない） |
   | `missing` | バックアップに入っているが、整合性確認に通らない |

   `config: unreadable` か `missing` が1つでもあると、`check failed` を出して終了コード 1 で終わります。

4. **一時ディレクトリを消す。**

   ```sh
   rm -rf "$RESTORE"
   ```

## 実際に戻すとき

設定置き場が消えた、または壊れたときの手順です。常駐するコマンドと daemon の止め方は、[共有 TAKT の切替手順](shared-takt-switch.md)の手順 2 と 3 に従います。

1. 常駐するコマンドと daemon を止めます。
2. 設定置き場が残っている場合は、消さずに別の名前へ移します（`mv ~/.takt ~/.takt.broken-<日付>`）。`restore` は中身のあるディレクトリへは書きません。
3. 「復元の確認」の手順 1〜3 を、一時ディレクトリに対して行います。`check ok` になる世代を選びます。最新の世代が壊れているときは、`--generation <名前>` で前の世代を指定します。
4. その世代を設定置き場へ書き出します。

   ```sh
   node scripts/shared-takt-backup.mjs restore --dest <保全先> --generation <名前> --to ~/.takt
   ```

5. `takt manager` を起動します。

バックアップに入っていない実行時の状態（ワークスペースの登録、会話の記録など）は戻りません。`missing` になった provider は、`takt install <provider>` で入れ直します。

## 日次の登録

実機での登録と保全先は、副元帥と調整してから決めます。この文書の時点では登録していません。決めることは次の3点です。

- 保全先（設定置き場と同じディスクでよいか、別のディスクにするか）
- 実行する時刻（実行中の作業が少ない時間帯。`takt install` と重なると `SOURCE_CHANGED` で失敗します）
- 失敗の知らせ方（終了コードと `backup.log` の `result` を、何が見るか）

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
