# 一時的なフォーク差分（PR #58）

このドキュメントは、本家 `nrslib/takt` 側で根本修正が入るまでの間、フォークが保持する一時的な差分と、その取り込み時の衝突処理・破棄手順をまとめた運用手順です。本家に提案する内容ではありません。

ここに書く SHA・日時・ファイル一覧は、ローカル Git と GitHub API から実測した値だけを載せています。取得できなかった内容は「未確認」と明記します。

## 1. PR #58 は一時的な差分である

PR #58 は、本家のコードにある 2 か所の負荷構造を緩和するためだけの暫定差分です。本家で根本修正が入るまでの間だけ保持し、恒久対策はフォークへ作り込みません。

目的の緩和策は 2 点です。

1. **索引による読み取りの使い回し** — daemon が `director-notifications` の全件を毎回読み直す代わりに、ディレクトリの状態が変わらない間は読み込み済みの内容を使い回す。
2. **定期更新の間隔の 2 秒化** — manager の画面が接続中に定期更新する間隔を 2 秒にする。

### 実測できた範囲

PR #58 の実体は、フォーク `j5ik2o/takt` の PR #58 です。`gh api repos/j5ik2o/takt/pulls/58` の実測は次のとおりです。

- `base`: `integration/takt-mcp`、`head`: `fix/daemon-idle-spin`、`merge_commit_sha`: `9954d436`、`changed_files`: 8、`additions`: 182、`deletions`: 15。
- ローカルにも `9954d436` が存在し、`git show --stat 9954d436` は `Merge pull request #58 from j5ik2o/fix/daemon-idle-spin`（マージ日時 `2026-11-17 07:45:03 +0900`、親 `76fba770` と `f05d0988`）を示します。
- ブランチ内のコミットは `fb1f11b1`（`fix(daemon): director-notifications の読み取りを索引で使い回す`）と `f05d0988`（`fix(manager): 定期更新の間隔を 2 秒にする`）です。

**本家 `nrslib/takt` の PR #58 は存在しません。** `gh api repos/nrslib/takt/pulls/58` は HTTP 404 を返します。PR #58 はフォーク側の番号です。

**manager が 2026-11-17 に確認（日時・出典付き）:** 本家 `nrslib/takt` の PR #58 は 404、フォーク `j5ik2o/takt` の PR #58 は merged（`merged_at` `2026-11-16T22:45:03Z`、head `f05d0988`、base `integration/takt-mcp`）。取得経路は `gh pr view 58 --repo j5ik2o/takt --json state,headRefOid,baseRefName,mergedAt` と `gh api repos/nrslib/takt/pulls/58` です。この実測により、PR #58 がフォーク側の番号であることは未確認ではなく確定です。

PR #58 が触った 8 ファイルは、`git diff --name-only 76fba770 9954d436` の実測で次のとおりです。

- `src/infra/daemon/notifications.ts`（索引 `index`・`prepared`・`refresh()` を追加）
- `src/features/manager/ManagerView.tsx`（`MANAGER_REFRESH_INTERVAL_MS = 2_000` を追加し、定期更新の間隔に使う）
- `src/__tests__/daemon-notifications.test.ts`（新規、6 テスト）
- `src/__tests__/helpers/manager-tui-startup.ts`
- `src/__tests__/it-manager-compact-display.test.ts`
- `src/__tests__/manager-conversation-client.integration.test.ts`
- `scripts/test-classification.mjs`（`fileSystemIntegrationTestFiles` に 1 行追加）
- `tsconfig.tests.json`（`daemon-notifications.test.ts` を 1 行追加）

`src/infra/daemon/notifications.ts` の変更内容は次のとおりです。

- `index: { stamp, values }` と `prepared` を追加。
- `iterate()` を `refresh()` 経由に変更。`refresh()` は `stat` で `dev`・`ino`・`mtimeMs` から stamp を作り、stamp が変わらなければ保持済みの値を返す。ディレクトリの列挙では、未読のファイル名だけを読む。
- `save()` の書き込み成功時に `this.index.stamp = undefined` で索引を無効化する。
- `iterate()` は `structuredClone` で複製を返す。

`src/features/manager/ManagerView.tsx` の変更内容は次のとおりです。

- `export const MANAGER_REFRESH_INTERVAL_MS = 2_000;` を追加（`9954d436` の `ManagerView.tsx:46`）。
- 接続中の定期 refresh の `setInterval` を `}, 500)` から `}, MANAGER_REFRESH_INTERVAL_MS)` に変更（同 `:278`）。
- `src/features/director/DirectorView.tsx` は PR #58 で変更されておらず、`setInterval` の間隔は `500` のまま（`9954d436` の `DirectorView.tsx:52`）。

### 前提の確認と未確認の点

- **`9545cc81` は PR #58 のコミットではありません。** `9545cc81` はローカルの dangling commit（`fix(daemon): director-notifications の読み取りを索引で使い回す`、親 `7483ead2`）で、`git merge-base --is-ancestor 9545cc81 9954d436` は偽です。PR #58 で同じ主題を扱うコミットは `fb1f11b1`（親 `76fba770`）です。両者は `notifications.ts` の読み取り呼び出しが異なり、`9545cc81` は `readEntirePrivateFile` を、`fb1f11b1` は `readPrivateFile(path, 1024 * 1024)` を使います。
- **本家 main の周期は 2 秒化されていません。** 2026-11-17 に upstream/main（`2125aceaf`）で再実測した結果、本家 main の `DirectorView.tsx:52` と `ManagerView.tsx:334` の `setInterval` はともに `}, 500)` で、`MANAGER_REFRESH_INTERVAL_MS` は存在しません。2 秒化はフォーク（PR #58）にだけ入っています。取得経路は `gh api repos/nrslib/takt/commits/main`（先端 `2125aceaf576b77f6c637f347def897b636998e2`）と `gh api repos/nrslib/takt/contents/<path>?ref=2125aceaf576b77f6c637f347def897b636998e2` です。この作業ツリーには upstream リモートが無く（`git remote -v` が空）`2125aceaf` もローカルオブジェクトに無いため、`git fetch upstream main` の経路は再現できず、取得は上記 API によります。

## 2. 次の本家取り込みで #2048 と衝突する見込み

PR #58 の差分は `src/infra/daemon/notifications.ts` を変更します。本家の #2048 も同じファイルを変更しているため、次の本家取り込みでこのファイルが衝突する見込みです。

### #2048 の実測内容

本家 `nrslib/takt` の #2048 は、`gh api repos/nrslib/takt/pulls/2048` の実測で `merge_commit_sha` が `cdd8d968`、`state` が `closed`、`merged_at` が `2026-11-16T15:38:18Z` です。

ローカルにも `cdd8d968` が存在し、`fix: ツール履歴と daemon 通信で容量上限による失敗をなくす (#2048)`（コミット日時 `2026-11-17 00:38:17 +0900`、作者 `nrs`）です。

`src/infra/daemon/notifications.ts` に対する #2048 の変更は、`readPrivateFile(path, 1024 * 1024)` を `readEntirePrivateFile(path)` に置き換えるものです（`save()` の 2 か所と `iterate()` の 1 か所）。あわせて `src/infra/daemon/privateFile.ts` に `readEntirePrivateFile` と `appendPrivateFile` を追加し、通知を含む業務データの読み取りから 1 MiB の上限を外しています。

`src/__tests__/daemon-storage.integration.test.ts` には、`reads back a saved director notification larger than 1 MiB and recognizes its duplicate` というテストが追加されています。

### 前提とするツリーと、前提を判定する条件

**§3 の衝突手順と §4.2 の打ち消し手順は、`notifications.ts` が #2048 を取り込んだ状態のツリーを前提にしています。** この前提は、PR #58 のマージ `9954d436` でも、現行フォーク HEAD `72916b6d` でも満たされません。作業前に自分のツリーがどれかを判定してください。

実測した関係は次のとおりです。

- `git rev-parse HEAD` は `72916b6d`（この文書を書いた時点のフォーク HEAD）。
- `git merge-base --is-ancestor cdd8d968 9954d436` は**偽**。PR #58 は #2048 を取り込んでいません。
- `git merge-base --is-ancestor cdd8d968 HEAD` も**偽**。現行 HEAD も #2048 を取り込んでいません。
- PR #58 の `notifications.ts` は、#2048 とは逆に `readPrivateFile(path, 1024 * 1024)` を使い続け、`privateFile.ts` にも `readEntirePrivateFile` を持ちません（`9954d436` の `notifications.ts:6`・`:29`・`:30`・`:64` と `privateFile.ts` の export を実測）。

**前提ツリーの判定条件** — `src/infra/daemon/notifications.ts` を見て決めます。

| 観測点 | #2048 取り込み済み（`cdd8d968` の状態） | 未取り込み（PR #58 `9954d436` と現行 HEAD `72916b6d`） |
|--------|----------------------------------------|-------------------------------------------------------|
| `privateFile.js` からの import 行 | `readEntirePrivateFile` を含む | `readPrivateFile` のみ |
| `notification` スキーマの `conversationId` | ある | PR #58 は ある（`fb1f11b1` 由来）／現行 HEAD は ない |
| 読み取り呼び出し | `readEntirePrivateFile(path)` | `readPrivateFile(path, 1024 * 1024)` |
| `src/infra/daemon/privateFile.ts` の export | `readEntirePrivateFile` と `appendPrivateFile` を含む | `readPrivateFile` と `writePrivateFile` のみ |

現行 HEAD の実測値は、`notifications.ts:6` が `readPrivateFile` を import し、`:24`・`:25`・`:44` が `readPrivateFile(path, 1024 * 1024)` を呼び、`notification` スキーマに `conversationId` がありません。`privateFile.ts` の export は `hasCode`・`ensurePrivateDirectory`・`readPrivateFile`・`writePrivateFile` のみです。

**したがって PR #58 をそのまま取り込んだツリーも、現行 HEAD も、§3.2 が前提とする「本家の `readEntirePrivateFile` 呼び出し」を持っていません。** 以下の手順は、この判定に従って条件を選んでから実行してください。

### 衝突点

`src/infra/daemon/notifications.ts` のうち、次の 2 か所が重なります。

- `privateFile.js` からの import 行（#2048 は `readPrivateFile` を `readEntirePrivateFile` に差し替える）。
- `save()` / `iterate()` / `refresh()` 内の読み取り呼び出し（#2048 は `readEntirePrivateFile` を、PR #58 は `readPrivateFile(path, 1024 * 1024)` を使う）。

## 3. 衝突を意図的に処理する手順

### 3.1 対象ファイル

`git diff --name-only 76fba770 9954d436` の実測で、PR #58 が触ったファイルは次の 8 つです。

| ファイル | 衝突の見込み | 方針 |
|----------|--------------|------|
| `src/infra/daemon/notifications.ts` | あり（§2 の 2 か所） | 前提ツリーの判定に従う（§3.2）。#2048 取り込み済みなら本家側の `readEntirePrivateFile` 呼び出しを採用し、その上に索引（`index`・`prepared`・`refresh()`）の差分を残す。未取り込みなら索引を当てず、`readEntirePrivateFile` への置換も混入させない |
| `src/features/manager/ManagerView.tsx` | 低（本家が同じ箇所を変えた場合のみ） | `MANAGER_REFRESH_INTERVAL_MS = 2_000` と、それを使う `setInterval` を維持する。本家が同じ定数を別の値で導入していれば、本家の値を優先し、フォークの 2 秒化は捨てる |
| `src/__tests__/daemon-notifications.test.ts` | なし（新規ファイル） | そのまま残す。本家が同名ファイルを追加した場合は本家を優先し、こちらの 6 テストを統合する |
| `src/__tests__/helpers/manager-tui-startup.ts` | 低 | `MANAGER_REFRESH_INTERVAL_MS` を import して待機時間に使う差分を維持する。本家側が待機時間を別の方法で定めていれば本家に合わせる |
| `src/__tests__/it-manager-compact-display.test.ts` | 低 | `MANAGER_REFRESH_INTERVAL_MS` で時間を進める差分を維持する |
| `src/__tests__/manager-conversation-client.integration.test.ts` | 低 | `MANAGER_REFRESH_INTERVAL_MS` で `setInterval` の間隔を検証する差分を維持する |
| `scripts/test-classification.mjs` | 低（1 行追加） | 1 行の追加を維持する。並び順が衝突した場合は `fileSystemIntegrationTestFiles` のアルファベット順に挿入する |
| `tsconfig.tests.json` | 低（1 行追加） | 1 行の追加を維持する。`releaseVerificationWiring.test.ts` が「一覧がソート済みで、載せたファイルが実在する」ことを検証するため、並び順と実在の両方を満たす |

### 3.2 どちらを残すか

前提ツリーの判定（§2「前提とするツリーと、前提を判定する条件」）で **#2048 取り込み済み** と判定した場合に限り、`src/infra/daemon/notifications.ts` で衝突したときは **本家の変更を優先し、その上に索引の差分を載せ直します**。理由は、#2048 の容量上限の撤去が本家の契約変更であり、フォークの緩和策より先に成立するためです。

具体的には次の順で解決します。

1. 本家側の `readEntirePrivateFile` 呼び出しと import をそのまま採用する。
2. 索引の状態（`index`・`prepared`）と `refresh()` の stamp 判定・差分読み込みを、本家の読み取り呼び出し（`readEntirePrivateFile`）の上に付け直す。PR #58 側の `readPrivateFile(path, 1024 * 1024)` を残さない。
3. `save()` の `this.index.stamp = undefined` を維持する（索引の無効化が抜けると、保存直後の読み取りが古い内容を返す）。
4. 索引の再利用で本家の新しい契約（1 MiB 超の通知を読めること）が壊れていないことを確認する。

**未取り込み** と判定した場合は、上の 1–4 を実行しません。PR #58 をそのまま取り込んだツリーと現行 HEAD はこちらに当たります。この場合は次の 2 つを守ってください。

- 索引の差分を当てない。`index`・`prepared`・`refresh()` を持たないツリーへ索引を載せると、保存直後の読み取りが古い内容を返す経路（`save()` の `this.index.stamp = undefined` が無いまま）を作ってしまう。
- `readEntirePrivateFile` への置換を混入させない。`privateFile.ts` に `readEntirePrivateFile` が無いツリーへ呼び出しだけを入れると、存在しない関数の参照になる。#2048 の取り込みは本家の変更として別に行う。

未取り込みのツリーで実際に起きる衝突は、本家の変更を取り込んだ結果として #2048 相当の内容が入った後になります。その時点で前提判定をやり直し、#2048 取り込み済みの手順へ進んでください。

### 3.3 検証

衝突を解決したら、次の順で確認します。

1. **該当テストの単独実行** — PR #58 が変更したテストを、`npm test -- <test-file>` で 1 本ずつ実行する。実行可能なのは、そのファイルが存在するツリーだけである。
   - `src/__tests__/daemon-notifications.test.ts`（新規 6 テスト。PR #58 側で `scripts/test-classification.mjs` の `fileSystemIntegrationTestFiles` に登録済み）
   - `src/__tests__/it-manager-compact-display.test.ts`
   - `src/__tests__/manager-conversation-client.integration.test.ts`
2. **索引の挙動** — `daemon-notifications.test.ts` の 6 テストで次を確認する。
   - `does not read notification files again when the directory is unchanged` — ディレクトリが変わらなければ再度読まない。
   - `reads only the newly saved file after save()` — `save()` 後は新しく保存したファイルだけを読む。
   - `reflects files added and removed by another writer` — 別の書き手による追加・削除を反映する。
   - `returns copies that callers cannot use to change later results` — 呼び出し元が結果を書き換えられない。
   - `returns false when a notification with the same subject and state is already saved` — 同じ subject と state の保存は `false`。
   - `keeps failing on a broken notification file` — 壊れた通知ファイルでは失敗し続ける。
3. **周期の挙動** — `src/features/manager/ManagerView.tsx` の `setInterval` の第 2 引数が `MANAGER_REFRESH_INTERVAL_MS`（`2_000`）であり、`src/features/director/DirectorView.tsx` の `setInterval` は `500` のままであることを実測する。`it-manager-compact-display.test.ts` と `manager-conversation-client.integration.test.ts` は、この定数で時間を進め、間隔が `MANAGER_REFRESH_INTERVAL_MS` であることを検証する。
4. **#2048 の容量契約** — #2048 を取り込んだツリーでのみ、`src/__tests__/daemon-storage.integration.test.ts` の `reads back a saved director notification larger than 1 MiB and recognizes its duplicate` を実行し、1 MiB 超の通知が索引経由でも読めることを確認する。#2048 未取り込みのツリーにはこのテストの前提が無い。
5. **分類・配線の整合** — `npm test -- src/__tests__/releaseVerificationWiring.test.ts` を単独実行し、分類リストと `tsconfig.tests.json` の整合、および載せたファイルの実在を確認する。

## 4. 本家に同等の修正が入ったら差分を捨てる条件

### 4.1 捨てる条件（判定方法）

本家 main に次の 2 つが**両方**入ったことを確認できたら、PR #58 の差分は役目を終えたと判断します。判定はファイル・関数・テストの有無で行います。

**(a) 索引による読み取りの使い回し相当**

次のいずれかを `src/infra/daemon/notifications.ts` で確認する。

- `DaemonNotifications` に `refresh` メソッドがある、または `index` / `prepared` に相当する読み込み済みの保持がある。
- ディレクトリの状態（`stat` の `mtimeMs` など）を比較して、変化がなければ再読み込みを省く分岐がある。
- `src/__tests__/daemon-notifications.test.ts` が存在し、§3.3 の「ディレクトリが変わらなければ再度読まない」に相当するテストを含む。

**(b) 周期の変更相当**

次のいずれかを確認する。

- `src/features/manager/ManagerView.tsx` の、接続中の定期更新を行う `setInterval` の間隔が `500` より長くなっている（PR #58 の意図は 2 秒）。
- その間隔を定数として一元化した定義がある（PR #58 では `MANAGER_REFRESH_INTERVAL_MS`）。

### 4.1.1 現時点の実測結果

**2026-11-17 に upstream/main（`2125aceaf`）で再実測しました。** 結果は次のとおりで、**現時点で (a) も (b) も偽**であり、PR #58 の差分はまだ役目を終えていません。取得経路は `gh api repos/nrslib/takt/commits/main`（先端 `2125aceaf576b77f6c637f347def897b636998e2`）と `gh api repos/nrslib/takt/contents/<path>?ref=2125aceaf576b77f6c637f347def897b636998e2` です。この作業ツリーには upstream リモートが無く（`git remote -v` が空）、`2125aceaf` もローカルオブジェクトに無いため、`git fetch upstream main` の経路は再現できません。

- (a): `src/infra/daemon/notifications.ts` は 52 行です。import は `ensurePrivateDirectory, readEntirePrivateFile, writePrivateFile` で、読み取りは `readEntirePrivateFile`（`:6`・`:25`・`:26`・`:45`）です。`refresh`・`index`・`prepared`・`stamp` は含みません（索引による読み取りの使い回しは無い）。`src/__tests__/daemon-notifications.test.ts` も 404 で、本家 main にこのテストは存在しません。
- (b): `src/features/director/DirectorView.tsx:52` は `}, 500)`、`src/features/manager/ManagerView.tsx:334` は `}, 500)` で、`MANAGER_REFRESH_INTERVAL_MS` は存在しません。

この結果は取得時点（2026-11-17、upstream/main `2125aceaf`）のものです。取り込み前に再度取得して確認してください。

片方だけが入った場合は、捨てずに残りの差分だけを保持します（(a) だけなら索引の差分を捨てて周期の差分を残し、(b) だけならその逆）。

### 4.2 捨てる手順

PR #58 のマージを取り消すのではありません。**以降の取り込みで本家側の実装を優先し、フォークの差分を revert する**手順を取ります。

打ち消しの対象は、前提ツリーの判定（§2）で決まります。

1. 本家 main を取り込み、`src/infra/daemon/notifications.ts` は本家側の実装を採用する。
2. フォーク固有の差分（索引と、周期を変更していればその差分）を打ち消すコミットを作る。マージコミット自体の取り消し（`git revert -m 1 <merge>`）はしない。
3. 打ち消しの対象は次のとおり。**索引を持たないツリー（現行 HEAD など）では、下の最初の項目（索引）は対象外です。** 打ち消す索引が存在しないため、この場合は残りの項目だけを扱います。
   - `src/infra/daemon/notifications.ts` の索引（`index`・`prepared`・`refresh()`）。索引が存在するツリーでのみ対象。
   - `src/features/manager/ManagerView.tsx` の `MANAGER_REFRESH_INTERVAL_MS` と、それを `setInterval` に使う差分。本家が同等の周期変更を入れた場合はそちらを優先し、フォーク側の定数と使用箇所を打ち消す。本家が 2 秒化を入れていない場合は打ち消さない（(b) が偽のため）。
   - `src/__tests__/daemon-notifications.test.ts`（本家に同等のテストが入っていれば削除、入っていなければ本家のテストへ統合）。ファイルが存在する場合のみ対象。
   - `src/__tests__/helpers/manager-tui-startup.ts`・`src/__tests__/it-manager-compact-display.test.ts`・`src/__tests__/manager-conversation-client.integration.test.ts` の、`MANAGER_REFRESH_INTERVAL_MS` を参照する差分。`MANAGER_REFRESH_INTERVAL_MS` を打ち消す場合は同じ変更で戻す。
   - `scripts/test-classification.mjs` と `tsconfig.tests.json` の、削除したテストに対応する 1 行。`tsconfig.tests.json` は「載せたファイルが実在する」ことを検証するため、テストファイルを消す場合は同じ変更でこの行も消す。該当行が存在する場合のみ対象。
4. 打ち消し後に `npm test -- src/__tests__/releaseVerificationWiring.test.ts` を単独実行し、分類リストと型チェック対象の整合が崩れていないことを確認する。
5. 打ち消し後に、本家側の挙動が成立していることを確認する（§3.3 のテスト単独実行と索引・周期の確認が、本家側のテスト名で通ること）。
