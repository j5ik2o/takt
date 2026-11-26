# 設計：#162 の追加修正（スキーマ違反の扱いを前と同じ止まり方に戻し、返った ID は残す）

- PR：https://github.com/j5ik2o/takt/pull/162 （枝 j5ik2o/takt-fix-324-dynsel-abort、いまの先端 5f04a91fe）
- 元になった独立レビュー：~/.orca/bots/sub-marshal/audit/takt-162-review/review-pr162.md の指摘 1・2
- 設計の独立レビュー：~/.orca/bots/sub-marshal/audit/takt-162-fix/DESIGN-REVIEW.md（条件つき。処理は末尾の「設計レビューの指摘の処理」）
- Quint：specs/quint/structured-output-rejection/（README に検査の結果つき）

## 何をどう変えるか

原因は 5f04a91fe の transport の分岐。`rejectedStructuredOutput` があると、ほかの判定より先に `StructuredAgentContractError`（`StructuredAgentResponseError` の子）を、done でない応答つきで投げる。StepExecutor の loop judge の catch は「`StructuredAgentResponseError` で done でない応答」を「判断なし」に変えるので、前は止まっていた Claude Terminal の loop judge が自然な遷移で先へ進むようになった。条件判定（AI judge）と Team Leader も同じ catch の形なので、止まり方が少し変わっていた（元のレビューの指摘 3・4）。

直し方：

1. transport.ts に `StructuredOutputRejectedError extends AgentFailureError` を足す。category は provider_error、message と reason は前の `createAgentResponseFailureError(response, …)` と同じ（`response.error || response.content || response.status`）。`name` は上書きしない（前と同じ `AgentFailureError` のまま見える）。
2. 返った出力は、列挙されないプロパティに持たせる（`Object.defineProperty(this, 'rejectedStructuredOutput', { value, enumerable: false })`。型は `declare readonly`）。`JSON.stringify(error)`、`Object.keys`、`util.inspect`／`console.error` の既定の表示には出ない。読むのは `describeSelectorError` だけで、そこは今までどおり伏せ字と 512 バイトの上限を通す。
3. transport の done でない応答の分岐を、次の順にする。
   1. `status === 'rate_limited'` → 前と同じ（category が無いので `StructuredAgentResponseError`）。返った出力があっても見ない。
   2. `rejectedStructuredOutput` があり、category が無いか provider_error → `StructuredOutputRejectedError`。
   3. それ以外 → 前と同じ（category があれば `createAgentResponseFailureError`、無ければ `StructuredAgentResponseError`）。provider_stream_parse_error は `ProviderStreamParseError` のまま、external_abort や part_timeout は接頭辞つきの message のまま。返った出力は見ない。
   `StructuredOutputRejectedError` は `StructuredAgentResponseError` の子ではないので、loop judge・AI judge・Team Leader の catch は素通りし、前と同じく step_error（provider_error）で止まる。
4. `describeSelectorError` は、`StructuredAgentContractError` に加えて `StructuredOutputRejectedError` も見て、持っている出力から返った ID を理由に載せる。selector の失敗理由は今の PR と同じ。
5. selector の理由で返った ID を JSON にするとき、文字列の値だけでなく、オブジェクトのキーも伏せ字にしてから切る（設計レビューの指摘 5e。`selected_ids` がオブジェクトで、キーに 512 バイトを超える秘密が入ると、切ったあとでは既知の値と一致せず伏せ字が効かない）。

変えないこと：normalizer（`rejectedStructuredOutput` を付けるのは今のまま）、selector の検証、ネイティブ・プロンプト JSON の provider の経路（done の経路は変えない）、loop judge の「判定役の障害（分類なしのエラー、rate_limited）では本体を止めない」という既存の振る舞い、companion の selector（元のレビューの指摘 8、範囲外）、元のレビューの指摘 5・6・7・9・10（低・軽微、範囲外）。

## 守る不変条件

- スキーマ違反のときは必ず止まり、先へ進まない（loop judge は step_error、selector は中断）。どの adapter が作った応答でも、error か blocked で返った出力を持つなら止まる。
- done でない応答を、成功として返さない（M7 を一般にしたもの）。
- 本物の provider の失敗（ネットワーク、認証、rate_limited、分類なし）を契約違反と取り違えない。理由に返った ID を載せない。
- rate_limited は、返った出力があっても前と同じ経路を通る（status は rate_limited のまま）。
- provider_error 以外の category（stream parse、abort、timeout など）は、返った出力があっても前と同じ例外になる。
- loop judge の遷移は、今ある adapter のどの返答でも #162 の前と同じ。
- selector が候補外の ID を返したとき、どの provider でも返った ID と候補 ID が理由に載る（#162 の目的）。
- 返った出力は、例外を普通に表示・JSON 化しても出ない。

Quint の不変条件（9つ）はこれをそのまま写したもの。対応は specs/quint/structured-output-rejection/README.md の表。

## テスト（先に、直す前の先端で落ちるのを見る）

1. structured-agent-transport.test.ts（unit）：
   - 本物の `normalizeClaudeTerminalResponse` を `executeAgent` の mock から返し、スキーマ違反の JSON を流す。`executeStructuredAgent` と `executeStructuredTextAgent` の両方で、`AgentFailureError`（provider_error）で投げ、`StructuredAgentResponseError` ではなく、`StructuredOutputRejectedError` として返った出力を持ち、done を返さないこと。変異 M7（その応答を done で返す）を入れて落ちることを確かめる。
   - 返った出力が列挙されないこと：`Object.keys(error)` に無い、`JSON.stringify(error)` と `util.inspect(error)` に値が出ない。
   - rate_limited ＋返った出力 → `StructuredAgentResponseError`（status は rate_limited のまま）。
   - provider_stream_parse_error ＋返った出力 → `ProviderStreamParseError`。
2. 同じファイルの PBT（下の「PBT の性質」）。
3. dynamic-facet-candidate-selector.test.ts（unit、`describeSelectorError` を直接呼ぶ）：
   - `StructuredOutputRejectedError` → 返った ID と候補 ID が載る。
   - 普通の `AgentFailureError`（provider_error、本物の失敗）と、rate_limited の `StructuredAgentResponseError` → `allowed candidate ids` も `returned selected_ids` も載らない。
   - `selected_ids` が無い出力 → 返った ID の行が無い。`selected_ids` が 512 バイトを超える → 切れて `(truncated)`。キーに秘密が入ったオブジェクト → 伏せ字になる。
4. dynamic-parallel-selector-coordinator.test.ts（unit）：Claude Terminal が候補外 ID を schema で弾いたとき、返った ID と候補 ID が理由に載る（dynamic facet 側にある同じテストを、dynamic parallel にも置く）。
5. agent-usecases.test.ts（unit、`runAgent` を mock）：provider を claude-terminal にし、mock から本物の `normalizeClaudeTerminalResponse` を返す。`evaluateCondition` と `decomposeTask` が、スキーマ違反のとき provider_error の `AgentFailureError` を投げる（-1 や `onAgentResponse` にならない）こと。
6. engine-loop-monitors.test.ts（heavy IT、`runAgent` を mock）：provider を claude-terminal にし、loop judge の呼び出しでは mock から本物の `normalizeClaudeTerminalResponse`（`outputSchema` は呼び出しのものを渡す）で `{content}` に合わない JSON を返す。run が abort し、`workflow:abort` の理由と状態が step_error・provider_error で、自然な遷移の次の step が起動しないこと。いまの先端では completed になって落ちるはず。
7. 既存の dynamic-facet-selector-coordinator の Claude Terminal のテスト（返った ID が理由に載る）が通り続けること。

## PBT の性質

structured-agent-transport.test.ts に fast-check で足す。done でない応答の全体（status は error／blocked／rate_limited、failureCategory は無し／`AGENT_FAILURE_CATEGORIES` の全部、`rejectedStructuredOutput` は有り／無し、error・content は空白だけや空を含む任意の文字列）について：

- transport は必ず投げる（resolve しない）。
- status が rate_limited なら、返った出力があっても前と同じ分類（category が無ければ `StructuredAgentResponseError`）。`StructuredOutputRejectedError` にはならない。
- status が rate_limited でなく、返った出力があり、category が無いか provider_error なら `StructuredOutputRejectedError`。category は provider_error、message は前の式と同じ、持つ出力は応答のものと同じで、列挙されない。
- それ以外は、`createAgentResponseFailureError` と同じ型・category・message（前と同じ分類）。stream parse は `ProviderStreamParseError`。

比べる相手は「前の分類」を書き下した関数（`createAgentResponseFailureError` と `StructuredAgentResponseError` の組み合わせ）で、実装の写しではなく #162 の前の transport の分岐。

除外：status が done の応答。done の経路はこの修正で変えておらず、既存のスキーマ検証のテストが受け持つ。done ＋返った出力（今は作られない）は、done の経路が自分の出力を検証し直すことを、Quint の doneIgnoresRejectedTest で押さえる。

## 壊しうる入力

- `rejectedStructuredOutput` があり failureCategory が無い応答（今の normalizer は作らないが、将来の provider）→ provider_error として止める。
- status が rate_limited で `rejectedStructuredOutput` もある応答（今は作られない：rate limit の判定が先）→ rate_limited の経路のまま（返った出力は見ない）。
- failureCategory が provider_stream_parse_error で返った出力もある → `ProviderStreamParseError` のまま。`isProviderStreamParseError` で分けている WorkflowRunLoop・auto-routing・companion・TeamLeaderRunner・ParallelRunner・ArpeggioRunner の分岐は変わらない。
- failureCategory が external_abort／part_timeout で返った出力もある → 前と同じ `AgentFailureError`（message に接頭辞、reason には無し）のまま。
- status が done で返った出力もある → done の経路。自分の出力を検証し直し、返った出力は見ない。
- error が空白だけ（`"   "`）で content がある → `"   "` は真なので reason は `"   "`。前の式と同じ。error も content も空 → reason は status。
- 本物の失敗の content に selector の JSON が入っている → 出力を持たないので ID は載らない（Quint の NetworkErrorWithJson）。
- 返った出力に `selected_ids` が無い → 返った ID の行を出さない。巨大 → 512 バイトで切る。キーに秘密 → 伏せ字にしてから切る（直し方 5）。
- 中断（abortSignal）と重なったとき → 呼び出し側の `throwIfAborted` は今までどおり先に効く。変えない。

## 影響

- 上流：なし（nrslib/takt の main と開いている PR に同じ直しは無いことを確かめた）。
- 保存済みのデータ：なし。
- 公開 API：`AgentResponse.rejectedStructuredOutput`（この PR で足したもの）はそのまま。新しい error クラスは内部のもの。
- 守りの仕組み：loop judge・条件判定・Team Leader の止まり方を #162 の前に戻す（守りが緩む方向の変化を取り消す）。selector の守りは変わらない。返った出力は例外の表示に出ない。

## モックが本物に抜けた経路（調べた結果）

レビューの使い捨てのテストは消されていて、そのままは再現できない。経路はこう：テストが本物の transport を読み（`vi.importActual` か mock なし）、`agents/agent-usecases.js` の `executeAgent` も `agents/runner.js` の `runAgent` も mock していないと、`executeAgent` → `runAgent`（agents/runner.ts）→ `getProvider('claude-terminal' | 'cursor')` → 本物の tmux と cursor-agent に届く。test-setup.ts には HOME・~/.takt の隔離はあるが、本物の provider の呼び出しを止める仕組みは無い。PR のテストは `executeAgent` か `runAgent` を mock しているので、いまは抜けない。全テストに見張りを入れるのはこの PR の範囲を超えるので、経路だけ報告する。

別の issue にするときの中身（メモ）：

- 何を：unit と light IT では、mock でない provider の呼び出しを既定で拒む見張りを test-setup.ts に置く。境界は `getProvider`（infra/providers）か、provider の `call` の入口。`mock` 以外の provider に届いたら、どのテストからどの provider に届いたかを書いて失敗させる。
- 例外：provider 自体のテスト（SDK や tmux を mock して provider のクラスを直接動かすもの）と、heavy IT の一部は本物の provider クラスを使う。`realUserHomeGuard.ts` と同じように、ファイル単位で明示的に許す仕組み（例：テストの先頭で許可を宣言する）を設ける。
- 受け入れ条件：(1) `executeAgent` を mock し忘れたテストで claude-terminal を指定すると、本物の tmux を起動せずに失敗する。(2) 今ある unit・light IT がすべて通る（許可が要るファイルは一覧にする）。(3) mock E2E と provider の E2E は対象外。

## 設計レビューの指摘の処理

| # | 重さ | 処理 | 内容と理由 |
|---|---|---|---|
| 1 | 高 | 直す | rate_limited は failureCategory ではなく status（`src/core/models/status.ts`、`src/infra/rate-limit/detection.ts`）。実物で確かめた。transport の分岐の順（直し方 3）で rate_limited を先に前の経路へ通す。Quint は `Status` と `Category` を分け、`RateLimited` を「status が rate_limited、category 無し」に直し、loop judge の結果は自然な遷移（前と同じ）。不変条件 `rateLimitKeepsPath` を足した。テストと PBT の status に rate_limited を入れた。 |
| 2 | 中 | 直す | (a) 不変条件 `nonDoneNeverReturns`（done でない応答は返さない）を足した。Quint に変異 M7 の instance（`m7`）を置き、この不変条件で落ちることを確かめた。(b) 届かなかった枝は、どんな応答でも返す provider `AnyAdapter` を足して状態空間に入れた（category 無し＋返った出力、rate_limited＋返った出力、stream parse＋返った出力、done＋返った出力）。それぞれの quint test を足した。 |
| 3 | 中 | 直す | 返った出力は列挙されないプロパティにする（直し方 2）。`JSON.stringify`・`Object.keys`・`util.inspect` に出ないことを単体テストで確かめる。既にある `StructuredAgentContractError.response`（列挙される）は #162 の前からのもので、この修正では変えない。 |
| 4 | 中 | 直す | (a) PBT の status に rate_limited を入れた。(b) `describeSelectorError` の単体テストを計画に入れた（テスト 3）。(c) engine-loop-monitors のテストで、mock から本物の normalizer を返すことと、step_error・provider_error を確かめることを明記した（テスト 6）。(d) AI judge と Team Leader は agent-usecases.test.ts の単体テスト（テスト 5）、dynamic parallel の Claude Terminal 経路は coordinator のテスト（テスト 4）で確かめる。 |
| 5 | 低 | 直す | 壊しうる入力に (a)〜(e) を足した。(a)(b) は分岐の順（直し方 3）で前と同じ例外のままにし、PBT で全 category を回す。(e) のキーの伏せ字は直し方 5 で直す。 |
| 6 | 低 | 別件 | モックが本物に抜ける経路を塞ぐのはこの PR の範囲外。issue にする中身を上の「別の issue にするときの中身」に書いた。issue を作るかどうかは副元帥に任せる。 |
| 7 | 軽微 | 採らない（記録） | selector の失敗のときの `recordAgentUsageEvent` の providerUsage と、判定 Stage 1 の記録が #162 の前（undefined）に戻る。Claude Terminal はもともと `usageMissing: true` なので害はない。#162 の前と同じに戻ることなので、直さない。 |
