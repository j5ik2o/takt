<!--
  template: perform_phase3_message
  phase: 3 (status judgment)
  vars: criteriaTable, outputList, hasAppendix, appendixContent
  builder: StatusJudgmentBuilder
-->
作業結果を振り返り、ステータスを判定してください。追加の作業は行わないでください。

## 判定基準

{{criteriaTable}}

## 出力フォーマット

{{outputList}}
{{#if hasAppendix}}

### 追加出力テンプレート
{{appendixContent}}{{/if}}
