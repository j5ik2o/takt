# 定義が変わったあとの再開で、引き継ぐ記録を名前で照合する（j5ik2o/takt#111）

`resumeRecordsByName.qnt` は、中断した run を保存位置から再開するときに、前の run の参加記録（どの step がレポートを出したか）を引き継ぐ状態遷移を表す。

## 対象のコード

- `src/core/workflow/workflow-reference.ts`（workflow の参照。builtin は中身の sha256 を含む）
- `src/core/workflow/workflow-step-participation-index.ts`（参加記録の識別子は、workflow の参照・step 名・呼び出し位置）
- `src/core/workflow/review-report-discovery.ts`（生成元の記録が引けないと `workflow_report_input_not_produced`）
- `src/core/workflow/workflow-resume-records.ts`（修正後：保存済みの記録を名前と位置で照合する）
- `src/core/workflow/report-execution-store.ts`（修正後：引き継いだ生成元の印 `isInheritedProducer`）

## モデルの範囲

workflow は `peer-review` の次の形に縮めている。

```text
Adjudicate --常に-->   Gate        （review-resolution.md を出す）
Gate       --approve-> COMPLETE
Gate       --reject--> Remediate
Remediate  --常に-->   Gate        （Adjudicate のレポートを必須の入力にする）
```

run はどの step の前でも止まり（`interrupt`）、止まっている間に定義の中身が変わることがある（`definitionChanges`。名前は変わらない）。`requeue` は保存位置から再開し、それより前の step は実行し直さない。

`matchByName` で挙動を切り替える。`current` は修正前（false。記録は書いたときの定義の hash のまま）、`fixed` は修正後（true。記録を今の定義の識別子に付け替え、生成元を「引き継ぎ」として覚える）。

扱っていないもの：`workflow_call` の入れ子と呼び出し実行回、並列 step、workflow 名が変わった場合（記録を捨てる）、レポート本文が消えていた場合（警告して入力を省く）、引き継いだ生成元を今回の run で実行し直した後の通常の検査。

## 不変条件

`noLostAdjudication`：Adjudicate の記録が残っているのに、Remediate が「入力が生成されていない」で中断することはない。

## 結果（quint 0.32.0）

修正前のモデルで反例が出る。

```sh
quint run resumeRecordsByName.qnt --main=current --invariant=noLostAdjudication \
  --max-steps=12 --max-samples=10000 --seed=0x111
```

出力は `[violation] Found an issue`、再現用の seed は `0x44b`。反例は11状態。

| 状態 | 起きたこと | status | current | defHash | records |
|---|---|---|---|---|---|
| 0 | 開始 | Running | Adjudicate | 0 | なし |
| 1〜2 | 中断して再開（定義は同じ） | Running | Adjudicate | 0 | なし |
| 3 | Adjudicate がレポートを出す | Running | Gate | 0 | (0, Adjudicate) |
| 4 | Gate の前で中断 | Stopped | Gate | 0 | (0, Adjudicate) |
| 5 | 定義の中身が変わる | Stopped | Gate | 1 | (0, Adjudicate) |
| 6 | Gate から再開 | Running | Gate | 1 | (0, Adjudicate) |
| 7 | Gate が reject | Running | Remediate | 1 | (0, Adjudicate) |
| 8〜9 | 中断して再開 | Running | Remediate | 1 | (0, Adjudicate) |
| 10 | Remediate が入力を引けず中断 | Aborted（InputNotProduced） | Remediate | 1 | (0, Adjudicate) |

状態 4〜7 と 10 が issue の経路（final-gate から再開 → REJECT → remediation が中断）である。

修正後のモデルでは、同じ不変条件で反例が出なかった。

```sh
quint run resumeRecordsByName.qnt --main=fixed --invariant=noLostAdjudication \
  --witnesses="status == Completed and resumes > 0 and inherited.contains(Adjudicate)" "status == Aborted" \
  --max-steps=12 --max-samples=10000 --seed=0x111
```

10,000 サンプル、max-steps 12、seed 0x111 で反例なし。到達の確認（witness）は、「引き継いだ記録を使って再開後に完了する」が 2,397 件、「中断で終わる」が 0 件。trace の最短は3（Adjudicate → Gate が approve して終わる経路）で、Completed は終端である。

issue の経路を1手ずつたどるテストは `resumeRecordsByName_test.qnt` にある。

```sh
quint test resumeRecordsByName_test.qnt --main=currentTest   # 2 passing（修正前は中断する／hash が同じなら続く）
quint test resumeRecordsByName_test.qnt --main=fixedTest     # 2 passing（修正後は定義が変わっても続く）
```

仕様とコードは機械的にはつながっていない。コードの回帰テストは `src/__tests__/it-resume-report-input.test.ts`（`passes the saved adjudication report after only the peer workflow hash changes` ほか）、`src/__tests__/resume-records-by-name.test.ts` にある。
