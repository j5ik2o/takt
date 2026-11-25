# workflow_call が解決できないときのエラーと run の記録（項目327）

PR: https://github.com/j5ik2o/takt/pull/167 ／ 後追いで書いた設計（実装は先に済んでいる）。

## 変えたこと

1. **エラーの中身**: `prepareWorkflowExecutionBundle` で resolver が `null` を返したとき、`Workflow bundle could not resolve call "<workflow>/<step>" (call: …; cwd: …; project: …; searched: …; excluded: …)` を投げる。
   - named の呼び出し: `searched` に project・user の候補パス、`excluded` に builtin の候補と外した理由（`enable_builtin_workflows is false` または `disabled_builtins lists "<name>"`、同名の builtin があるか）。
   - scope（`@…`）: 「installed repertoire packages」とだけ書く。path: 基点のディレクトリを書く。
   - 1行にまとめる（terminal 出力は改行を `\n` にエスケープするため）。
   - 説明は `explainNamedWorkflowLookup`（`workflowLookupDirectories.ts`）が、実際の探索と同じ `getNamedWorkflowLookupDirs` から作る。
2. **記録の順序**: `prepareWorkflowExecutionBundle` を `beginRun` の後、既存の bootstrap の `try` の中へ移した。失敗は `terminalizeBootstrapFailure` を通り、`meta.json`（`status: failed`、`reason`）と logs が残る。central 実行の資格情報チェック（`assertCentralWorkflowBundleCredentialSafety`）も同じ経路になる。
3. **doctor の偽陰性**: `validateWorkflowCallContracts` に `onUnresolvedCall` を足した。`inspectWorkflowFile`（doctor と inspect が使う）だけが渡し、named・scope の呼び出しが解決できなければエラーにする。先に `resolveWorkflowCallTarget` を通し、不正な識別子（`a//b`）は既存のメッセージを優先する。
4. docs（configuration の en/ja/zh-CN、testing/e2e.md）に、外した builtin を `workflow_call` で呼ぶと失敗し、doctor と実行時に理由が出ることを書いた。

### 範囲の外（変えていない）

- builtin を外したときに自動で探し直す・builtin を例外的に許す、といった解決の規則そのもの。
- path 呼び出し（`./x.yaml`）の doctor での扱い（従来どおり飛ばす）。
- `resolveTask`・`providerPreflight`・`taskRetryStartPath` など、ほかの箇所の `null` の扱い。
- `beginRun` 自体が失敗したときの記録。

## 守る不変条件

- 準備（呼び出しの解決を含む）に失敗した run は、必ず `meta.json`（`failed`）と logs を残す。
- 解決できない呼び出しの理由には、呼び出し名・cwd・探した候補・外した候補と理由が入る。
- 準備が済むまで、ステップは1つも動かない。
- 終わった run の `meta.json` が `running` のまま残らない。
- 説明の builtin の扱いは、実際の探索と一致する（探した側か外した側のどちらか一方にだけ出る）。
- doctor が `Workflow OK` と出した workflow は、named・scope の呼び出しがすべて解決できる。

## Quint

`specs/quint/run-start-record/`（`runStartRecord.qnt` ほか）。上の前4つを不変条件にした。新しい順序で `quint test`（3件）・`quint run`（10000 標本）・`quint verify`（8 ステップ）が違反なし。古い順序では `failureIsRecorded` が破れることを `quint run` と `quint test` で示している。

## 性質のテスト（PBT）

このブランチには fast-check が無い（#160 の revert で外れた）ため、乱択ではなく全組み合わせを流す表のテストにした（`workflow-doctor.test.ts` の `named workflow lookup explanation agrees with the lookup`）。

- 入力の集合: `enable_builtin_workflows` ∈ {未設定, true, false} × `disabled_builtins` に名前が ∈ {無い, ある} × 名前 ∈ {同名の builtin がある, 無い} × project に写しが ∈ {無い, ある}（24 通り、全部）。
- 性質: builtin は `searched` と `excluded` のどちらか一方にだけ出る／外したときの理由が設定と合う／project・user の候補は常にこの順で出る／実際の探索（`findWorkflowInLookupDirs`）の結果が説明と合う。
- 除外: なし。

## 壊しうる入力

- 境界: builtin の全体無効と個別無効が両方ある（全体無効の理由を優先して1件だけ出す）。
- 入れ子: 呼び出し先のさらに先の呼び出しが解決できない（bundle も doctor も再帰で同じ扱い）。
- 区切り: 不正な識別子 `a//b`・`..`（既存の識別子エラーが先に出る）。
- `{$param}` の呼び出し: callable を単体で診断すると、既定値の無い `workflow_ref` には discovery 読み込みが仮名（`__takt_discovery_workflow_ref___<param>`）を入れる。doctor は仮名の呼び出しを飛ばす（Devin の指摘で直した）。既定値がある `workflow_ref` は実名なので確かめる。
- 長さ・Unicode: パスや名前はそのまま連結するだけで、切り詰めない。terminal ではエスケープされる。
- 並行・再開: 再開（`resumeSource`）の run でも順序は同じ。失敗した run は既存の失敗 run と同じ形で残るので、再開・一覧の扱いは変わらない。
- `.yml` だけがある場合: 候補は `.yaml (or .yml)` と書く。

## 影響

- 上流（nrslib/takt）: 該当しない（フォークの integration/takt-mcp にだけ出す）。
- 保存済みデータ: 該当しない。新しい形式は足さない。失敗時にも既存形式の run 記録ができるようになる（`.takt/runs/` に失敗 run が増える）。
- 公開の設定・API: 設定キーは変えない。CLI のエラー文言が長くなり、doctor が以前 OK と出していた workflow をエラーにする（実行は以前から失敗していた）。
- 守りの仕組み: 該当しない。central 実行の資格情報チェックは判定を変えず、`beginRun` の後に動くだけ。拒否されたときも meta に残るのはパスと理由で、資格情報の値は書かない。
