# URL userinfo の伏せ漏れ（`@` の連続、パスワードの途中の `@`、空ユーザー、裸の再出現）

- 対象: 上流 [nrslib/takt#2103](https://github.com/nrslib/takt/pull/2103) の出し直しの枝 `j5ik2o/upstream-2103-t1t5-local`（先端 669116f6b）。上流 main は a1794751a。
- 点検: [#204](https://github.com/j5ik2o/takt/issues/204)（T2〜T5 の試験の弱さ）、別件 [#212](https://github.com/j5ik2o/takt/issues/212)（scheme の前の `_`・数字、host の無い形）
- 元帥の決定（11/28）に沿って、前の版（669116f6b）の範囲と試験の置き方を直した。上流へは何もしていない。

## 結論

1. **パスワードの途中の `@`**（`https://u:left@<秘密>@host`）を今回の差分で直す。パスワード部を「先頭の `@` の連続 + 最初の片 + 区切りを含まない片を `@` でつないだもの」にする。`https://host:8080/path@v2`・`git@github.com:owner/repo.git`・メールアドレス入りの文は、今と同じ出力のままである。
2. **裸の再出現**（`https://u:@@<秘密>@host echo <秘密>`）は、ストリームと `sanitizeSensitiveTextWithKnownValues` では今回で直し、表示（`sanitizeSensitiveText`）では直さない。ストリームと既知の値の API は、上流 main にもう「同じ文から見つけた値を別の場所でも伏せる」仕組みがあり、パスワードから先頭の `@` を落とした値をそこへ渡すだけで済む。表示にはその仕組みが無く、上流 main の単純な形（`https://u:<秘密>@host echo <秘密>`）でも表示は伏せない。表示で直すには新しい仕組みが要るので、PR の文に「直らない」と書き、フォークの issue にする。
3. 変える本番は `src/shared/utils/sensitive-text.ts` の 2 か所（67 行の正規表現と、283 行の `addCredentialComponents`）だけ。
4. 上流へ出す差分には fast-check を入れない。上流には固定の例だけを出し、PBT と時間の性質はフォークだけの試験にする。

## 1. パスワードの途中の `@`

### 変更

```
変更前（a1794751a）:
/(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s@][^/?#\s@:]*:[^/?#\s@]+)@/g
先端（669116f6b）:
/(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s@][^/?#\s@:]*:(?:@[^/?#\s@]+|[^/?#\s@]+))@/g
変更後:
/(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)((?:[^/?#\s@][^/?#\s@:]*)?:@*[^/?#\s@]+(?:@[^/?#\s@;,&|'"]+)*)@/g
```

- ユーザー部: `(?:[^/?#\s@][^/?#\s@:]*)?`。前の版の案1と同じで、空のユーザー（`redis://:<秘密>@host`）を許す。
- パスワード部: `@*[^/?#\s@]+(?:@[^/?#\s@;,&|'"]+)*`。先頭の `@` の連続（`@@<秘密>`）、最初の片、そのあとに `@` で続く片を読む。
- `@` のあとに続く片は、区切り `; , & | ' "` を含まないものだけをつなぐ。区切りを含む片の手前の `@` で userinfo を終える。

### 区切りを含む片でつなぐのを止める理由

「最後の `@` まで読む」だけにすると、URL のすぐ後ろに続く代入まで userinfo に入る。試作で確かめた。

- `curl https://u:p@host;TOKEN=left@<秘密>`（既存の T7）は、`host;TOKEN=left` までが userinfo になり、`<秘密>` が host として出る。`TOKEN=` の代入は userinfo の中では読まない（`bareAssignments`、`sensitive-text.ts:310-317`）ので、`<秘密>` を伏せる規則が無くなる。
- 既存の W5（`https://u:Zq12Zq@host;TOKEN=left@Zq13Zq;...`）も同じ形で `Zq13Zq`・`Zq15Zq` が出た。

WHATWG の URL の読み方（Node の `new URL`）は最後の `@` で区切る（`https://u:p@host,me@example.test` の password は `p%40host,me`）。文の中の URL は、うしろに区切りで別のものが続くことが多いので、区切りを含む片はつながない。区切りの集合は、先端の試験が「空白なしの区切り」として並べる 6 文字（`sensitiveText.test.ts` の `, & | ; ' "` の群）と同じにした。

この形で残る漏れ（記録する。今回は直さない）:

- パスワードの途中の片が区切りを含む形（`https://u:<L>@a;<秘密>@host` → `https://[REDACTED]@a;<秘密>@host`）。上流 main でも同じ出力である。

### 線形性の根拠

- 起点は前と同じ `://` で、lookbehind が直前の scheme を 1 回だけ読む。各 `://` から読む範囲は、`/ ? #` か空白で終わる authority の中だけである。次の `://` は `/` を含むので、2 つの `://` の読む範囲は重ならない。
- ユーザー部は `:` を含まないので、区切りの候補は各 `://` につき最初の `:` の 1 つ（空のユーザーを試す分を足して 2 回）。コロンを総当たりしない。
- パスワード部の片はどれも `@` で区切られ、1 つの片の中に `@` は無い。片への分け方は入力から 1 通りに決まる。照合が最後に `@` を見つけられないときは、うしろの片から 1 つずつ戻し、戻すたびに次の 1 文字（`@` か否か）を見て決まる。片の中の長さを縮める戻りも、次の文字が `@` でないことで 1 文字ずつ失敗する。どの文字も、片ごとに定数回しか読まない。
- 先頭の `@*` は、うしろの `[^/?#\s@]+` が `@` を読まないので、`@` の連続の長さ N に対して N 回の戻りで終わる。
- 試作の実測（表示の `sanitizeSensitiveText`、3 回の最速、64 KiB と 256 KiB）では、4 倍の長さで時間も 3.75〜4.41 倍だった。形は `@` の連続（終端あり・なし）、`a@` の連続 + `;`、`@a` の連続（終端なし）、`@a;` の連続、`:` の連続、`a://u:p@` の繰り返し、scheme に似た長い列の 8 つ。既存の `src/__tests__/sensitive-text-sanitize.performance.test.ts`（14 件）は試作のまま通った。

## 2. 裸の再出現

### 上流 main（a1794751a）の仕組み

- 表示 `sanitizeSensitiveText`（`sensitive-text.ts:180-200`）は、正規表現の置換と、実行の秘密（`executionSecrets`）の置換だけをする。同じ文の中で見つけた値を、文の別の場所で探す段は無い。
- ストリームは、確定した文ごとに `maskingRanges`（`sensitive-stream.ts:12-17`）が `collectEmbeddedSensitiveValues` で値を集め、`sensitiveTextRanges`（`sensitive-text.ts:331` 以降）の `knownValueRanges` が文の中のその値をすべて伏せる。
- `sanitizeSensitiveTextWithKnownValues`（`sensitive-value.ts:108-111`）も、別の入力から集めた値で文を伏せる。
- URL の userinfo から集める値は、userinfo 全体と、最初の `:` のうしろ（`addCredentialComponents`、`sensitive-text.ts:275-283`）である。`u:@@<秘密>` からは `@@<秘密>` を集めるので、`echo <秘密>` の `<秘密>` には当たらない。

### 判断

- ストリームと既知の値の API は、仕組みがすでにあり、集める値に「先頭の `@` の連続を落としたパスワード」を足すだけで直る。差分は `addCredentialComponents` の 2〜3 行で、`sensitive-text.ts` に収まる。今回で直す。
- 表示は、上流 main の単純な形 `https://u:<秘密>@host echo <秘密>` でも `echo <秘密>` を伏せない（下の表）。表示で直すには、表示が自分の文から値を集めて伏せる新しい段が要る。今回は直さない。
- パスワードの途中の `@` の片（`https://u:<L>@<秘密>@host echo <秘密>`）は、集める値が `<L>@<秘密>` なので、ストリームでも `<秘密>` を伏せない（ストリームは接頭辞の重なりで末尾の `Zq` だけを伏せる）。片に分けて集めると、短い片が文の中の同じ語をすべて伏せるので、今回は分けない。

### PR の文に書くこと

- `- When a redacted URL password appears again elsewhere in the same text, the displayed text (sanitizeSensitiveText) still shows it; this was already the case before this PR (for example https://u:<secret>@host echo <secret>). Streaming and known-value redaction now also hide a password that starts with "@" when it reappears.`
- `- A password whose later "@"-separated part reappears on its own (https://u:<left>@<secret>@host echo <secret>) is not hidden where it reappears.`

### フォークの issue にすること（中将が起こす）

- 題: 表示の伏せは、同じ文の中で見つけた秘密の再出現を伏せない（ストリームとずれる）
- 本文の要点: 上流 main でも `https://u:<秘密>@host echo <秘密>` は表示が `echo <秘密>`、ストリームが `echo [REDACTED]`。表示にも同じ文から集めた値を伏せる段を入れるか、表示とストリームの差を決まりとして書くか。パスワードの途中の `@` の片の再出現も同じ issue に入れる。

## 3. 変更前と変更後の出力

「変更後」は 1 と 2 の変更を作業ツリーに一時的に当てた試作の出力で、測ったあと `git checkout -- src/shared/utils/sensitive-text.ts` で戻した。`<S>`・`<L>`・`<T>` は実行時に部品をつないで作った作り物の秘密（`Zq24Zq`・`Zq01Zq`・`Zq31Zq`）。表示は `sanitizeSensitiveText(text, [])`、ストリームは `createSensitiveTextStreamRedactor()` の `write(text, {}) + flush({})`。

### 1（パスワードの途中の `@` と `@` の連続、空ユーザー）

| 入力 | 変更前の表示 | 変更前のストリーム | 変更後の表示 | 変更後のストリーム |
|---|---|---|---|---|
| `https://u:@@<S>@host` | 変化なし | 変化なし | `https://[REDACTED]@host` | `https://[REDACTED]@host` |
| `https://u:<L>@<S>@host` | `https://[REDACTED]@<S>@host` | 同左 | `https://[REDACTED]@host` | `https://[REDACTED]@host` |
| `https://u:<L>@<S>@<T>@host` | `https://[REDACTED]@<S>@<T>@host` | 同左 | `https://[REDACTED]@host` | `https://[REDACTED]@host` |
| `redis://:<S>@host` | 変化なし | 変化なし | `redis://[REDACTED]@host` | `redis://[REDACTED]@host` |
| `https://u:@@<S>@host,next` | 変化なし | 変化なし | `https://[REDACTED]@host,next` | 同左 |
| `https://u:@@<S>@host;TOKEN=<T>` | `https://u:@@<S>@host;TOKEN=[REDACTED]` | 同左 | `https://[REDACTED]@host;TOKEN=[REDACTED]` | 同左 |
| `https://u:<L>@<S>@host;TOKEN=left@<T>` | `https://[REDACTED]@<S>@host;TOKEN=[REDACTED]` | 同左 | `https://[REDACTED]@host;TOKEN=[REDACTED]` | 同左 |
| `https://u:<L>@<S>@host,next` | `https://[REDACTED]@<S>@host,next` | 同左 | `https://[REDACTED]@host,next` | 同左 |
| `curl https://u:<L>@host;TOKEN=left@<T>`（T7 の形） | `curl https://[REDACTED]@host;TOKEN=[REDACTED]` | 同左 | 同左（変わらない） | 同左 |
| `curl https://u:@<L>@host,TOKEN=left@<T>`（T4 の形） | `curl https://u:@<L>@host,TOKEN=[REDACTED]` | 同左 | `curl https://[REDACTED]@host,TOKEN=[REDACTED]` | 同左 |
| `https://alice:@<L>;token=<T>@host`（T5 の形） | `https://alice:@<L>;token=[REDACTED]` | 同左 | `https://[REDACTED]@host` | 同左 |
| `https://u:<L>@a;<S>@host`（区切りを含む片。残る漏れ） | `https://[REDACTED]@a;<S>@host` | 同左 | 同左（変わらない） | 同左 |
| `https://u:<S>@host,me@example.test` | `https://[REDACTED]@host,me@example.test` | 同左 | 同左（変わらない） | 同左 |
| `https://host:8080/path@v2` | 変化なし | 変化なし | 変化なし | 変化なし |
| `git@github.com:owner/repo.git` | 変化なし | 変化なし | 変化なし | 変化なし |
| `mail <S>@example.test before noon` | 変化なし | 変化なし | 変化なし | 変化なし |
| `https://[2001:db8::1]:8080/path` | 変化なし | 変化なし | 変化なし | 変化なし |
| `https://u:@host`（空パスワード） | 変化なし | 変化なし | 変化なし | 変化なし |
| `https://u:@@host`（空パスワード + `@`） | 変化なし | 変化なし | 変化なし | 変化なし |
| `https://u:@@<S>@`（host 無し。#212） | 変化なし | 変化なし | `https://[REDACTED]@` | `https://[REDACTED]`（表示とずれる） |

T4・T5 の形の変化は、先端（669116f6b）の直し（bfed9b62e、7eb4f0f43）がすでに入れたもので、1 の変更で変わったものではない。この表で先端と変更後の出力が違うのは、`@` の連続（2 個以上）、パスワードの途中の `@`、空ユーザー、host 無しの行だけである。

### 2（裸の再出現）

| 入力 | 変更前の表示 | 変更前のストリーム | 変更後の表示 | 変更後のストリーム |
|---|---|---|---|---|
| `https://u:<S>@host echo <S>`（単純な形） | `https://[REDACTED]@host echo <S>` | `https://[REDACTED]@host echo [REDACTED]` | 同左（変わらない） | 同左（変わらない） |
| `https://u:@@<S>@host echo <S>` | 変化なし | 変化なし | `https://[REDACTED]@host echo <S>` | `https://[REDACTED]@host echo [REDACTED]` |
| `https://u:@<S>@host echo <S>`（T1 の形） | 変化なし | 変化なし | `https://[REDACTED]@host echo <S>` | `https://[REDACTED]@host echo [REDACTED]` |
| `redis://:<S>@host echo <S>` | 変化なし | 変化なし | `redis://[REDACTED]@host echo <S>` | `redis://[REDACTED]@host echo [REDACTED]` |
| `https://u:<L>@<S>@host echo <S>` | `https://[REDACTED]@<S>@host echo <S>` | `https://[REDACTED]@<S>@host echo Zq24[REDACTED]` | `https://[REDACTED]@host echo <S>` | `https://[REDACTED]@host echo Zq24[REDACTED]` |

`sanitizeSensitiveTextWithKnownValues('echo <S>', { command: ... })` の結果:

| command | 変更前 | 変更後 |
|---|---|---|
| `https://u:<S>@host` | `echo [REDACTED]` | `echo [REDACTED]` |
| `https://u:@@<S>@host` | `echo <S>` | `echo [REDACTED]` |
| `https://u:<L>@<S>@host` | `echo <S>` | `echo <S>`（変わらない） |

## 不変条件

- I1 変更前の式が一致した入力で、一致した範囲のすぐ後ろの `@` のあとの片が区切りを含むか、そのあとに `@` が無いときは、変更後も同じ範囲に一致する。
- I2 伏せる範囲は `://` の直後から、userinfo を終える `@` の直前まで。scheme、終わりの `@`、host、範囲の外の文字は変えない。
- I3 一致しない入力は、ほかの規則が当たらないかぎり、出力が入力と同じ。
- I4 1 つの `://` について、走査はユーザー部の最初の `:` までと、authority の中のパスワード部だけを読む。
- I5 host がある userinfo では、表示とストリームは同じ範囲を伏せる（同じ行を 1 回で流した場合）。host が無い形のずれは #212。
- I6 空のパスワードは伏せない。
- I7 入力の長さ n に対して時間は O(n)。
- I8 ストリームと既知の値の API は、先頭の `@` の連続を落としたパスワードが文の別の場所に出ても伏せる。表示はこれを約束しない（2 の判断）。

## 4. 上流へ出すコミットとフォークだけのコミット

上流へ出す枝は、上流 main（a1794751a）の上に次の順で積む。`package.json`・`package-lock.json`・`flake.nix`・`tsconfig.tests.json`・`docs/design/` は、上流へ出すコミットに入れない。

| 順 | コミット | 中身 | 上流へ |
|---|---|---|---|
| 1 | 14275efe7、5281ecbf9、bfed9b62e、8117200eb、7eb4f0f43 | 今の T1〜T5・T7・W5 の試験と直し | 出す |
| 2 | 新しい試験のコミット（#204） | T2〜T5 の値を作り物の印にし、印がすべて出ないことを表示とストリームで確かめる（5 の 1 行目） | 出す |
| 3 | 新しい試験のコミット（red） | 1・2 の固定の例と、伏せてはいけない入力（5 の 3〜6 行目）。`src/__tests__/sensitiveText.test.ts` だけ | 出す |
| 4 | 新しい直しのコミット | `sensitive-text.ts` の 2 か所（6 の一覧） | 出す |
| 5 | フォークだけのコミット | この設計の文書 | 出さない |
| 6 | フォークだけのコミット | PBT（5 の 7〜9 行目）。性質 1〜3 は `src/__tests__/sensitiveTextUserinfo.pbt.test.ts`、時間の性質と固定の大きさの線形性は `src/__tests__/sensitive-text-userinfo.performance.test.ts`（`*.performance.test.ts` なので heavy の並列 IT で走り、unit では走らない）。`tsconfig.tests.json` に 2 つを足す | 出さない |

- 669116f6b はこの表のとおりに分け直す。`sensitiveText.test.ts` の追加分は 3 へ、設計の文書は 5 へ、PBT は 6 へ移す。`package.json`・`package-lock.json`・`flake.nix` の fast-check の差分は捨てる。フォークの `integration/takt-mcp` にはすでに `fast-check: ^4.11.0` があるので、6 は依存を足さずに走る。
- 6 は、#2103 をフォークへ取り込むとき（上流の取り込みか、手で積むとき）にフォークの枝へ足す。上流へ出す枝は 4 で切る。

## 5. テスト（Sonnet）への頼み

値はすべて実行時に部品をつないで作る（`Zq` + 数字 + `Zq`、または `fake` の繰り返し）。既存の T1・T6・T7・W5 などの期待は変えない。669116f6b が足した「ends the userinfo at the first at sign when the password contains a later one」（`sensitiveText.test.ts:709-714`）だけは、1 の決定で期待が逆になるので、3 のコミットで期待を `https://[REDACTED]@host` に変え、名前を「redacts a password that contains an at sign up to the at sign before the host」に改める。

| # | ファイル | 試験の名前 | 何を確かめるか | 本番のどこを外せば落ちるか |
|---|---|---|---|---|
| 1 | `sensitiveText.test.ts` | T2〜T5（`describe.each` の 4 行を、値と期待だけ直す） | T2〜T4 の `pa55`・`RIGHT_SECRET` を `Zq21Zq`・`Zq22Zq` に、T5 の `LEFT`・`RIGHT` を `Zq23Zq`・`Zq25Zq` にし、どちらの印も表示とストリームの両方に出ない（W5 と同じ形）。#204 | bfed9b62e・7eb4f0f43 の直し（今は通る守りの試験） |
| 2 | `sensitiveText.test.ts` | `redacts a password that starts with a run of at signs` を `it.each([2, 3, 4])` | `https://u:` + `@` の n 個 + `<S>@host` が、表示・1 回のストリーム・すべての分け目でのストリーム・preview で `https://[REDACTED]@host` | 67 行のパスワード部の `@*` |
| 3 | `sensitiveText.test.ts` | `redacts a password that contains an at sign up to the at sign before the host`（709 行の改め） | `https://u:<L>@<S>@host` と `https://u:<L>@<S>@<T>@host` が表示・ストリームで `https://[REDACTED]@host`、`<L>`・`<S>`・`<T>` が出ない | 67 行の `(?:@[^…;,&\|'"]+)*` |
| 4 | `sensitiveText.test.ts` | `redacts an omitted user`（U2 を残す） | `redis://:<S>@host` が `redis://[REDACTED]@host` | 67 行のユーザー部の `?` |
| 5 | `sensitiveText.test.ts` | `stops the password before a later part with a separator` を `it.each([';', ',', '&', '\|', "'", '"'])` | `curl https://u:<L>@host<sep>TOKEN=left@<T>` で `<T>` が出ず、host の `host` が残る（表示・ストリーム）。`https://u:<S>@host,me@example.test` は今の出力のまま | 区切りの集合（外すと `<T>` が host として出る） |
| 6 | `sensitiveText.test.ts` | `hides a password that starts with at signs where it is echoed later` | `https://u:@@<S>@host echo <S>` をストリームで流すと `echo [REDACTED]`。`sanitizeSensitiveTextWithKnownValues('echo <S>', { command: 'https://u:@@<S>@host' })` が `echo [REDACTED]` | `addCredentialComponents` の先頭の `@` を落とす 1 行 |
| 7 | `sensitiveText.test.ts` | 伏せてはいけない入力（今の群に足す） | `https://host:8080/path@v2`、`git@github.com:owner/repo.git`、`mail <S>@example.test before noon`、`https://[2001:db8::1]:8080/path`、`https://u:@host`、`https://u:@@host` が表示・ストリームとも変わらない | 過剰に広い直し（例: `://` から最後の `@` まで） |
| 8 | `sensitiveText.test.ts` | `keeps the known limits of the userinfo reading`（記録の試験） | `https://u:<L>@a;<S>@host` は `https://[REDACTED]@a;<S>@host`、`https://u:<L>@<S>@host echo <S>` の表示は `echo <S>`。今の出力を固定し、名前とコメントで「漏れの記録」と書く | — （期待を固定するだけ。直すときに意図して変える） |
| 9 | `sensitiveTextUserinfo.pbt.test.ts`（フォークだけ） | 性質 1〜3 | 生成器は scheme（大文字の `HTTPS`・`Redis` を必ず含む）、ユーザー（空を含む）、パスワードの形（先頭の `@` が 0〜4 個、途中の `@` で 2〜3 片、空のパスワード）を作る。性質 1「生成した形の userinfo の秘密は、表示にもストリームにも出ない」（空のパスワードの形は性質 3 の「変わらない」側で見る）、性質 2「資格情報の無い文は変わらない」、性質 3「範囲の外は 1 文字も変えない」。各形（`@` の連続、途中の `@`、空のパスワード、大文字の scheme、空のユーザー）の件数を数えて試験の出力に書き、どの形も 1 件以上あることを `expect` で確かめる | 67 行（`@*`、途中の片、ユーザー部の `?` のどれを外しても性質 1 が落ちる） |
| 10 | `sensitive-text-userinfo.performance.test.ts`（フォークだけ） | 時間の性質と固定の大きさの線形性 | 669116f6b の性質 4 と 64 KiB / 256 KiB の試験をここへ移し、形に「`a@` の連続 + `;`」「`@a;` の連続」を足す | 67 行をコロンや `@` を総当たりする形にしたとき |

## 6. 本番（muse）への頼み

| 場所 | 変えること | 期待 |
|---|---|---|
| `src/shared/utils/sensitive-text.ts:67` | `URL_USERINFO_CREDENTIALS_REGEX` を 1 の「変更後」の式にし、上のコメントに「パスワードは先頭の `@` の連続と、区切りを含まない片を `@` でつなぐ。区切りを含む片の手前で終える」を足す | 5 の 2〜5・7 が通る |
| 同 :188（表示）、:351（ストリームの範囲）、:222 と :317（値の収集と、userinfo の中の代入を飛ばす範囲） | 変えない。同じ式を使うので追従する | T7・W5・566 番の試験が今のまま通る |
| 同 :275-283 `addCredentialComponents` | 最初の `:` のうしろの値が `@` で始まるとき、先頭の `@` の連続を落とした値も足す（空なら足さない） | 5 の 6 が通る。`sanitizeSensitiveTextWithKnownValues` の既存の試験が今のまま通る |

## 未確認

- 試作で流したのは `sensitiveText.test.ts`・`sensitive-text-streaming.test.ts`・`sensitiveTextUserinfo.pbt.test.ts`（583 件中 582 件が通り、落ちたのは 709 行の 1 件だけ）と、`sensitive-text-sanitize.performance.test.ts`（14 件）。`npm test` の全体、`npm run test:it`、E2E は流していない。
- `addCredentialComponents` は HTTP ヘッダと curl の `-u` からも呼ばれる。先頭が `@` の値を落として足す変更が、これらの経路で短い値を増やして過剰に伏せないかは、固定の例では確かめていない（足すのは先頭が `@` のときだけ）。
- 区切りの集合（`; , & | ' "`）の外の記号（`=`、`+` など）を含む途中の片はつなぐ。base64 の `=` を含むパスワードのためで、`=` のあとに代入が続く形（`https://u:p@host=x@y`）は確かめていない。
- `nix build .#default`・`npm run sync:nix-deps -- --check` は流していない（4 のとおり、上流へ出す差分から package の変更を外すので、上流の nix の検査には関わらない）。
