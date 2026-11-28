# URL userinfo の伏せ漏れ（`@` の連続と空ユーザー）

対象: #2103 の差分の先端 `7eb4f0f433a1acb95aa96b09ae3ce4a545cacdd4`。
この文書と、下記「テスト」の red テストだけを先端へ足す。実装はまだ変えない。

## 範囲

直すのは `src/shared/utils/sensitive-text.ts:67` の `URL_USERINFO_CREDENTIALS_REGEX` 1本だけ。

- 表示: `sanitizeSensitiveText` の `.replace(URL_USERINFO_CREDENTIALS_REGEX, ...)`（`src/shared/utils/sensitive-text.ts:188`）
- ストリーム: `sensitiveTextRanges`（`src/shared/utils/sensitive-text.ts:351`、`src/shared/utils/sensitive-stream.ts:12` の `maskingRanges` から呼ばれる）

同じ正規表現を両方が使うので、1本の変更で表示とストリームが同時に直る。`bareAssignments`（同 :317）と `collectEmbeddedSensitiveValues`（同 :222）も同じ式から範囲・値を取るため、変更は自動的に追従する。

今回の範囲外（意図的に変えない）:

- パスワードの途中にある `@`。ユーザー情報は最初の `@` で終わる、という現行の解釈を維持する（`https://u:left@right@host` は `https://[REDACTED]@right@host`）。
- パスワードが空の形（`https://u:@host`）。伏せる秘密が無いので変更しない。
- 伏せた値の「裸の再出現」を表示側で探す仕組み（`sanitizeSensitiveTextWithKnownValues`）。今回は資格情報そのものの範囲だけを扱う。

## 現状（先端の実測）

`Zq24Zq` を実行時に組み立てた秘密として、表示とストリーム（`write` + `flush`）の両方を実測した。

| 入力 | 先端の表示 | 先端のストリーム |
| --- | --- | --- |
| `https://u:@@<secret>@host` | 変化なし（漏れる） | 変化なし（漏れる） |
| `redis://:<secret>@host` | 変化なし（漏れる） | 変化なし（漏れる） |
| `https://u:@@@<secret>@host` | 変化なし（漏れる） | 変化なし（漏れる） |
| `https://u:@@<secret>@host;TOKEN=<other>` | `...@host;TOKEN=[REDACTED]`（URL は漏れる） | 同左 |
| `https://u:@@<secret>@host,next` | 変化なし（漏れる） | 変化なし（漏れる） |
| `redis://::<secret>@host` | `redis://[REDACTED]@host` | 同左 |
| `https://u:::<secret>@host` | `https://[REDACTED]@host` | 同左 |
| `https://host:8080/path@v2` | 変化なし | 変化なし |
| `https://host:8080/path` | 変化なし | 変化なし |
| `git@github.com:owner/repo.git` | 変化なし | 変化なし |
| `mail <secret>@example.test before noon` | 変化なし | 変化なし |

## 原因

```
(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s@][^/?#\s@:]*:(?:@[^/?#\s@]+|[^/?#\s@]+))@
```

1. パスワード部 `(?:@[^/?#\s@]+|[^/?#\s@]+)` は「先頭 `@` がちょうど1個」か「先頭 `@` が0個」しか表さない。`u:@@secret@host` は `@` が2個なのでどちらの代替も失敗する。
2. ユーザー部 `[^/?#\s@][^/?#\s@:]*` は1文字以上を要求する。`scheme://:password@host` は `://` の直後が `:` なので一致しない。

`https://::word@host` が直っているのは、ユーザー部が最初の `:` を1文字として飲み、2つ目の `:` を区切りとして読むため。空ユーザーを省いた形（コロン1つ）は読めない。

## 不変条件

- I1 先端の式が一致する入力は、変更後の式でも同じ範囲に一致する（置換結果が変わらない）。
- I2 置換する範囲は `://` の直後から、ユーザー情報を終える `@` の直前まで。scheme、終端の `@`、host、範囲外の文字は1文字も変えない。
- I3 一致しない入力は出力＝入力（他の規則が当たらない限り）。
- I4 1つの `://` について、走査はユーザー部の最初の `:` までと、パスワード部の `@` 以外の連続だけを読む。コロンの総当たりをしない。
- I5 表示とストリームは同じ範囲を伏せる（同じ行を1チャンクで流した場合）。
- I6 空パスワードは伏せない（秘密が無い）。パスワード途中の `@` は最初の `@` で終端する（範囲外、現行どおり）。
- I7 入力長 n に対して時間は O(n)。`@` の連続があっても二次にならない。

## 正規表現の変更案

### 案1（採用）

```
/(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)((?:[^/?#\s@][^/?#\s@:]*)?:(?:@*[^/?#\s@]+))@/g
```

差分は2箇所だけ。

- ユーザー部: `[^/?#\s@][^/?#\s@:]*` → `(?:[^/?#\s@][^/?#\s@:]*)?`（空ユーザーを許可）
- パスワード部: `(?:@[^/?#\s@]+|[^/?#\s@]+)` → `@*[^/?#\s@]+`

パスワード部は言語として上位互換である。元の2つの代替は「先頭 `@` が1個」と「0個」を分けていただけで、`@*` はその和集合に「2個以上」を足したもの。ユーザー部の `?` も、元の1回以上の繰り返しに空を足しただけ。したがって I1 は式の形から自明で、置換文字列 `$1[REDACTED]@` も変えない。

### 案2（却下）: 2本目の正規表現を足す

既存の式はそのまま残し、`(?:@+[^/?#\s@]+)` 用と空ユーザー用の2本目を後段に足す。

却下の理由:

- 置換（表示 :188）、範囲（:351）、収集（:222 と :317）の3箇所で、同じ境界を2本の式に分けて維持することになる。片方だけ更新されて表示とストリームがずれる事故が起きやすい。
- 2本目が同じ `://` 配下を再走査するので、`@` 連続の入力で同じ領域を2度読む。利点が無い。

### 線形性（I7）の根拠

- 起点は従来どおり `://` で、可変長 lookbehind が直前の scheme を1回だけ読む。式の開始位置を scheme の先頭にしないので、`-` や英字の連続を後ろから数え直さない。
- ユーザー部は `[^/?#\s@][^/?#\s@:]*` で、`:` を含まない。区切り候補は各 `://` につき高々1個（空ユーザーを試す分を足しても2回）。コロンを総当たりしない。
- パスワード部 `@*[^@]+` の失敗時: `@` の連続長を N、その後の `@` 以外の尾を m とすると、`@*` は N, N-1, …, 0 を試すが、各段は直後の1文字を見て即座に失敗する。最後の1段だけが `[^@]+` で尾を m 読み、終端 `@` を探して失敗する。合計 O(N+m)。
- したがって `https://` + `:` の連続、`https://u:` + `@` の連続、`https://u:` + `@` の連続 + 尾、のいずれも入力長に線形。既存の性能試験（`src/__tests__/sensitive-text-sanitize.performance.test.ts`）の入力形も、ユーザー部の試行が1回増えるだけで走査は増えない。

## 壊しうる入力と期待

「変更後」は案1を一時的に当てて実測した値（実装コミットには含めない）。

| 入力 | 変更後の期待 | 先端 |
| --- | --- | --- |
| `https://u:@@<secret>@host` | `https://[REDACTED]@host` | 漏れる（red） |
| `redis://:<secret>@host` | `redis://[REDACTED]@host` | 漏れる（red） |
| `https://u:@@@<secret>@host` | `https://[REDACTED]@host` | 漏れる（red） |
| `https://u:@@<secret>@host;TOKEN=<other>` | `https://[REDACTED]@host;TOKEN=[REDACTED]` | URL が漏れる（red） |
| `https://u:@@<secret>@host,next`（`, & \| ; ' "` も同様） | `https://[REDACTED]@host,next` | 漏れる（red） |
| `redis://::<secret>@host` | `redis://[REDACTED]@host` | 一致（green） |
| `https://u:::<secret>@host` | `https://[REDACTED]@host` | 一致（green） |
| `https://host:8080/path@v2` | 変化なし | 一致（green） |
| `https://host:8080/path` | 変化なし | 一致（green） |
| `git@github.com:owner/repo.git` | 変化なし | 一致（green） |
| `mail <secret>@example.test before noon` | 変化なし | 一致（green） |
| `https://[2001:db8::1]:8080/path` | 変化なし | 一致（green） |
| `https://u:@host`（空パスワード） | 変化なし | 一致（green） |
| `https://u:@@host`（空パスワード + `@`） | 変化なし | 一致（green） |
| `https://u:left@right@host` | `https://[REDACTED]@right@host`（最初の `@` で終端） | 一致（green） |
| 同じ資格情報が2回 | 2箇所とも `[REDACTED]` | 漏れる（red） |

`https://[2001:db8::1]:8080/path` は、`[` をユーザー部の1文字として読み `2001` の後の `:` を区切りにするが、パスワード部が `/` で止まり `@` に届かないので一致しない。空ユーザーの分岐も直後が `[` なので成立しない。

## PBT（`src/__tests__/sensitiveTextUserinfo.pbt.test.ts`）

fast-check 4.11.0。除外なし（`fc.pre`、`filter`、`fc.assume` を使わない）。生成器は性質が成立する入力だけを作り、条件付きで捨てない。

### 性質

1. 秘密は漏れない: 生成した資格情報のパスワードは、表示にもストリームにも現れない。`[REDACTED]` は現れる。（`numRuns: 200`）
2. 資格情報が無い入力は出力＝入力: `@` も敏感キー語も作れないアルファベットから作った文字列は、表示・ストリーム・ランダムな位置で2分割したストリームのいずれでも1文字も変わらない。（`numRuns: 200`）
3. 伏せる範囲の外は1文字も変えない: 前置き + `scheme://` + ユーザー情報 + `@` + host + 後置き の形で、出力が `前置き + scheme://[REDACTED]@ + host + 後置き` に一致し、先頭の `前置き + scheme://` と末尾の `host + 後置き` がそのまま残る。（`numRuns: 200`）
4. 入力長4倍で時間が定数倍: `@` の連続（終端あり・なし・尾あり）と `:` の連続について、4倍の長さの表示 sanitize が元の 12 倍 + 5ms 以内、かつ 250ms 未満。ウォームアップ後に3回測って最速を採る。（`numRuns: 40`）

性質4には絶対上限の補助として、同じファイルに 64KiB / 256KiB の固定サイズ試験（500ms / 2000ms、既存の性能試験と同じ予算）を置く。時間は環境依存なので、比の下限を 0.5ms にしてタイマー分解能の影響を避ける。

### 生成器

- scheme: `https`, `http`, `redis`, `ftp`, `git+https`, `ssh`, `a`
- ユーザー: `''`, `u`, `user`, `alice`（空ユーザーを必ず含む）
- パスワード先頭の `@` の個数: 0〜4
- 秘密: `['Zq','24','01','fake','FAKE']` から2〜4個を連結（高エントロピーにしない。実行時に組み立て、ファイルに秘密らしい文字列を置かない）
- host: `host`, `example.test`, `127.0.0.1`, `cache.local:6379`
- 前置き: `''`, `clone `, `failed: `, `"`, `'`, `(`（scheme の lookbehind が語境界を見るよう、キー文字で終わらせない）
- 後置き: `''`, ` failed`, `/repo.git`, `\n`, `,next`, `;ok`, `"`, `)`（`@` を含めない）

## テスト

`src/__tests__/sensitiveText.test.ts` に追加（既存テストは変更・削除しない）:

- U1 `https://u:@@<secret>@host` / U2 `redis://:<secret>@host` の表示・1チャンクのストリーム・全分割位置のストリーム・preview・同じ URL の2回出現
- 伏せてはいけない入力: `https://host:8080/path@v2`、`https://host:8080/path`、`git@github.com:owner/repo.git`、メールアドレス入りの文、IPv6 host
- 敵対的入力: `@` 3個、`::`、`:::`、`;TOKEN=`、区切り `, & | ; ' "`（空白なし）、空パスワード（`https://u:@host`、`https://u:@@host`）、パスワード途中の `@`

`src/__tests__/sensitiveTextUserinfo.pbt.test.ts`（新規、`tsconfig.tests.json` に追加）: 上の性質1〜4と固定サイズの線形性。

fast-check は devDependency に `4.11.0` で固定して追加した（`package.json`、`package-lock.json`、`flake.nix` の `npmDepsHash`）。テストだけの依存で、本番の `src` は変えない。

## 実測（先端 `7eb4f0f43`）

```
npx vitest run src/__tests__/sensitiveText.test.ts src/__tests__/sensitiveTextUserinfo.pbt.test.ts
Tests  18 failed | 441 passed (459)
```

落ちた18件:

- `U1 ... > in the displayed text` / `in the text written in one chunk to the stream` / `at every stream chunk boundary and in the preview` / `when the same URL appears twice`
- `U2 ...` の同じ4件
- `redacts userinfo followed by three leading at signs`
- `redacts userinfo followed by a following TOKEN assignment without a space`
- `redacts the userinfo before a , / & / | / ; / ' / " separator with no space`（6件）
- PBT 性質1（最小反例 `https://:ZqZq@host`）
- PBT 性質3（同じ最小反例）

通ったもの（意図どおり）: 伏せてはいけない入力の5件、空パスワード2件、パスワード途中の `@`、`::` / `:::`、PBT 性質2、PBT 性質4、固定サイズの線形性4件。

案1を一時的に当てた状態では、`sensitiveText.test.ts`・`sensitiveTextUserinfo.pbt.test.ts`・`sensitive-text-streaming.test.ts`・`sensitive-text-sanitize.performance.test.ts`（heavy IT）の計 583 + 14 件がすべて通った。当てた差分は破棄済みで、`src/shared/utils/sensitive-text.ts` は先端のまま。

## 未確認

- 実際の修正コミットはまだ無い。案1が通ることは一時適用で確認したが、実装・レビューは別の作業。
- `nix build .#default` は実行していない。`npmDepsHash` は `prefetch-npm-deps`（`npmDepsFetcherVersion = 2`）で `package-lock.json` から計算した値。
- `npm run sync:nix-deps -- --check` は、fast-check 以外の範囲内更新（`@types/node` など）を差分として報告する。これは先端でも同じ種類の差分で、今回の lock は fast-check と `pure-rand` の追加だけに絞ってある。
- パスワード途中の `@` と空パスワードは範囲外のまま。必要なら別 issue。
