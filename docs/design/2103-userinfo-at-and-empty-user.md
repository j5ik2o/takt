# URL userinfo の伏せ漏れ（`@` の連続、空ユーザー、裸の再出現。パスワードの途中の `@` は今回は外す）

- 対象: 上流 [nrslib/takt#2103](https://github.com/nrslib/takt/pull/2103) の出し直しの枝 `j5ik2o/upstream-2103-t1t5-local`（先端 0a1df6bb8。src は 7eb4f0f43 と同じ）。上流 main は a1794751a。
- 点検: [#204](https://github.com/j5ik2o/takt/issues/204)（T2〜T5 の試験の弱さ）、別件 [#212](https://github.com/j5ik2o/takt/issues/212)（scheme の前の `_`・数字、host の無い形）
- 敵対的な読み（0a1df6bb8、14 件）と、別の作業ツリーでの測り直し（指摘 1・4）を受けて、前の版の式を直した。上流へは何もしていない。

## 決め（元帥の条件 A）：パスワードの途中の `@` は今回の差分に入れない

**パスワードの途中の `@`（`https://u:<L>@<S>@host`）は、今回は直さない。PR の文から「パスワードに `@` を含むもの」の主張を外し、フォークの issue にする（本文の案は 5 節）。** 直すのは、パスワードの先頭の `@` の連続（2 つ以上）と空のユーザーで、どちらも host が続くときに限る。

根拠：

1. **狭く直す形が無い。** 直したい `https://u:<L>@<S>@host` と、host の見え方を変えてはいけない `https://u:<S>@host@evil.test` は、どちらも `u:X@Y@Z` という同じ並びで、文字からは区別できない。前者で `<S>` を伏せる式は、後者でも `host` を userinfo に入れ、見える host を `evil.test` に変える。前の版の式（0a1df6bb8）は、測り直しで実際に `https://[REDACTED]@evil.test` を出した。
2. **前の版の式は退行する。** 別の作業ツリーでの測り直し（`curl https://u:<L>@host<c>TOKEN=left@<T>` の 95 文字 × 4 形 = 380 通り）で、先端が伏せていて前の版の式が出すものが、表示で 344 件、ストリームで 172 件あった。`host<c>TOKEN=left` がパスワードの続きとして読まれ、`<T>` が host として出る。区切りの集合に `=` や `)` を足しても、区切りの無い形（`hostTOKEN=left`）は残る。
3. **条件 A の基準。** 「304 通り（測り直しの行列では 380 通り）の退行が 0 件」「`host@evil.test` の見え方の変化が 0 件」「表示とストリームが今回の差分で新しくずれない」の 3 つを、途中の `@` を直す形では同時に満たせない。上流の PR は小さく安全に戻す、と公開で書いた約束を優先する。

残す 2 つ（`@` の連続と空のユーザー）は、同じ行列とくじで、先端が伏せていて変更後に出すものが 0 件だった（2 節）。

## 1. 変更

### 式

```
変更前（a1794751a）:
/(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s@][^/?#\s@:]*:[^/?#\s@]+)@/g
先端（7eb4f0f43 = 0a1df6bb8）:
/(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s@][^/?#\s@:]*:(?:@[^/?#\s@]+|[^/?#\s@]+))@/g
前の版の案（0a1df6bb8 の設計。採らない）:
/(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)((?:[^/?#\s@][^/?#\s@:]*)?:@*[^/?#\s@]+(?:@[^/?#\s@;,&|'"]+)*)@/g
変更後:
/(:\/\/)(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)((?:[^/?#\s@][^/?#\s@:]*:(?:@[^/?#\s@]+|[^/?#\s@]+|@{2,}[^/?#\s@;,&|'"=]+(?=@[^/?#\s@]))|:[^/?#\s@;,&|'"=]+(?=@[^/?#\s@])))@/g
```

- 先頭の 2 つの選択肢（`@[^/?#\s@]+`、`[^/?#\s@]+`）は、先端の式そのままで、先に試す。先端が一致する `://` では、変更後も同じ範囲に一致する。変わるのは、先端が一致しなかった所だけである。
- 足す選択肢 1：ユーザーのあとの `@` の連続（2 つ以上）と、それに続くパスワード。`https://u:@@<S>@host` を読む。
- 足す選択肢 2：空のユーザー（`scheme://:` の直後）と、それに続くパスワード。`redis://:<S>@host` を読む。パスワードの先頭の `@` は読まない（下の「残す形」）。
- 足す 2 つには、次の 2 つの制限を付ける。
  - パスワードの文字から、区切り `; , & | ' "` と `=` を外す。外さないと、`https://u:@@host;TOKEN=left@<T>` で `host;TOKEN=left` がパスワードとして読まれ、`<T>` が host として出る（くじで 1,260 件の退行が出た）。base64 の `=` で終わるパスワードは、この 2 つの形では伏せない（先端と同じ出力）。
  - 終わりの `@` のすぐあとに host の文字があるときだけ一致する（`(?=@[^/?#\s@])`）。host の無い `https://u:@@<S>@` は先端と同じく一致しないので、表示とストリームがこの形で新しくずれない。

### 残す形（今回は直さない）

| 形 | 例 | 変更後の出力 | 先端 |
|---|---|---|---|
| パスワードの途中の `@` | `https://u:<L>@<S>@host` | `https://[REDACTED]@<S>@host` | 同じ |
| 途中の片が区切りを含む（6 文字すべて） | `https://u:<L>@a<sep><S>@host`（`<sep>` は `; , & \| ' "`） | `https://[REDACTED]@a<sep><S>@host` | 同じ |
| 空のユーザー + 先頭の `@` | `https://:@<S>@host` | 変化なし | 同じ |
| `@` の連続 + 区切りか `=` を含むパスワード | `https://u:@@<S>=@host` | 変化なし | 同じ |
| 空のユーザー + 区切りか `=` を含むパスワード | `redis://:<S>=@host` | 変化なし | 同じ |
| host の無い形（#212） | `https://u:@@<S>@`、`redis://:<S>@` | 変化なし | 同じ |

空のユーザー + 先頭の `@` を外したのは、入れると `https://:@<L>@<S>@`（host が無く `@` で終わる）で表示とストリームが新しくずれた（くじで 15 件）ためである。

### 線形性

- 起点は前と同じ `://` で、lookbehind が直前の scheme を 1 回だけ読む。各 `://` から読む範囲は、`/ ? #` か空白で終わる authority の中だけで、次の `://` とは重ならない。
- 先端の 2 つの選択肢は先端のまま。足す 2 つは、どれも `@` を含まない 1 つの片を読み、片の終わりを 1 文字の先読みで確かめるだけで、片をつながない。`@{2,}` は、うしろの片が `@` を読まないので、`@` の連続の長さに比例する戻りで終わる。
- 試作の実測（表示の `sanitizeSensitiveText`、3 回の最速、64 KiB と 256 KiB）では、4 倍の長さで時間も 3.87〜4.16 倍で、先端（3.39〜4.77 倍）と同じ範囲だった。形は、`@` の連続（終端なし・`;` で終わる）、`@@` のあとの長い片、空のユーザーの長い片、`x://:a` の繰り返し、`a://u:@@b@` の繰り返し、`:` の連続、scheme に似た長い列の 8 つ。既存の `sensitive-text-sanitize.performance.test.ts`（14 件）は試作のまま通った。

## 2. 先端が伏せていて、変更後が出すもの（0 件）

試作は、7eb4f0f43 の `src/shared` の写しに 1 節の式と 3 節の `addCredentialComponents` を当てたもので、作業ツリーの外（一時の場所）で流した。表示は `sanitizeSensitiveText(text, [])`、ストリームは `createSensitiveTextStreamRedactor()` の `write(text, {}) + flush({})`。`<S>`・`<L>`・`<T>` は実行時に部品をつないで作った作り物の秘密（`Zq24Zq`・`Zq01Zq`・`Zq31Zq`）。

「退行」は、入力に入れた秘密のうち、先端の出力に無く変更後の出力にあるものの数。「新しいずれ」は、先端で表示とストリームが同じ文字列なのに、変更後で違うもの（ストリームが再出現を新しく伏せた分は除く。3 節）。

| 入力の集合 | 件数 | 前の版の式の退行（表示 / ストリーム） | 変更後の退行（表示 / ストリーム） | 変更後の新しいずれ |
|---|---|---|---|---|
| 測り直しの行列：`curl https://u:<L>@host<c>TOKEN=left@<T>` の 95 文字 × 4 形（`curl` あり、なし、末尾 `.`、`'` で囲む） | 380 | 344 / 172 | **0 / 0** | 0 |
| くじ：前置き 7 × scheme 3 × ユーザー 3 × パスワード 19 × host 8 × 後置き 6 | 57,456 | 4,770 / 4,410 | **0 / 0** | 90 |

前の読みの 304 通りは、測り直しの行列の部分集合（漏れる文字だけを並べたもの）なので、その 304 通りも変更後は 0 件である。

くじの新しいずれ 90 件は、すべて「`@@` で始まり、途中の `@` のあと host が無く `@` で終わる」形（`https://u:@@<L>@<S>@` → 表示 `https://[REDACTED]@<S>@`、ストリーム `https://[REDACTED]@<S>[REDACTED]`）だった。先端でも、`@` が 1 つの同じ形（`https://u:@<L>@<S>@`）で同じずれがある。host の無い形のずれ（#212）が `@@` の形に広がるもので、**この差分で初めてずれる入力**として PR の文と 6 節の記録の試験に書く。

名指しの形の出力（先端 → 変更後。表示とストリームが同じときは 1 つだけ書く）：

| 入力 | 先端 | 変更後 |
|---|---|---|
| `curl https://u:<L>@host=TOKEN=left@<T>`（`)`・`]`・`}`・`>`・`:`・区切りなしも同じ） | `curl https://[REDACTED]@host=TOKEN=[REDACTED]` | 同じ |
| `https://u:<S>@host@evil.test` | `https://[REDACTED]@host@evil.test` | 同じ（見える host は変わらない） |
| `https://u:@@<S>@host@evil.test` | 変化なし | `https://[REDACTED]@host@evil.test`（見える host は変わらない） |
| `https://u:@@<S>@host`（`@` 3 個も同じ） | 変化なし | `https://[REDACTED]@host` |
| `redis://:<S>@host` | 変化なし | `redis://[REDACTED]@host` |
| `https://u:@@<S>@host,next` | 変化なし | `https://[REDACTED]@host,next` |
| `https://u:@@<S>@host;TOKEN=<T>` | `https://u:@@<S>@host;TOKEN=[REDACTED]` | `https://[REDACTED]@host;TOKEN=[REDACTED]` |
| `https://u:@@<S>@`（host 無し） | 変化なし | 変化なし（新しくずれない） |
| `https://u:<L>@<S>@host` | `https://[REDACTED]@<S>@host` | 同じ（残す形） |
| `curl https://u:<L>@host;TOKEN=left@<T>`（T7） | `curl https://[REDACTED]@host;TOKEN=[REDACTED]` | 同じ |
| `curl https://u:@<L>@host,TOKEN=left@<T>`（T4） | `curl https://[REDACTED]@host,TOKEN=[REDACTED]` | 同じ |
| `https://alice:@<L>;token=<T>@host`（T5） | `https://[REDACTED]@host` | 同じ |
| `https://u:<S>@host,me@example.test` | `https://[REDACTED]@host,me@example.test` | 同じ |
| `https://host:8080/path@v2`、`git@github.com:owner/repo.git`、`mail <S>@example.test before noon`、`https://u:@host`、`https://u:@@host` | 変化なし | 変化なし |
| `https://::@host` | 変化なし | `https://[REDACTED]@host`（空のユーザーとパスワード `:`。採らない、前の読みの指摘 5） |

W5（`https://u:Zq12Zq@host;TOKEN=left@Zq13Zq;https://u:Zq14Zq@host;TOKEN=left@Zq15Zq`）は、先端も変更後も、表示が `https://[REDACTED]@host;TOKEN=[REDACTED][REDACTED]@host;TOKEN=[REDACTED]`、ストリームが `https://[REDACTED]@host;TOKEN=[REDACTED]` で、表示とストリームは先端から違う（6 節の 4）。

## 3. 裸の再出現と `addCredentialComponents`

### 上流 main（a1794751a）の仕組み

- 表示 `sanitizeSensitiveText`（`sensitive-text.ts:180-200`）は、正規表現の置換と、実行の秘密の置換だけをする。同じ文の中で見つけた値を、文の別の場所で探す段は無い。
- ストリームは、確定した文ごとに `maskingRanges`（`sensitive-stream.ts:12-17`）が `collectEmbeddedSensitiveValues` で値を集め、`sensitiveTextRanges` の `knownValueRanges` が文の中のその値をすべて伏せる。`sanitizeSensitiveTextWithKnownValues`（`sensitive-value.ts:108-111`）も、別の入力から集めた値で文を伏せる。
- URL の userinfo から集める値は、userinfo 全体と、最初の `:` のうしろ（`addCredentialComponents`、`sensitive-text.ts:275-283`）である。

### 変更

`addCredentialComponents` で、最初の `:` のうしろの値が `@` で始まるとき、先頭の `@` の連続を落とした値も足す。**落とした値が 4 文字以上のときだけ足す**（元帥の条件 B。#214 の設計の「4 文字以上」にそろえる）。1〜3 文字の値を足すと、`knownValueRanges` の短い値の規則で文の中の無関係な語まで伏せ、その値はストリームの寿命いっぱい残る（前の読みの指摘 6：`Authorization: Basic u:@a` のあと `this is a test of a plan` が `this is [REDACTED] test of [REDACTED] plan` になった）。

試作の出力：

| 入力 | 先端 | 変更後 |
|---|---|---|
| ストリーム：`Authorization: Basic u:@a` の改行のあと `this is a test of a plan` | 2 行目は変化なし | 2 行目は変化なし（前の版の案は 2 か所を伏せた） |
| ストリーム：`Authorization: Basic u:@abc` の改行のあと `abc is here` | 2 行目は変化なし | 2 行目は変化なし |
| ストリーム：`Authorization: Basic u:@@<S>` の改行のあと `echo <S>` | `echo <S>` | `echo [REDACTED]` |
| ストリーム：`https://u:@@<S>@host echo <S>` | 変化なし | `https://[REDACTED]@host echo [REDACTED]` |
| ストリーム：`https://u:@<S>@host echo <S>`（T1 の形） | `https://[REDACTED]@host echo <S>` | `https://[REDACTED]@host echo [REDACTED]` |
| ストリーム：`redis://:<S>@host echo <S>` | 変化なし | `redis://[REDACTED]@host echo [REDACTED]` |
| 表示：上の 3 つの URL | `echo <S>` が残る | `echo <S>` が残る（表示は直さない） |
| `sanitizeSensitiveTextWithKnownValues('echo <S> and abc plan', { command })`、command が `https://u:@@<S>@host` | `echo <S> and abc plan` | `echo [REDACTED] and abc plan` |
| 同、command が `https://u:@@abc@host` | 変化なし | 変化なし（3 文字なので足さない） |

表示は今回も直さない。上流 main の単純な形 `https://u:<S>@host echo <S>` でも、表示は `echo <S>` を伏せない。表示で直すには、表示が自分の文から値を集めて伏せる新しい段が要る。

## 4. 不変条件

- I1 先端の式が一致する `://` では、変更後も同じ範囲に一致する（先端の 2 つの選択肢を先に試す）。
- I2 伏せる範囲は `://` の直後から、userinfo を終える `@` の直前まで。scheme、終わりの `@`、host、範囲の外の文字は変えない。見える host は先端と同じ（`host@evil.test` の形を含む）。
- I3 一致しない入力は、ほかの規則が当たらないかぎり、出力が入力と同じ。
- I4 足した 2 つの選択肢は、`@` を含まない片を 1 つだけ読み、区切り `; , & | ' "` と `=` を読まない。
- I5 host がある userinfo では、表示とストリームは同じ範囲を伏せる（同じ行を 1 回で流した場合）。host の無い形のずれは #212 で、この差分で新しくずれるのは 2 節の 90 件の形だけ。
- I6 空のパスワードは伏せない。
- I7 入力の長さ n に対して時間は O(n)。
- I8 ストリームと既知の値の API は、先頭の `@` の連続を落とした 4 文字以上のパスワードが、文の別の場所に出ても伏せる。表示はこれを約束しない。
- I9 先端が伏せていて、変更後に出す秘密は無い（2 節の 380 通りと 57,456 通りで 0 件）。

## 5. フォークの issue の本文の案（副元帥が立てる）

題：URL のパスワードの途中の `@` を伏せない（`https://u:<L>@<S>@host` で `<S>` が出る）

> 上流 [nrslib/takt#2103](https://github.com/nrslib/takt/pull/2103) の出し直しで、パスワードの途中の `@` を伏せる直しを外した。この issue はその残りである。
>
> **今の出力**：`https://u:<L>@<S>@host` の表示とストリームは `https://[REDACTED]@<S>@host` で、`<S>` が host のように出る。途中の片が区切り（`; , & | ' "`）を含む `https://u:<L>@a;<S>@host` も同じ。WHATWG の URL の読み方（Node の `new URL`）は最後の `@` で区切るので、password は `<L>@<S>` になる。
>
> **狭く直せない理由**：直したい形と、host の見え方を変えてはいけない `https://u:<S>@host@evil.test` は、どちらも `u:X@Y@Z` の並びで、文字からは区別できない。最後の `@` まで読む式（#2103 の前の案）は、`curl https://u:<L>@host=TOKEN=left@<T>` のような URL のうしろに続く代入まで userinfo に入れ、先端では伏せていた `<T>` を host として出す（95 文字 × 4 形の 380 通りで、表示 344 件・ストリーム 172 件の退行）。区切りの集合を広げても、区切りの無い `hostTOKEN=left@<T>` は残る。
>
> **案**：
> 1. 見える host を WHATWG に合わせる（最後の `@` のあとを host とする）と決めたうえで、userinfo の中の代入（`bareAssignments` が飛ばす範囲、`sensitive-text.ts:310-317`）も伏せの対象に入れる。`host=TOKEN=left@<T>` の `<T>` は userinfo の一部として伏せられ、漏れない。見える host が変わることは受け入れる。
> 2. 途中の片を、別の手がかり（ドットを含む、既知の値に当たる）で host とみなす。手がかりの無い形は残る。
> 3. 表示にも、同じ文から集めた値を伏せる段を入れ（表示とストリームの再出現の差の issue と合わせる）、途中の片を値として集める。短い片で無関係な語まで伏せないよう、4 文字以上に限る。
>
> 関係：[#212](https://github.com/j5ik2o/takt/issues/212)（scheme の前の `_`・数字、host の無い形）、表示の再出現の issue（2 の判断の続き）。

## 6. PR の文に書くこと

前の版の文から、パスワードの途中の `@` を直すという主張を外し、次の行にする。

- `- A URL password that starts with two or more "@" (https://u:@@<secret>@host) and a URL that omits the user (redis://:<secret>@host) are now redacted when a host follows.`
- `- Not changed in this PR: a password that contains "@" after its first character (https://u:<left>@<secret>@host) still shows the part after that "@". Any rule for that form also changes the visible host of https://u:<secret>@host@evil.test, so it is left for a later change.`
- `- Not changed: a password with "@" in the middle whose part contains ; , & | ' " (https://u:<left>@a;<secret>@host), an omitted user with a password that starts with "@", and URLs without a host.`
- `- New in this PR: https://u:@@<left>@<secret>@ (no host, ends with "@") is displayed and streamed differently; the same difference already exists for https://u:@<left>@<secret>@.`
- `- When a redacted URL password appears again elsewhere in the same text, the displayed text (sanitizeSensitiveText) still shows it; this was already the case before this PR (for example https://u:<secret>@host echo <secret>). Streaming and known-value redaction now also hide a password of four or more characters after its leading "@" when it reappears.`

## 7. 上流へ出すコミットとフォークだけのコミット

上流へ出す枝は、上流 main（a1794751a）の上に次の順で積む。`package.json`・`package-lock.json`・`flake.nix`・`tsconfig.tests.json`・`docs/design/` は、上流へ出すコミットに入れない。

| 順 | コミット | 中身 | 上流へ |
|---|---|---|---|
| 1 | 14275efe7、5281ecbf9、bfed9b62e、8117200eb、7eb4f0f43 | 今の T1〜T5・T7・W5 の試験と直し | 出す |
| 2 | 新しい試験のコミット（#204） | T2〜T5 の値を作り物の印にし、印がすべて出ないことを表示とストリームで確かめる（8 節の 1） | 出す |
| 3 | 新しい試験のコミット（red） | 8 節の 2〜8。`src/__tests__/sensitiveText.test.ts` だけ | 出す |
| 4 | 新しい直しのコミット | `sensitive-text.ts` の 2 か所（9 節） | 出す |
| 5 | フォークだけのコミット | この設計の文書 | 出さない |
| 6 | フォークだけのコミット | PBT と時間の性質（8 節の 9・10）。`tsconfig.tests.json` に 2 つを足す行もここに入れる | 出さない |

- 669116f6b はこの表のとおりに分け直す。`sensitiveText.test.ts` の追加分は 3 へ、設計の文書は 5 へ、PBT と `tsconfig.tests.json` の PBT の行は 6 へ移す。`package.json`・`package-lock.json`・`flake.nix` の fast-check の差分は捨てる。
- **6 はフォークの作業ツリーで走らせる。** このクローンの上流へ出す枝（a1794751a の上）には fast-check が無い（7eb4f0f43 の `package.json` に無い）ので、6 をこの枝に積むと `import 'fast-check'` が解決できず、`test:types` も TS2307 になる。今このクローンで fast-check が解決するのは、669116f6b の `package.json` と古い `node_modules` が残っているためで、きれいな導入の証拠ではない。フォークの統合ブランチには `fast-check: ^4.11.0` がある（`origin/integration/takt-mcp` の `package.json:265`。このクローンにも追跡の枝がある）。段取り：
  1. フォークの作業ツリー（統合ブランチから作ったもの）で、`git switch -c <フォークの枝> origin/integration/takt-mcp`。
  2. 1〜4 のコミットを cherry-pick し、5・6 を足す。
  3. その作業ツリーで `npm ci` のあと、`npm test -- src/__tests__/sensitiveTextUserinfo.pbt.test.ts` と `npm test -- src/__tests__/sensitive-text-userinfo.performance.test.ts`（heavy の並列 IT に振り分けられる）、`releaseVerificationWiring.test.ts` を単独で流す。
- 上流へ出す枝は 4 で切る。

## 8. テスト（Sonnet）への頼み

値はすべて実行時に部品をつないで作る（`Zq` + 数字 + `Zq`、または `fake` の繰り返し）。既存の T1・T6・T7・W5 などの期待は変えない。669116f6b が足した「ends the userinfo at the first at sign when the password contains a later one」（`sensitiveText.test.ts:709-714`）は、**期待も名前も変えない**（途中の `@` を直さないので、今の期待のまま正しい）。すぐ上のコメント（707-708 行）も、そのままで正しい。同じ `describe` の冒頭のコメント（620-624 行、「#2103 leaves two URL userinfo shapes unredacted …」）は、直したあとは古くなるので、3 のコミットで「#2103 redacts a password that starts with two or more at signs and an omitted user when a host follows; a password with a later at sign stays out of scope」の趣旨に書き換える。

| # | ファイル | 試験の名前 | 何を確かめるか | 本番のどこを外せば落ちるか |
|---|---|---|---|---|
| 1 | `sensitiveText.test.ts` | T2〜T5（`describe.each` の 4 行を、値と期待だけ直す） | T2〜T4 の `pa55`・`RIGHT_SECRET` を `Zq21Zq`・`Zq22Zq` に、T5 の `LEFT`・`RIGHT` を `Zq23Zq`・`Zq25Zq` にし、どちらの印も表示とストリームの両方に出ない（W5 と同じ形）。#204 | bfed9b62e・7eb4f0f43 の直し（今は通る守りの試験） |
| 2 | 同上 | `redacts a password that starts with a run of at signs` を `it.each([2, 3, 4])`（U1 を広げる） | `https://u:` + `@` の n 個 + `<S>@host` が、表示・1 回のストリーム・すべての分け目でのストリーム・preview で `https://[REDACTED]@host` | 足す選択肢 1 |
| 3 | 同上 | `redacts an omitted user`（U2 を残す） | `redis://:<S>@host` が `redis://[REDACTED]@host`。`redis://::<S>@host` も伏せる（今の行） | 足す選択肢 2 |
| 4 | 同上 | `keeps the visible host when a later at sign follows the host` | `https://u:<S>@host@evil.test` と `https://u:@@<S>@host@evil.test` が、表示・ストリームとも `https://[REDACTED]@host@evil.test` | 足す選択肢 1 の片から `@` を外したり、途中の片をつないだりする変更（見える host が `evil.test` になる） |
| 5 | 同上 | `stops the password before a later part with a separator` を `it.each` で `; , & \| ' "` に加え `=`・`)`・`]`・区切りなし | `curl https://u:<L>@host<c>TOKEN=left@<T>` で `<T>` が出ず、`host` が残る（表示・ストリーム）。`https://u:@@<S>@host<sep>next` は `https://[REDACTED]@host<sep>next`、`https://u:@@host;TOKEN=left@<T>` で `<T>` が出ない。`https://u:<S>@host,me@example.test` は今の出力のまま | 足す 2 つの選択肢の除外の集合（外すと `<T>` が host として出る）と、前の版の案の途中の片 |
| 6 | 同上 | `hides a password that starts with at signs where it is echoed later` | `https://u:@@<S>@host echo <S>` をストリームで流すと `echo [REDACTED]`。`sanitizeSensitiveTextWithKnownValues('echo <S>', { command: 'https://u:@@<S>@host' })` が `echo [REDACTED]` | `addCredentialComponents` の先頭の `@` を落とす行 |
| 7 | 同上 | `does not add a short value after the leading at signs` を `it.each(['a', 'ab', 'abc'])` | ストリームで `Authorization: Basic u:@<v>` の改行のあと `this is a test of a plan <v>` を流すと、2 行目が変わらない。`--user u:@<v>`、URL の `https://u:@@<v>@host` でも同じ | 9 節の 4 文字の下限 |
| 8 | 同上 | 伏せてはいけない入力（今の群に足す） | `https://host:8080/path@v2`、`git@github.com:owner/repo.git`、`mail <S>@example.test before noon`、`https://[2001:db8::1]:8080/path`、`https://u:@host`、`https://u:@@host`、`https://u:@@<S>@`（host 無し）が表示・ストリームとも変わらない | 過剰に広い直し（例：`://` から最後の `@` まで）、足す選択肢の先読みを外す変更 |
| 9 | 同上 | `keeps the known limits of the userinfo reading`（記録の試験） | 2 節と 1 節の「残す形」の出力を固定する：`https://u:<L>@<S>@host`、`https://u:<L>@a<sep><S>@host`（`it.each` で 6 文字）、`https://:@<S>@host`、`https://u:@@<L>@<S>@`（表示 `https://[REDACTED]@<S>@`、ストリーム `https://[REDACTED]@<S>[REDACTED]`。この差分で初めてずれる形）、`https://u:<L>@<S>@host echo <S>` の表示 `echo <S>`。名前とコメントで「漏れとずれの記録」と書く | —（期待を固定するだけ。直すときに意図して変える） |
| 10 | 同上 | W5 の形の試験を足す | 今の 8 件の印の試験は残し、表示の全文が `https://[REDACTED]@host;TOKEN=[REDACTED][REDACTED]@host;TOKEN=[REDACTED]`、ストリームの全文が `https://[REDACTED]@host;TOKEN=[REDACTED]` であることを足す（今の出力。表示とストリームは先端から違う）。T7 はもう全文を見ているので変えない | 伏せる範囲の形が変わる変更（印の不在だけでは捕まえない） |
| 11 | `sensitiveTextUserinfo.pbt.test.ts`（フォークだけ） | 性質 1〜3 | 生成器は scheme（大文字の `HTTPS`・`Redis` を必ず含む）、ユーザー（空を含む）、パスワードの形（先頭の `@` が 0〜4 個、空のパスワード）を作る。性質 1「生成した形の userinfo の秘密は、表示にもストリームにも出ない」は、1 節の「残す形」（空のユーザー + 先頭の `@`、区切りか `=` を含むパスワード、途中の `@`）を生成しない。残す形は性質 3「範囲の外は 1 文字も変えない」と 9 の固定例で見る。性質 2「資格情報の無い文は変わらない」。各形の件数を数えて試験の出力に書き、どの形も 1 件以上あることを `expect` で確かめる。669116f6b の今の PBT は、空のユーザー + 先頭の `@`（`https://:@<S>@host`）を性質 1 で作るので、変更後に 2 件落ちる（試作で確かめた）。この形を性質 1 から外す | 足す 2 つの選択肢（どちらを外しても性質 1 が落ちる） |
| 12 | `sensitive-text-userinfo.performance.test.ts`（フォークだけ） | 時間の性質と固定の大きさの線形性 | 669116f6b の性質 4 と 64 KiB / 256 KiB の試験をここへ移し、形に 1 節の「線形性」の 8 つを入れる | 足す選択肢をコロンや `@` を総当たりする形にしたとき |

## 9. 本番（muse）への頼み

| 場所 | 変えること | 期待 |
|---|---|---|
| `src/shared/utils/sensitive-text.ts:67` | `URL_USERINFO_CREDENTIALS_REGEX` を 1 節の「変更後」の式にし、上のコメントに「先端の 2 つの形を先に試す。パスワードが `@` の連続で始まる形と、空のユーザーの形は、区切り `; , & \| ' "` と `=` を含まない片で、host が続くときだけ読む。パスワードの途中の `@` は読まない（host の見え方を変えないため）」を足す | 8 節の 2〜5・8・9 が通る |
| 同 :188（表示）、:351（ストリームの範囲）、:222 と :317（値の収集と、userinfo の中の代入を飛ばす範囲） | 変えない。同じ式を使うので追従する。式のグループは 1 と 2 のままで、足した選択肢はグループ 2 の中にある | T7・W5・566 番の試験が今のまま通る |
| 同 :275-283 `addCredentialComponents` | 最初の `:` のうしろの値が `@` で始まるとき、先頭の `@` の連続を落とした値も足す。落とした値が 4 文字以上のときだけ足す | 8 節の 6・7 が通る。`sanitizeSensitiveTextWithKnownValues` の既存の試験が今のまま通る |

試作で、この 2 か所を作業ツリーの src に一時に当てて流した結果：`sensitiveText.test.ts`・`sensitive-text-streaming.test.ts`・`sensitiveTextUserinfo.pbt.test.ts` は 583 件中 581 件が通り、落ちたのは 669116f6b の PBT の 2 件（8 節の 11）だけ。709 行の試験は通る。`sensitive-text-sanitize.performance.test.ts` は 14 件とも通る。流したあと `git checkout -- src` で戻した。

## 未確認

- `npm test` の全体、`npm run test:it`、E2E は流していない。
- `addCredentialComponents` は HTTP ヘッダ、curl の `-u`、Cookie からも呼ばれる。4 文字の下限は試作で `Authorization` の 3 つの値だけ確かめた。
- 1 節の「残す形」のうち `=` で終わる base64 のパスワード（`https://u:@@ab==@host`）は、先端と同じく伏せない。どのくらい現れるかは調べていない。
- くじは 57,456 通りの組み合わせで、すべての入力を見たわけではない。前置き・後置き・host の形の外の形（たとえば host のあとの `)` に続く別の URL）は入れていない。
- `nix build .#default`・`npm run sync:nix-deps -- --check` は流していない（7 節のとおり、上流へ出す差分から package の変更を外すので、上流の nix の検査には関わらない）。
