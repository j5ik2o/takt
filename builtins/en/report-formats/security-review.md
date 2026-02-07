```markdown
# Security Review

## Result: APPROVE / REJECT

## Severity: None / Low / Medium / High / Critical

## Check Results
| Category | Result | Notes |
|----------|--------|-------|
| Injection | ✅ | - |
| Authentication & Authorization | ✅ | - |
| Data Protection | ✅ | - |
| Dependencies | ✅ | - |

## Vulnerabilities (if REJECT)
| # | Severity | Type | Location | Fix Suggestion |
|---|----------|------|----------|----------------|
| 1 | High | SQLi | `src/db.ts:42` | Use parameterized queries |

## Warnings (non-blocking)
- {Security recommendations}
```

**Cognitive load reduction rules:**
- No issues → Checklist only (10 lines or fewer)
- Warnings present → + Warnings in 1-2 lines (15 lines or fewer)
- Vulnerabilities found → + Table format (30 lines or fewer)
