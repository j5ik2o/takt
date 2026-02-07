```markdown
# AI-Generated Code Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in one sentence}

## Verified Items
| Aspect | Result | Notes |
|--------|--------|-------|
| Validity of assumptions | ✅ | - |
| API/library existence | ✅ | - |
| Context fit | ✅ | - |
| Scope | ✅ | - |

## Issues (if REJECT)
| # | Category | Location | Issue |
|---|----------|----------|-------|
| 1 | Hallucinated API | `src/file.ts:23` | Non-existent method |
```

**Cognitive load reduction rules:**
- No issues → Summary sentence + checklist only (10 lines or fewer)
- Issues found → + Issues in table format (25 lines or fewer)
