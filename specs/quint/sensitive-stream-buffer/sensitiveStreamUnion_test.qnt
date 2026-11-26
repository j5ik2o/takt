// -*- mode: Bluespec; -*-
// Instances of the second PR's stream model (design 7.2): the design (`unionStream`), and the seven
// deliberately broken streams. Each broken stream has a witness test that ends in a state breaking
// the invariant it must break; `quint run --invariant <name>` finds the same by simulation.
module unionStream {
  import sensitiveStreamUnion(CAP = 8, mutation = "none").* from "./sensitiveStreamUnion"

  /// KN N V N: the previous stream cuts at 2, the new stream holds until 4.
  run newKeyHeldAcrossOldBoundaryTest =
    init.then(write([KN], -1)).then(write([N], -1)).then(write([V], -1)).then(write([N], -1))
      .expect(lBoundaries.contains({ at: 2, forced: false }) and nBoundaries == Set({ at: 4, forced: false })
        and nHidden.contains(2) and unionSafety)

  /// Rule 3b: past the cap, the cut is the last previous boundary (2), not the end of the write.
  run forcedCutAtOldBoundaryTest =
    init.then(write([KN, N], -1)).then(write([P, P, P], -1)).then(write([P, P, P], -1)).then(write([P], -1))
      .expect(nBoundaries == Set({ at: 2, forced: true }) and lBoundaries.contains({ at: 2, forced: false })
        and lPending == [P, P, P, P, P, P, P] and held == [] and unionSafety)

  /// KN G N | V KL V N: per previous unit, the range path reads the KL as a key and hides the V at 5;
  /// read joined, the G before it keeps it from being a key. The saved (s1) keeps 5 hidden.
  run chainKeyHiddenPerOldUnitTest =
    init.then(write([KN, G, N], -1)).then(write([V, KL, V], -1)).then(write([N], -1))
      .expect(lHidden == Set(5) and nBoundaries == Set({ at: 7, forced: false }) and nHidden.contains(5) and unionSafety)

  /// KB V C N: the trace over the previous unit hides the C (s2).
  run displayChainHiddenPerOldUnitTest =
    init.then(write([KB, V, C], -1)).then(write([N], -1))
      .expect(lDisplayed == Set(1, 2) and nHidden.contains(2) and unionSafety)

  /// The fourth argument of the first write names position 0; that unit is held, and the second write commits it.
  run extraRangePreservedAcrossHeldWritesTest =
    init.then(write([KN, N], 0)).then(write([V, N], -1))
      .expect(expectedExtra == Set(0) and nBoundaries == Set({ at: 4, forced: false }) and nHidden.contains(0) and unionSafety)

  /// flush commits the inner tail and the held units, forced.
  run flushCommitsEverythingTest =
    init.then(write([KN, N], -1)).then(write([KB, V], -1)).then(flush)
      .expect(nLen == 4 and held == [] and lPending == [] and nBoundaries == Set({ at: 4, forced: true }) and unionSafety)
}

module cutAtWriteEnd {
  import sensitiveStreamUnion(CAP = 8, mutation = "cutAtWriteEnd").* from "./sensitiveStreamUnion"

  /// The cut at the end of the write (9) splits the previous unit KB V V | V N.
  run cutAtWriteEndWitnessTest =
    init.then(write([KN, N], -1)).then(write([P, N], -1)).then(write([P, N], -1)).then(write([KB, V, V], -1)).then(write([V, N], -1))
      .expect(not(boundariesSubset) and not(unitHidesLegacy))
}

module rereadJoined {
  import sensitiveStreamUnion(CAP = 8, mutation = "rereadJoined").* from "./sensitiveStreamUnion"

  run rereadJoinedWitnessTest =
    init.then(write([KN, G, N], -1)).then(write([V, KL, V], -1)).then(write([N], -1))
      .expect(not(unitHidesLegacy))
}

module noNewGuard {
  import sensitiveStreamUnion(CAP = 8, mutation = "noNewGuard").* from "./sensitiveStreamUnion"

  run noNewGuardWitnessTest =
    init.then(write([KN, N], -1)).then(write([V, N], -1))
      .expect(nBoundaries.contains({ at: 2, forced: false }) and not(noSplitNew))
}

module newGuardOnly {
  import sensitiveStreamUnion(CAP = 8, mutation = "newGuardOnly").* from "./sensitiveStreamUnion"

  run newGuardOnlyWitnessTest =
    init.then(write([KL, N], -1)).then(write([V, N], -1))
      .expect(not(boundariesSubset) and not(noSplitLegacy))
}

module dropHeldHidden {
  import sensitiveStreamUnion(CAP = 8, mutation = "dropHeldHidden").* from "./sensitiveStreamUnion"

  /// Three held units: the middle one's (s1) is lost when only the last unit's is kept.
  run dropHeldHiddenWitnessTest =
    init.then(write([KN, G, N], -1)).then(write([V, KL, V, KN, N], -1)).then(write([V, N], -1))
      .expect(lHidden.contains(5) and not(unitHidesLegacy))
}

module dropDisplayTrace {
  import sensitiveStreamUnion(CAP = 8, mutation = "dropDisplayTrace").* from "./sensitiveStreamUnion"

  run dropDisplayTraceWitnessTest =
    init.then(write([KB, V, C], -1)).then(write([N], -1))
      .expect(not(unitHidesLegacyDisplay))
}

module dropEarlierExtra {
  import sensitiveStreamUnion(CAP = 8, mutation = "dropEarlierExtra").* from "./sensitiveStreamUnion"

  run dropEarlierExtraWitnessTest =
    init.then(write([KN, N], 0)).then(write([V, N], -1))
      .expect(not(unitHidesExtra))
}
