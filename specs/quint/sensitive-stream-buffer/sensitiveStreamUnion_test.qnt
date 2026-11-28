// -*- mode: Bluespec; -*-
// Instances of the second PR's stream model (design 7.2): the design (`unionStream`), and the eight
// deliberately broken streams. Each broken stream has a witness test that ends in a state breaking
// the invariant it must break; `quint run --invariant <name>` finds the same by simulation.
module unionStream {
  import sensitiveStreamUnion(CAP = 8, mutation = "none").* from "./sensitiveStreamUnion"

  /// KN N V N: the previous stream cuts at 2, the new stream holds until 4.
  run newKeyHeldAcrossOldBoundaryTest =
    init.then(write([KN], -1, true)).then(write([N], -1, true)).then(write([V], -1, true)).then(write([N], -1, true))
      .expect(lBoundaries.contains({ at: 2, forced: false }) and nBoundaries == Set({ at: 4, forced: false })
        and nHidden.contains(2) and unionSafety)

  /// Rule 3b: past the cap, the cut is the last previous boundary (2), not the end of the write.
  run forcedCutAtOldBoundaryTest =
    init.then(write([KN, N], -1, true)).then(write([P, P, P], -1, true)).then(write([P, P, P], -1, true)).then(write([P], -1, true))
      .expect(nBoundaries == Set({ at: 2, forced: true }) and lBoundaries.contains({ at: 2, forced: false })
        and lPending == [P, P, P, P, P, P, P] and held == [] and unionSafety)

  /// KN G N | V KL V N: per previous unit, the range path reads the KL as a key and hides the V at 5;
  /// read joined, the G before it keeps it from being a key. The saved (s1) keeps 5 hidden.
  run chainKeyHiddenPerOldUnitTest =
    init.then(write([KN, G, N], -1, true)).then(write([V, KL, V], -1, true)).then(write([N], -1, true))
      .expect(lHidden == Set(5) and nBoundaries == Set({ at: 7, forced: false }) and nHidden.contains(5) and unionSafety)

  /// KB V C N: the trace over the previous unit hides the C (s2).
  run displayChainHiddenPerOldUnitTest =
    init.then(write([KB, V, C], -1, true)).then(write([N], -1, true))
      .expect(lDisplayed == Set(1, 2) and nHidden.contains(2) and unionSafety)

  /// The fourth argument of the first write names position 0; that unit is held, and the second write commits it.
  run extraRangePreservedAcrossHeldWritesTest =
    init.then(write([KN, N], 0, true)).then(write([V, N], -1, true))
      .expect(expectedExtra == Set(0) and nBoundaries == Set({ at: 4, forced: false }) and nHidden.contains(0) and unionSafety)

  /// Rule 2 is asked at the last unit of a write: V N closes the new value, but the same write's KN N
  /// opens another, so the whole run stays held (no cut inside the write, design 7.1, 12th edition).
  run ruleTwoAtTheEndOfAWriteTest =
    init.then(write([KN, N], -1, true)).then(write([V, N, KN, N], -1, true))
      .expect(nBoundaries == Set() and held.length() == 3 and lBoundaries.contains({ at: 4, forced: false }) and unionSafety)

  /// Rules 3a/3b at the cap (13th edition, R12-1): one write of four plain lines and a line only the new
  /// reading keeps open goes past the cap; the cut falls at 8, the last boundary where the new reading is
  /// closed, not at 10 inside the open value, and the V that closes it is hidden.
  run capCutAtClosedBoundaryTest =
    init.then(write([P, N, P, N, P, N, P, N, KN, N, V, N], -1, true))
      .expect(nBoundaries == Set({ at: 8, forced: false }, { at: 12, forced: false })
        and capCuts == Set({ at: 8, fallback: false }) and nHidden.contains(10) and unionSafety)

  /// The same write when rule 2 is not asked (the held run did not double): the open value stays held.
  run capCutWithoutRuleTwoTest =
    init.then(write([P, N, P, N, P, N, P, N, KN, N, V, N], -1, false))
      .expect(nBoundaries == Set({ at: 8, forced: false }) and held.length() == 2 and unionSafety)

  /// An open new value longer than the cap: the fallback cuts under force (the named known behavior).
  run capCutFallbackTest =
    init.then(write([KN, N, P, N, P, N, P, N, P, N], -1, true))
      .expect(capCuts.exists(c => c.fallback) and unionSafety)

  /// flush commits the inner tail and the held units, forced.
  run flushCommitsEverythingTest =
    init.then(write([KN, N], -1, true)).then(write([KB, V], -1, true)).then(flush)
      .expect(nLen == 4 and held == [] and lPending == [] and nBoundaries == Set({ at: 4, forced: true }) and unionSafety)
}

module cutAtWriteEnd {
  import sensitiveStreamUnion(CAP = 8, mutation = "cutAtWriteEnd").* from "./sensitiveStreamUnion"

  /// The cut at the end of the write (9) splits the previous unit KB V V | V N.
  run cutAtWriteEndWitnessTest =
    init.then(write([KN, N], -1, true)).then(write([P, N], -1, true)).then(write([P, N], -1, true)).then(write([KB, V, V], -1, true)).then(write([V, N], -1, true))
      .expect(not(boundariesSubset) and not(unitHidesLegacy))
}

module rereadJoined {
  import sensitiveStreamUnion(CAP = 8, mutation = "rereadJoined").* from "./sensitiveStreamUnion"

  run rereadJoinedWitnessTest =
    init.then(write([KN, G, N], -1, true)).then(write([V, KL, V], -1, true)).then(write([N], -1, true))
      .expect(not(unitHidesLegacy))
}

module noNewGuard {
  import sensitiveStreamUnion(CAP = 8, mutation = "noNewGuard").* from "./sensitiveStreamUnion"

  run noNewGuardWitnessTest =
    init.then(write([KN, N], -1, true)).then(write([V, N], -1, true))
      .expect(nBoundaries.contains({ at: 2, forced: false }) and not(noSplitNew))
}

module newGuardOnly {
  import sensitiveStreamUnion(CAP = 8, mutation = "newGuardOnly").* from "./sensitiveStreamUnion"

  run newGuardOnlyWitnessTest =
    init.then(write([KL, N], -1, true)).then(write([V, N], -1, true))
      .expect(not(boundariesSubset) and not(noSplitLegacy))
}

module dropHeldHidden {
  import sensitiveStreamUnion(CAP = 8, mutation = "dropHeldHidden").* from "./sensitiveStreamUnion"

  /// Three held units: the middle one's (s1) is lost when only the last unit's is kept.
  run dropHeldHiddenWitnessTest =
    init.then(write([KN, G, N], -1, true)).then(write([V, KL, V, KN, N], -1, true)).then(write([V, N], -1, true))
      .expect(lHidden.contains(5) and not(unitHidesLegacy))
}

module dropDisplayTrace {
  import sensitiveStreamUnion(CAP = 8, mutation = "dropDisplayTrace").* from "./sensitiveStreamUnion"

  run dropDisplayTraceWitnessTest =
    init.then(write([KB, V, C], -1, true)).then(write([N], -1, true))
      .expect(not(unitHidesLegacyDisplay))
}

module dropEarlierExtra {
  import sensitiveStreamUnion(CAP = 8, mutation = "dropEarlierExtra").* from "./sensitiveStreamUnion"

  run dropEarlierExtraWitnessTest =
    init.then(write([KN, N], 0, true)).then(write([V, N], -1, true))
      .expect(not(unitHidesExtra))
}

module capCutAtHeldEnd {
  import sensitiveStreamUnion(CAP = 8, mutation = "capCutAtHeldEnd").* from "./sensitiveStreamUnion"

  /// The 12th edition's cut: at the cap, the whole held run, through the open new value (R12-1).
  run capCutAtHeldEndWitnessTest =
    init.then(write([P, N, P, N, P, N, P, N, KN, N, V, N], -1, true))
      .expect(not(capCutsOutsideNewValues))
}

module unionStreamSmallCap {
  import sensitiveStreamUnion(CAP = 4, mutation = "none").* from "./sensitiveStreamUnion"

  run smallCapLongWriteTest =
    init.then(write([P, N, P, N, KN, N, V, N], -1, true))
      .expect(capCuts == Set({ at: 4, fallback: false }) and nHidden.contains(6) and unionSafety)
}
