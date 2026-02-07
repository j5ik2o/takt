Run tests, verify the build, and perform final approval.

**Overall piece verification:**
1. Whether the plan and implementation results are consistent
2. Whether findings from each review movement have been addressed
3. Whether the original task objective has been achieved

**Report verification:** Read all reports in the Report Directory and
check for any unaddressed improvement suggestions.

**Validation report format:**
```markdown
# Final Verification Results

## Result: APPROVE / REJECT

## Verification Summary
| Item | Status | Verification method |
|------|--------|-------------------|
| Requirements met | ✅ | Cross-checked with requirements list |
| Tests | ✅ | `npm test` (N passed) |
| Build | ✅ | `npm run build` succeeded |
| Functional check | ✅ | Main flows verified |

## Deliverables
- Created: {Created files}
- Modified: {Modified files}

## Outstanding items (if REJECT)
| # | Item | Reason |
|---|------|--------|
| 1 | {Item} | {Reason} |
```

**Summary report format (only if APPROVE):**
```markdown
# Task Completion Summary

## Task
{Original request in 1-2 sentences}

## Result
Complete

## Changes
| Type | File | Summary |
|------|------|---------|
| Create | `src/file.ts` | Summary description |

## Verification commands
```bash
npm test
npm run build
```
```
