// -*- mode: Bluespec; -*-
// Commit boundaries of the sensitive text stream buffer (j5ik2o/takt#151, design sections 7 and 11).
//
// Source of the model:
//   src/shared/utils/sensitive-stream.ts  SensitiveTextStreamBuffer.write / flush / take,
//                                         pendingSensitiveValueRanges (the hold-back guard)
//   src/shared/utils/sensitive-text.ts    sensitiveTextRanges (what the guard asks)
//
// The text is a list of symbols:
//   P  plain character
//   KB key both implementations read (e.g. `token:`)
//   KL key only the frozen previous implementation reads (its sequential order chains a pattern)
//   KN key only the new pattern pass reads (restart inside a value)
//   V  value character
//   N  newline
// A key opens a value. A newline before the first value character does not close it
// (`token:\nsecret`: `\s*` crosses the newline); a newline after a value character does.
// `withLegacyGuard` and `withNewGuard` select the readers the hold-back guard asks:
//   both true          = new pass ∪ frozen previous (the second PR's stream)
//   only withNewGuard  = new pass only (#165's stream)
//   only withLegacyGuard = frozen previous only (337062193's stream, and the first PR's stream)
module sensitiveStreamBuffer {
  type Sym = P | KB | KL | KN | V | N

  const withLegacyGuard: bool
  const withNewGuard: bool
  const CAP: int          // MAX_PENDING_SENSITIVE_LINE_LENGTH, scaled down
  val ALPHABET = Set(P, KB, KL, KN, V, N)

  var written: List[Sym]
  var pending: List[Sym]
  var committed: List[Sym]
  /// Positions in `written` where a unit ended, and whether the length cap forced it.
  var boundaries: Set[{ at: int, forced: bool }]

  pure def readsKey(sym: Sym, withLegacy: bool, withNew: bool): bool = match sym {
    | KB => true
    | KL => withLegacy
    | KN => withNew
    | _ => false
  }

  /// Value state after reading `text`: 0 = outside, 1 = key read, no value char yet, 2 = inside a value.
  pure def valueState(text: List[Sym], withLegacy: bool, withNew: bool): int =
    text.foldl(0, (state, sym) =>
      if (readsKey(sym, withLegacy, withNew)) 1
      else match sym {
        | V => if (state >= 1) 2 else 0
        | N => if (state == 2) 0 else state
        | _ => if (state == 2) 0 else state
      })

  /// The guard: the text ends inside a value that the next character could continue.
  pure def open(text: List[Sym], u: bool): bool = valueState(text, u, withNewGuard) != 0

  /// Positions strictly inside a secret range (after a key, up to the end of its value),
  /// as one reader sees the whole text: a boundary there splits the key from its value.
  pure def insideSecret(text: List[Sym], at: int, withLegacy: bool, withNew: bool): bool =
    at > 0 and at < text.length() and valueState(text.slice(0, at), withLegacy, withNew) != 0
      and (valueState(text.slice(0, at + 1), withLegacy, withNew) == 2)

  /// Index after the first newline whose prefix is not open, or -1.
  pure def firstClosedLine(text: List[Sym], u: bool): int =
    text.indices().fold(-1, (found, i) =>
      if (found >= 0) found
      else if (text[i] == N and not(open(text.slice(0, i + 1), u))) i + 1
      else -1)

  action init = all {
    written' = [], pending' = [], committed' = [], boundaries' = Set(),
  }

  /// write(): append one symbol, then commit every closed line, or all of it past the cap.
  action write(sym: Sym): bool = {
    val grown = pending.append(sym)
    val cut = firstClosedLine(grown, withLegacyGuard)
    all {
      written' = written.append(sym),
      if (cut >= 0) all {
        committed' = committed.concat(grown.slice(0, cut)),
        pending' = grown.slice(cut, grown.length()),
        boundaries' = boundaries.union(Set({ at: committed.length() + cut, forced: false })),
      } else if (grown.length() > CAP) all {
        committed' = committed.concat(grown),
        pending' = [],
        boundaries' = boundaries.union(Set({ at: committed.length() + grown.length(), forced: true })),
      } else all {
        committed' = committed, pending' = grown, boundaries' = boundaries,
      },
    }
  }

  action flush = all {
    pending.length() > 0,
    committed' = committed.concat(pending),
    pending' = [],
    written' = written,
    boundaries' = boundaries.union(Set({ at: written.length(), forced: true })),
  }

  action step = any {
    nondet sym = ALPHABET.oneOf()
    write(sym),
    flush,
  }

  /// Nothing is lost or repeated.
  val conservation = committed.concat(pending) == written
  /// The pending tail stays bounded (a write adds one symbol).
  val boundedPending = pending.length() <= CAP
  /// Start of the unit run that `at` belongs to: the last forced boundary before it, or 0.
  /// A forced boundary (the length cap, or flush) is the code's documented best-effort cut;
  /// what follows it is read without the text before it.
  def runStart(at: int): int =
    boundaries.fold(0, (start, b) => if (b.forced and b.at < at and b.at > start) b.at else start)

  def noSplit(withLegacy: bool, withNew: bool): bool = boundaries.forall(b => {
    val start = runStart(b.at)
    b.forced or not(insideSecret(written.slice(start, written.length()), b.at - start, withLegacy, withNew))
  })
  /// An unforced boundary never separates a key from its value, as the new pass reads it.
  val noSplitNew = noSplit(false, true)
  /// The same for the frozen previous reading: this is what the union buys the stream.
  val noSplitLegacy = noSplit(true, false)
  val safety = conservation and boundedPending and noSplitNew and noSplitLegacy
  /// What the frozen previous stream promises: its own reading is never split.
  val legacySafety = conservation and boundedPending and noSplitLegacy
}
