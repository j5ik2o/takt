# Sensitive text stream buffer (j5ik2o/takt#151)

A Quint model of where `SensitiveTextStreamBuffer` (`src/shared/utils/sensitive-stream.ts`) cuts its output into committed units: the hold-back guard (`pendingSensitiveValueRanges`), `write`, `flush`, and the forced cut past `MAX_PENDING_SENSITIVE_LINE_LENGTH`.

| File | Content |
|---|---|
| `sensitiveStreamBuffer.qnt` | The model. `withLegacyGuard` and `withNewGuard` choose which readers the guard asks. |
| `sensitiveStreamBuffer_test.qnt` | Three instances and their scenario tests. |
| `sensitiveStreamUnion.qnt` | The second PR's stream (design 7.1, 7.2): the inner stream (the first PR's) and the outer hold. |
| `sensitiveStreamUnion_test.qnt` | The design (`unionStream`) and the seven broken streams, with scenario and witness tests. |

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

The second PR's model is `sensitiveStreamUnion.qnt` below.

## The second PR's stream (`sensitiveStreamUnion.qnt`)

The inner stream cuts where the previous stream cut (the first PR's buffer, `firstClosedLine` with the previous reading, forced past the cap). The outer stream holds the previous units it gets and commits a run of them as one new unit (design 7.1):

- rule 1: a forced previous unit commits everything held (forced);
- rule 2: the new reading, from the start of the held run, is closed at the end of the unit (unforced). It is asked only at the last unit a write brings (design 7.1, 12th edition): asking it at every unit read the held run again per line;
- rule 3a: the held run is longer than the cap (forced);
- rule 4: otherwise it keeps holding;
- rule 3b, after the units of a write: held text plus the inner pending tail is longer than the cap, so the held run is committed at its end, the last previous boundary (forced).

A new unit hides (s1) each previous unit's own range-path reading, (s2) the previous trace over each previous unit, (s3) both readings over the new unit, and (s6) the fourth-argument positions of every held unit. Writes are 1–3 symbols, and a write may name one position as its fourth argument.

Two symbols join the six of the first model:

| Symbol | Meaning |
|---|---|
| `G` | In the previous range path, it keeps a later `KL` of the same reading from being a key. Read per previous unit, a `KL` after a `G` of an earlier unit is a key; read joined, it is not (the range path is not monotone, design 7.1 "why not reread"). |
| `C` | Hidden only by the previous trace over a previous unit: a `C` after a position the previous range path hid in the same unit (fixed example #3's `Zq0Zq`, design 11). |

The previous trace starts from the ranges it is given (`previousDisplayRanges` seeds its hidden ranges with the unit's (s1)), so (s2) contains (s1). Dropping only (s1) changes nothing; the mutations `rereadJoined` and `dropHeldHidden` lose a unit's (s1) and the (s2) that starts from it.

Not modelled: the bounded value sets, PEM blocks, `preview`, the third argument (substring values), the value prefixes (s5), and DeepSeek's boundary text. The PBT checks them (`src/__tests__/sensitive-stream-union.pbt.test.ts`, design 3).

| Invariant | Meaning |
|---|---|
| `conservation` | The new committed text, the held units and the inner pending tail are what was written, and the held units are contiguous. |
| `boundedPending` | Held text plus the inner pending tail never exceeds the cap between transitions. |
| `boundariesSubset` | Every new cut is a previous cut. |
| `unitHidesLegacy` | What the previous range path hid per previous unit (s1) is hidden once the new stream commits it. |
| `unitHidesLegacyDisplay` | The same for the previous trace (s2). |
| `unitHidesExtra` | The same for the fourth argument (s6). |
| `noSplitNew`, `noSplitLegacy` | An unforced new cut never falls between a key and its value, for the new and for the previous reading. |
| `unionSafety` | All eight. |

| Instance (`mutation`) | Broken how | Breaks |
|---|---|---|
| `cutAtWriteEnd` | rule 3b cuts at the end of the write, through the inner pending tail (the current code's forced cut) | `boundariesSubset`, `unitHidesLegacy` |
| `rereadJoined` | (s1) is not kept per previous unit; the new unit is read again with the previous range path | `unitHidesLegacy` |
| `noNewGuard` | rule 2 always commits (the first PR's stream) | `noSplitNew` |
| `newGuardOnly` | the outer cuts by the new reading alone, without the inner (#165's stream) | `boundariesSubset`, `noSplitLegacy` |
| `dropHeldHidden` | only the last held unit's (s1) is added | `unitHidesLegacy` |
| `dropDisplayTrace` | (s2) is not added | `unitHidesLegacyDisplay` |
| `dropEarlierExtra` | only the last held unit's fourth-argument positions are added | `unitHidesExtra` |

### Record (2a, design 12th edition: rule 2 once per write)

```
$ quint test --main=unionStream sensitiveStreamUnion_test.qnt
    ok newKeyHeldAcrossOldBoundaryTest passed 1 test(s)
    ok forcedCutAtOldBoundaryTest passed 1 test(s)
    ok chainKeyHiddenPerOldUnitTest passed 1 test(s)
    ok displayChainHiddenPerOldUnitTest passed 1 test(s)
    ok extraRangePreservedAcrossHeldWritesTest passed 1 test(s)
    ok ruleTwoAtTheEndOfAWriteTest passed 1 test(s)
    ok flushCommitsEverythingTest passed 1 test(s)
$ quint run --main=unionStream --invariant=unionSafety --max-steps=10 --max-samples=20000 --seed=1 sensitiveStreamUnion_test.qnt
[ok] No violation found
$ quint run --main=unionStream --invariant=unionSafety --max-steps=14 --max-samples=50000 --seed=2 sensitiveStreamUnion_test.qnt
[ok] No violation found
$ quint run --main=unionStream --invariant=unionSafety --max-steps=14 --max-samples=50000 --seed=3 sensitiveStreamUnion_test.qnt
[ok] No violation found
```

Each broken instance has a witness test (`quint test --main=<instance>`, it ends in a state that breaks the invariant), and simulation finds a violation of the invariant it must break:

```
$ quint test --main=<instance> sensitiveStreamUnion_test.qnt        # ok <instance>WitnessTest, for all seven
$ quint run --main=<instance> --invariant=<invariant> --max-steps=10 --max-samples=20000 --seed=1 sensitiveStreamUnion_test.qnt
cutAtWriteEnd     boundariesSubset         [violation] Found an issue
cutAtWriteEnd     unitHidesLegacy          [violation] Found an issue
rereadJoined      unitHidesLegacy          [violation] Found an issue
noNewGuard        noSplitNew               [violation] Found an issue
newGuardOnly      boundariesSubset         [violation] Found an issue
newGuardOnly      noSplitLegacy            [violation] Found an issue
dropHeldHidden    unitHidesLegacy          [violation] Found an issue
dropDisplayTrace  unitHidesLegacyDisplay   [violation] Found an issue
dropEarlierExtra  unitHidesExtra           [violation] Found an issue
```

The simulator writes 1–3 random symbols or one of `CHUNKS`, the pieces of the shapes above; without them, a violation that needs three particular writes is too rare to sample.
