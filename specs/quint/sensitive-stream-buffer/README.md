# Sensitive text stream buffer (j5ik2o/takt#151)

A Quint model of where `SensitiveTextStreamBuffer` (`src/shared/utils/sensitive-stream.ts`) cuts its output into committed units: the hold-back guard (`pendingSensitiveValueRanges`), `write`, `flush`, and the forced cut past `MAX_PENDING_SENSITIVE_LINE_LENGTH`.

| File | Content |
|---|---|
| `sensitiveStreamBuffer.qnt` | The model. `withLegacyGuard` and `withNewGuard` choose which readers the guard asks. |
| `sensitiveStreamBuffer_test.qnt` | Three instances and their scenario tests. |

| Instance | Guard | Stands for |
|---|---|---|
| `legacyOnlyGuard` | the frozen previous reading only | 337062193, and the stream of the first PR of #151 (the stream is the previous stream) |
| `newOnlyGuard` | the new reading only | the stream of #165 |
| `unionGuard` | new reading ∪ frozen previous reading | the design of the second PR |

Text is a list of symbols: `P` plain, `KB` a key both readings read, `KL` a key only the previous reading reads, `KN` a key only the new reading reads, `V` a value character, `N` a newline. A newline before the first value character does not close the value (`token:\nsecret`); one after a value character does.

Not modelled: several symbols per write, PEM blocks, `preview`, and the bounded value sets. The first PR's stream is checked against the previous stream by `src/__tests__/sensitive-stream-equality.pbt.test.ts`; the bounded values by `sensitive-value-bounds.pbt.test.ts`.

## Invariants

| Name | Meaning |
|---|---|
| `conservation` | Committed text plus pending text is what was written. |
| `boundedPending` | The pending tail never exceeds the cap. |
| `noSplitNew` | An unforced cut never falls between a key and its value, as the new reading reads them. |
| `noSplitLegacy` | The same for the previous reading. |
| `safety` | All four. |
| `legacySafety` | `conservation`, `boundedPending` and `noSplitLegacy`: what the previous stream promises. |

## Record

Quint 0.32.0, run from this directory. `quint verify` (Apalache) is not used as evidence for this model: in the design review it reported no error on a control instance that fails in three steps.

### First PR: the stream is the previous stream

```
$ quint test --main=legacyOnlyGuard sensitiveStreamBuffer_test.qnt
    ok legacyKeyHeldAcrossNewlineTest passed 1 test(s)
    ok newKeySplitTest passed 1 test(s)
$ quint run --main=legacyOnlyGuard --invariant=legacySafety --max-steps=10 --max-samples=20000 --seed=1 sensitiveStreamBuffer_test.qnt
[ok] No violation found
$ quint run --main=legacyOnlyGuard --invariant=legacySafety --max-steps=14 --max-samples=50000 --seed=2 sensitiveStreamBuffer_test.qnt
[ok] No violation found
$ quint run --main=legacyOnlyGuard --invariant=legacySafety --max-steps=14 --max-samples=50000 --seed=3 sensitiveStreamBuffer_test.qnt
[ok] No violation found
$ quint run --main=legacyOnlyGuard --invariant=noSplitNew --max-steps=10 --max-samples=20000 --seed=1 sensitiveStreamBuffer_test.qnt
[violation] Found an issue    (expected: the previous stream may cut after a key only the new reading reads; the second PR closes this)
```

### Second PR: checks of the design

```
$ quint test --main=unionGuard sensitiveStreamBuffer_test.qnt
    ok legacyKeyHeldAcrossNewlineTest passed 1 test(s)
$ quint test --main=newOnlyGuard sensitiveStreamBuffer_test.qnt
    ok legacyKeySplitTest passed 1 test(s)
$ quint run --main=unionGuard --invariant=safety --max-steps=10 --max-samples=20000 --seed=1 sensitiveStreamBuffer_test.qnt
[ok] No violation found
$ quint run --main=unionGuard --invariant=safety --max-steps=14 --max-samples=50000 --seed=2 sensitiveStreamBuffer_test.qnt
[ok] No violation found
$ quint run --main=unionGuard --invariant=safety --max-steps=14 --max-samples=50000 --seed=3 sensitiveStreamBuffer_test.qnt
[ok] No violation found
$ quint run --main=newOnlyGuard --invariant=noSplitNew --max-steps=10 --max-samples=20000 --seed=1 sensitiveStreamBuffer_test.qnt
[ok] No violation found
$ quint run --main=newOnlyGuard --invariant=noSplitLegacy --max-steps=10 --max-samples=20000 --seed=1 sensitiveStreamBuffer_test.qnt
[violation] Found an issue    (expected: without the previous reading, a previous-only key is cut from its value)
```

The second PR still has to add multi-symbol writes, keys that depend on an earlier value, and the invariants for its unit cutting (design sections 7 and 11, review R7-3).
