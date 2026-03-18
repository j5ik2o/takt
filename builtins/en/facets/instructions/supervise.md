Verify existing evidence for tests, builds, and functional checks, then perform final approval.

**Overall piece verification:**
1. Check all reports in the report directory and verify overall piece consistency
   - Does implementation match the plan?
   - Were all review movement findings properly addressed?
   - Was the original task objective achieved?
2. Whether each task spec requirement has been achieved
   - Extract requirements one by one from the task spec
   - If a single sentence contains multiple conditions or paths, split it into the smallest independently verifiable units
     - Example: treat `global/project` as separate requirements
     - Example: treat `JSON override / leaf override` as separate requirements
     - Example: split parallel expressions such as `A and B`, `A/B`, `allow/deny`, or `read/write`
   - For each requirement, identify the implementing code (file:line)
   - Verify the code actually fulfills the requirement (read the file, check existing test/build evidence)
   - Do not mark a composite requirement as ✅ based on only one side of the cases
   - Evidence must cover the full content of the requirement row
   - Do not rely on the plan report's judgment; independently verify each requirement
   - If any requirement is unfulfilled, REJECT
3. Handling tests, builds, and functional checks
   - Do not assume this movement will rerun commands
   - Use only evidence available in this run, such as execution logs, reports, or CI results
   - If evidence is missing, mark the item as unverified
   - If report text conflicts with execution evidence, call out the inconsistency explicitly

**Report verification:** Read all reports in the Report Directory and
check for any unaddressed improvement suggestions.

**Validation output contract:**
```markdown
# Final Verification Results

## Result: APPROVE / REJECT

## Requirements Fulfillment Check

Extract requirements from the task spec and verify each one individually against actual code.

| # | Requirement (extracted from task spec) | Met | Evidence (file:line) |
|---|---------------------------------------|-----|---------------------|
| 1 | {requirement 1} | ✅/❌ | `src/file.ts:42` |
| 2 | {requirement 2} | ✅/❌ | `src/file.ts:55` |

- If any ❌ exists, REJECT is mandatory
- ✅ without evidence is invalid (must verify against actual code)
- Do not rely on plan report's judgment; independently verify each requirement

## Verification Summary
| Item | Status | Verification method |
|------|--------|-------------------|
| Tests | ✅ / ⚠️ / ❌ | {Execution log, report, CI result, or why unverified} |
| Build | ✅ / ⚠️ / ❌ | {Execution log, report, CI result, or why unverified} |
| Functional check | ✅ / ⚠️ / ❌ | {Evidence used, or state that it was not verified} |

## Deliverables
- Created: {Created files}
- Modified: {Modified files}

## Outstanding items (if REJECT)
| # | Item | Reason |
|---|------|--------|
| 1 | {Item} | {Reason} |
```

**Summary output contract (only if APPROVE):**
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

## Verification evidence
- {Evidence for tests/builds/functional checks}
```
