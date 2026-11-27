// -*- mode: Bluespec; -*-
// The second PR's stream (j5ik2o/takt#151, design 7.1 and 7.2): an inner stream that cuts where the
// previous stream cut, and an outer hold that commits a run of previous units as one new unit only
// when the new reading is closed too.
//
// Source of the model (design 7.1; the implementation follows in 2a):
//   src/shared/utils/sensitive-stream.ts  inner LegacyStreamUnits (the first PR's buffer),
//                                         outer SensitiveTextStreamBuffer (held units, rules 1–4, 3a, 3b),
//                                         the union per new unit (s1)–(s6), the fourth argument of write
//
// Symbols, as in sensitiveStreamBuffer.qnt:
//   P  plain character
//   KB key both readings read
//   KL key only the previous reading reads
//   KN key only the new reading reads
//   V  value character
//   N  newline
// and two more (design 7.2, R9-4):
//   G  in the previous range path (s1), a match that keeps a later KL of the same reading from being
//      read as a key (the range path is not monotone). Reading each previous unit from its start,
//      a KL after a G of an earlier unit is still a key; reading the units joined, it is not.
//   C  hidden only by the previous trace over a previous unit (s2): a C after a position the
//      previous range path hid in the same unit. No reading hides it on its own.
// A key opens a value; a newline before the first value character does not close it, one after does.
//
// `mutation` selects a deliberately broken outer stream (design 7.2, seven mutations); "none" is the
// design. The simulator writes 1–3 random symbols, or one of `CHUNKS` (the cuts that matter).
module sensitiveStreamUnion {
  type Sym = P | KB | KL | KN | V | N | G | C

  const CAP: int          // MAX_PENDING_SENSITIVE_LINE_LENGTH, scaled down
  const mutation: str     // "none" | "cutAtWriteEnd" | "rereadJoined" | "noNewGuard" | "newGuardOnly"
                          // | "dropHeldHidden" | "dropDisplayTrace" | "dropEarlierExtra"
  val ALPHABET = Set(P, KB, KL, KN, V, N, G, C)
  /// Writes the simulator prefers: the pieces of the shapes in design 7.2 and 8 (a key cut from its
  /// value, a line only the new reading keeps open, a G before a later unit's KL, a C after a value).
  val CHUNKS: Set[List[Sym]] = Set(
    [KN, N], [KN, G, N], [G, N], [V, N], [N], [V], [P, N], [P, P, P],
    [V, KL, V], [V, KL, V, KN, N], [KB, V], [KB, V, V], [KB, V, C], [C, N], [KL, N], [KB, N],
  )

  /// A previous unit: where it is in the written text, what the previous range path hid (s1), what
  /// the previous trace hid (s2), the fourth-argument positions in it (s6), and whether it was forced.
  type Unit = { start: int, end: int, hidden: Set[int], displayHidden: Set[int], extra: Set[int], forced: bool }
  type Boundary = { at: int, forced: bool }

  var written: List[Sym]
  // The inner (previous) stream.
  var lPending: List[Sym]
  var lBoundaries: Set[Boundary]
  var lHidden: Set[int]
  var lDisplayed: Set[int]
  // The fourth argument: every position passed, and the ones still in lPending (relative to its start).
  var expectedExtra: Set[int]
  var pendingExtra: Set[int]
  // The outer (new) stream.
  var held: List[Unit]
  var nLen: int
  var nBoundaries: Set[Boundary]
  var nHidden: Set[int]
  /// Cuts rules 3a and 3b made at the cap: `fallback` when no held boundary had the new reading closed.
  var capCuts: Set[{ at: int, fallback: bool }]

  // ------------------------------------------------------------------------------------------
  // Readings. `legacy` reads KL (unless a G came first) and `fresh` reads KN; both read KB.

  type Acc = { s: int, g: bool, hidden: Set[int] }

  pure def readKey(sym: Sym, acc: Acc, legacy: bool, fresh: bool): bool =
    sym == KB or (sym == KL and legacy and not(acc.g)) or (sym == KN and fresh)

  pure def readStep(acc: Acc, i: int, sym: Sym, legacy: bool, fresh: bool): Acc = {
    val s =
      if (readKey(sym, acc, legacy, fresh)) 1
      else match sym {
        | V => if (acc.s >= 1) 2 else 0
        | N => if (acc.s == 2) 0 else acc.s
        | _ => if (acc.s == 2) 0 else acc.s
      }
    { s: s, g: acc.g or (sym == G and legacy), hidden: if (s == 2) acc.hidden.union(Set(i)) else acc.hidden }
  }

  pure def read(text: List[Sym], legacy: bool, fresh: bool): Acc =
    range(0, text.length()).foldl({ s: 0, g: false, hidden: Set() }, (acc, i) => readStep(acc, i, text[i], legacy, fresh))

  pure def valueState(text: List[Sym], legacy: bool, fresh: bool): int = read(text, legacy, fresh).s

  /// The value positions a reading hides in `text`, shifted to start at `offset`.
  pure def hiddenIn(text: List[Sym], offset: int, legacy: bool, fresh: bool): Set[int] =
    read(text, legacy, fresh).hidden.map(i => i + offset)

  /// (s2): a C after a position the previous range path hid in the same unit.
  pure def displayHiddenIn(text: List[Sym], offset: int): Set[int] = {
    val hidden = read(text, true, false).hidden
    range(0, text.length()).foldl(Set(), (found, i) =>
      if (text[i] == C and hidden.exists(j => j < i)) found.union(Set(i + offset)) else found)
  }

  pure def open(text: List[Sym], legacy: bool, fresh: bool): bool = valueState(text, legacy, fresh) != 0

  /// Index after the first newline whose prefix is closed for the reading, or -1.
  pure def firstClosedLine(text: List[Sym], legacy: bool, fresh: bool): int =
    range(0, text.length()).foldl(-1, (found, i) =>
      if (found >= 0) found
      else if (text[i] == N and not(open(text.slice(0, i + 1), legacy, fresh))) i + 1
      else -1)

  pure def insideSecret(text: List[Sym], at: int, legacy: bool, fresh: bool): bool =
    at > 0 and at < text.length() and valueState(text.slice(0, at), legacy, fresh) != 0
      and valueState(text.slice(0, at + 1), legacy, fresh) == 2

  // ------------------------------------------------------------------------------------------
  // The inner stream: the first PR's stream, unchanged (design 7.1 "inner").

  type Drain = { pending: List[Sym], start: int, units: List[Unit], extra: Set[int], done: bool }

  pure def legacyUnit(text: List[Sym], start: int, extra: Set[int], forced: bool): Unit = {
    val hidden = hiddenIn(text, start, true, false)
    { start: start, end: start + text.length(), hidden: hidden,
      displayHidden: hidden.union(displayHiddenIn(text, start)), extra: extra, forced: forced }
  }

  /// Cut every closed line, or all of the pending text past the cap. `extra` is relative to `pending`.
  pure def drainLegacy(pending: List[Sym], start: int, extra: Set[int], cap: int): Drain =
    range(0, 16).foldl({ pending: pending, start: start, units: [], extra: extra, done: false }, (d, _) =>
      if (d.done) d
      else {
        val cut = firstClosedLine(d.pending, true, false)
        val end = if (cut >= 0) cut else d.pending.length()
        if (cut >= 0 or d.pending.length() > cap) {
          val unitExtra = d.extra.filter(p => p < end).map(p => d.start + p)
          { pending: d.pending.slice(end, d.pending.length()), start: d.start + end,
            units: d.units.append(legacyUnit(d.pending.slice(0, end), d.start, unitExtra, cut < 0)),
            extra: d.extra.filter(p => p >= end).map(p => p - end), done: false }
        } else { ...d, done: true }
      })

  // ------------------------------------------------------------------------------------------
  // The outer stream (design 7.1: rules 1, 3a, 4 per unit, rule 2 at the write's last unit, rule 3b after the units).

  type Outer = { held: List[Unit], nLen: int, nBoundaries: Set[Boundary], nHidden: Set[int], capCuts: Set[{ at: int, fallback: bool }] }

  pure def heldLength(held: List[Unit]): int = held.foldl(0, (n, u) => n + u.end - u.start)
  pure def unionOf(held: List[Unit], part: (Unit) => Set[int]): Set[int] = held.foldl(Set(), (s, u) => s.union(part(u)))
  pure def lastOf(held: List[Unit], part: (Unit) => Set[int]): Set[int] =
    if (held.length() == 0) Set() else part(held[held.length() - 1])

  /// Commit `held` (and, for cutAtWriteEnd, up to `end`) as one new unit: (s1) ∪ (s2) ∪ (s3) ∪ (s6).
  pure def commit(o: Outer, text: List[Sym], end: int, forced: bool): Outer = {
    val unit = text.slice(o.nLen, end)
    // (s2) starts from (s1): the previous trace over a unit returns the ranges it was given
    // (`previousDisplayRanges` seeds its hidden ranges with them). So a stream that loses a unit's
    // (s1) loses the seed of its (s2) too, and the mutations below drop both.
    val s1 =
      if (mutation == "rereadJoined") hiddenIn(unit, o.nLen, true, false)
      else if (mutation == "dropHeldHidden") lastOf(o.held, u => u.hidden)
      else unionOf(o.held, u => u.hidden)
    val s2 =
      if (mutation == "dropDisplayTrace") Set()
      else if (mutation == "rereadJoined") hiddenIn(unit, o.nLen, true, false).union(displayHiddenIn(unit, o.nLen))
      else if (mutation == "dropHeldHidden") lastOf(o.held, u => u.displayHidden)
      else unionOf(o.held, u => u.displayHidden)
    val s3 = hiddenIn(unit, o.nLen, true, false).union(hiddenIn(unit, o.nLen, false, true))
    val s6 = if (mutation == "dropEarlierExtra") lastOf(o.held, u => u.extra) else unionOf(o.held, u => u.extra)
    { ...o, held: [], nLen: end, nBoundaries: o.nBoundaries.union(Set({ at: end, forced: forced })),
      nHidden: o.nHidden.union(s1).union(s2).union(s3).union(s6) }
  }

  /// Commit the first `count` held units as one new unit, and keep the rest held.
  pure def commitFirst(o: Outer, text: List[Sym], count: int, forced: bool): Outer = {
    val first = o.held.slice(0, count)
    val committed = commit({ ...o, held: first }, text, first[count - 1].end, forced)
    { ...committed, held: o.held.slice(count, o.held.length()) }
  }

  /// The largest `k` such that the new reading of the held run, from its start, is closed after its
  /// first `k` units (0 when it is closed after none).
  pure def closedHeldCount(o: Outer, text: List[Sym]): int =
    range(1, o.held.length() + 1).foldl(0, (best, k) =>
      if (valueState(text.slice(o.nLen, o.held[k - 1].end), false, true) == 0) k else best)

  /// Rules 3a and 3b (design 7.1, 13th edition): at the cap, cut at the last held boundary where the
  /// new reading is closed, so the open new value stays whole; if the held run is still over the cap
  /// (the open value itself is about as long as the cap), commit the rest under force.
  pure def overCap(q: Outer, restLength: int): bool = q.held.length() > 0 and heldLength(q.held) + restLength > CAP

  pure def capCut(o: Outer, text: List[Sym], restLength: int): Outer = {
    if (mutation == "capCutAtHeldEnd") {
      val end = o.nLen + heldLength(o.held)
      val c = commit(o, text, end, true)
      { ...c, capCuts: c.capCuts.union(Set({ at: end, fallback: false })) }
    } else {
      val k = closedHeldCount(o, text)
      val cut = if (k > 0) {
        val c = commitFirst(o, text, k, false)
        { ...c, capCuts: c.capCuts.union(Set({ at: c.nLen, fallback: false })) }
      } else o
      if (overCap(cut, restLength)) {
        val end = cut.nLen + heldLength(cut.held)
        val c = commit(cut, text, end, true)
        { ...c, capCuts: c.capCuts.union(Set({ at: end, fallback: true })) }
      } else cut
    }
  }

  /// A unit the outer already passed (only after cutAtWriteEnd) is trimmed and read again from the
  /// cut, as the code that cut there would read it.
  pure def arriving(u: Unit, text: List[Sym], nLen: int): Unit =
    if (u.start >= nLen) u
    else {
      val rest = text.slice(nLen, u.end)
      legacyUnit(rest, nLen, u.extra.filter(p => p >= nLen), u.forced)
    }

  /// `last`: the unit is the last one this write brought. `ask`: whether rule 2 is asked at all in this
  /// write. Rule 2 reads the held run from its start, so the implementation asks it only at the last unit
  /// of a write and only when the held run has doubled since it last asked (design 7.1, 13th edition);
  /// the model lets any write skip it, which covers every such schedule.
  pure def pushUnit(o: Outer, raw: Unit, text: List[Sym], last: bool, ask: bool): Outer =
    if (raw.end <= o.nLen) o
    else {
      val u = arriving(raw, text, o.nLen)
      val grown = { ...o, held: o.held.append(u) }
      val newClosed = mutation == "noNewGuard" or (last and ask and not(open(text.slice(o.nLen, u.end), false, true)))
      if (u.forced) commit(grown, text, u.end, true)                                // rule 1
      else if (newClosed) commit(grown, text, u.end, false)                         // rule 2
      else if (heldLength(grown.held) > CAP) capCut(grown, text, 0)                 // rule 3a
      else grown                                                                    // rule 4
    }

  /// newGuardOnly (#165's stream): the outer cuts by the new reading alone, without waiting for the inner.
  pure def newOnlyCuts(o: Outer, text: List[Sym], flushing: bool): Outer =
    range(0, 16).foldl(o, (q, _) => {
      val rest = text.slice(q.nLen, text.length())
      val cut = firstClosedLine(rest, false, true)
      if (rest.length() == 0) q
      else if (cut >= 0) commit(q, text, q.nLen + cut, false)
      else if (rest.length() > CAP or flushing) commit(q, text, text.length(), true)
      else q
    })

  pure def outerAfterWrite(o: Outer, units: List[Unit], text: List[Sym], restLength: int, ask: bool): Outer =
    if (mutation == "newGuardOnly") newOnlyCuts(o, text, false)
    else {
      val pushed = range(0, units.length()).foldl(o, (q, i) => pushUnit(q, units[i], text, i == units.length() - 1, ask))
      if (pushed.held.length() > 0 and heldLength(pushed.held) + restLength > CAP) {
        if (mutation == "cutAtWriteEnd") commit(pushed, text, text.length(), true)  // the current code's cut
        else capCut(pushed, text, restLength)                                       // rule 3b
      } else pushed
    }

  // ------------------------------------------------------------------------------------------
  // Transitions.

  action init = all {
    written' = [], lPending' = [], lBoundaries' = Set(), lHidden' = Set(), lDisplayed' = Set(),
    expectedExtra' = Set(), pendingExtra' = Set(),
    held' = [], nLen' = 0, nBoundaries' = Set(), nHidden' = Set(), capCuts' = Set(),
  }

  pure def unitBoundaries(units: List[Unit]): Set[Boundary] = units.foldl(Set(), (s, u) => s.union(Set({ at: u.end, forced: u.forced })))

  /// write(syms, extraAt, ask): `extraAt` is -1 (no fourth argument) or a position in `syms`; `ask`
  /// is whether rule 2 is asked at the write's last unit.
  action write(syms: List[Sym], extraAt: int, ask: bool): bool = {
    val text = written.concat(syms)
    val extra = if (extraAt >= 0) pendingExtra.union(Set(lPending.length() + extraAt)) else pendingExtra
    val d = drainLegacy(lPending.concat(syms), written.length() - lPending.length(), extra, CAP)
    val o = outerAfterWrite({ held: held, nLen: nLen, nBoundaries: nBoundaries, nHidden: nHidden, capCuts: capCuts }, d.units, text, d.pending.length(), ask)
    all {
      syms.length() > 0,
      written' = text,
      expectedExtra' = if (extraAt >= 0) expectedExtra.union(Set(written.length() + extraAt)) else expectedExtra,
      lPending' = d.pending,
      pendingExtra' = d.extra,
      lBoundaries' = lBoundaries.union(unitBoundaries(d.units)),
      lHidden' = lHidden.union(unionOf(d.units, u => u.hidden)),
      lDisplayed' = lDisplayed.union(unionOf(d.units, u => u.displayHidden)),
      held' = o.held, nLen' = o.nLen, nBoundaries' = o.nBoundaries, nHidden' = o.nHidden, capCuts' = o.capCuts,
    }
  }

  /// flush(): the inner commits its pending text (forced); the outer asks no rule, holds that unit and
  /// commits everything it holds under force (design 7.1, 13th edition).
  action flush = {
    val start = written.length() - lPending.length()
    val units = if (lPending.length() > 0) [legacyUnit(lPending, start, pendingExtra.map(p => start + p), true)] else []
    val outer = { held: held, nLen: nLen, nBoundaries: nBoundaries, nHidden: nHidden, capCuts: capCuts }
    val o =
      if (mutation == "newGuardOnly") newOnlyCuts(outer, written, true)
      else {
        val everything = { ...outer, held: held.concat(units.foldl([], (l, u) => l.append(arriving(u, written, nLen)))) }
        if (everything.held.length() > 0) commit(everything, written, everything.nLen + heldLength(everything.held), true) else everything
      }
    all {
      written' = written, expectedExtra' = expectedExtra,
      lPending' = [], pendingExtra' = Set(),
      lBoundaries' = lBoundaries.union(unitBoundaries(units)),
      lHidden' = lHidden.union(unionOf(units, u => u.hidden)),
      lDisplayed' = lDisplayed.union(unionOf(units, u => u.displayHidden)),
      held' = o.held, nLen' = o.nLen, nBoundaries' = o.nBoundaries, nHidden' = o.nHidden, capCuts' = o.capCuts,
    }
  }

  val WRITES: Set[List[Sym]] =
    ALPHABET.map(a => [a])
      .union(tuples(ALPHABET, ALPHABET).map(t => [t._1, t._2]))
      .union(tuples(ALPHABET, ALPHABET, ALPHABET).map(t => [t._1, t._2, t._3]))

  action step = {
    nondet kind = 0.to(5).oneOf()
    nondet random = WRITES.oneOf()
    nondet chunk = CHUNKS.oneOf()
    nondet chunk2 = CHUNKS.oneOf()
    nondet chunk3 = CHUNKS.oneOf()
    nondet at = (-1).to(2).oneOf()
    nondet ask = Set(true, false).oneOf()
    // kind 5: one write of three chunks, longer than the cap, so rules 3a and 3b cut inside one write.
    val syms = if (kind <= 1) random else if (kind == 5) chunk.concat(chunk2).concat(chunk3) else chunk
    val extraAt = if (at < syms.length()) at else -1
    if (kind == 0) flush else write(syms, extraAt, ask)
  }

  // ------------------------------------------------------------------------------------------
  // Invariants (design 7.2).

  /// Nothing is lost or repeated, in both layers.
  val conservation =
    nLen + heldLength(held) + lPending.length() == written.length()
      and range(0, held.length()).foldl(nLen, (at, i) => if (at >= 0 and held[i].start == at) held[i].end else -1)
        == written.length() - lPending.length()
  /// The outer hold and the inner pending tail stay within the cap between transitions.
  val boundedPending = written.length() - nLen <= CAP
  /// Every new cut is a previous cut.
  val boundariesSubset = nBoundaries.forall(b => lBoundaries.exists(l => l.at == b.at))
  /// What the previous range path hid per previous unit (s1), the new stream hides once committed.
  val unitHidesLegacy = lHidden.filter(p => p < nLen).subseteq(nHidden)
  /// What the previous trace hid per previous unit (s2), the new stream hides once committed.
  val unitHidesLegacyDisplay = lDisplayed.filter(p => p < nLen).subseteq(nHidden)
  /// What the fourth argument named (s6), the new stream hides once committed.
  val unitHidesExtra = expectedExtra.filter(p => p < nLen).subseteq(nHidden)

  /// Start of the run `at` belongs to: the last forced new cut before it, or 0. A forced cut (the cap,
  /// a forced previous unit, flush) is the code's documented best-effort boundary.
  def runStart(at: int): int =
    nBoundaries.fold(0, (start, b) => if (b.forced and b.at < at and b.at > start) b.at else start)

  def noSplit(legacy: bool, fresh: bool): bool = nBoundaries.forall(b => {
    val start = runStart(b.at)
    b.forced or not(insideSecret(written.slice(start, written.length()), b.at - start, legacy, fresh))
  })
  /// An unforced new cut never separates a key from its value, as the new reading reads them.
  val noSplitNew = noSplit(false, true)
  /// The same for the previous reading.
  val noSplitLegacy = noSplit(true, false)

  /// A cut at the cap falls where the new reading of the held run is closed, unless it is the fallback.
  val capCutsOutsideNewValues = capCuts.forall(c => {
    val start = runStart(c.at)
    c.fallback or not(insideSecret(written.slice(start, written.length()), c.at - start, false, true))
  })

  val unionSafety = capCutsOutsideNewValues and conservation and boundedPending and boundariesSubset and unitHidesLegacy
    and unitHidesLegacyDisplay and unitHidesExtra and noSplitNew and noSplitLegacy
}
