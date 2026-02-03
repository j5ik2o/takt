<!--
  template: perform_phase3_message
  phase: 3 (status judgment)
  vars: criteriaTable, outputList, hasAppendix, appendixContent
  builder: StatusJudgmentBuilder
-->
Review your work results and determine the status. Do NOT perform any additional work.

## Decision Criteria

{{criteriaTable}}

## Output Format

{{outputList}}
{{#if hasAppendix}}

### Appendix Template
{{appendixContent}}{{/if}}
