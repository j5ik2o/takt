```markdown
# Architecture Review

## Result: APPROVE / IMPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
- [x] Structure & design
- [x] Code quality
- [x] Change scope
- [x] Test coverage
- [x] Dead code
- [x] Call chain verification

## Issues (if REJECT)
| # | Scope | Location | Issue | Fix Suggestion |
|---|-------|----------|-------|----------------|
| 1 | In-scope | `src/file.ts:42` | Issue description | Fix approach |

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

## Existing Issues (reference, non-blocking)
- {Record of existing issues unrelated to the current change}
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Issues in table format (30 lines or fewer)
