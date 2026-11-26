// -*- mode: Bluespec; -*-
// Instances of the stream buffer model: the union guard (second PR), #165's guard (new pass only),
// and the frozen previous guard (337062193 and the first PR).
module unionGuard {
  import sensitiveStreamBuffer(withLegacyGuard = true, withNewGuard = true, CAP = 4).* from "./sensitiveStreamBuffer"

  /// A legacy-only key followed by a newline is held back until its value arrives.
  run legacyKeyHeldAcrossNewlineTest =
    init.then(write(KL)).then(write(N)).then(write(V)).then(write(N))
      .expect(boundaries == Set({ at: 4, forced: false }) and pending == [])
}

module newOnlyGuard {
  import sensitiveStreamBuffer(withLegacyGuard = false, withNewGuard = true, CAP = 4).* from "./sensitiveStreamBuffer"

  /// Without the frozen previous reading, the same input is cut between the key and its value.
  run legacyKeySplitTest =
    init.then(write(KL)).then(write(N)).then(write(V)).then(write(N))
      .expect(boundaries.contains({ at: 2, forced: false }) and not(noSplitLegacy))
}

module legacyOnlyGuard {
  import sensitiveStreamBuffer(withLegacyGuard = true, withNewGuard = false, CAP = 4).* from "./sensitiveStreamBuffer"

  /// The first PR's stream is the previous stream: a legacy key is held back across a newline.
  run legacyKeyHeldAcrossNewlineTest =
    init.then(write(KL)).then(write(N)).then(write(V)).then(write(N))
      .expect(boundaries == Set({ at: 4, forced: false }) and pending == [])

  /// It does not read the new pass's keys, so it may cut after one of them (the second PR fixes this).
  run newKeySplitTest =
    init.then(write(KN)).then(write(N)).then(write(V)).then(write(N))
      .expect(boundaries.contains({ at: 2, forced: false }) and not(noSplitNew))
}
