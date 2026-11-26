# 秘密の伏せの「固めた写し」と和集合（#151）

秘密の伏せ（`src/shared/utils/sensitive-text.ts` ほか）は、どの経路でも「新しい読み ∪ 変更前（337062193）が伏せた範囲」を伏せる。変更前より漏らさないことを、除外なしで守るためである。この文書は、変更前の実装を本体に置いた「固めた写し」の置き場所と、直してよい場合の決まりを書く。

## 置き場所

| ファイル | 中身 | 固定 |
|---|---|---|
| `src/shared/utils/sensitive-text-legacy.ts` | 337062193 の `sensitive-text.ts`。足したのは `export` と、curl の3つの正規表現と同じ一致を線形に返す読み取り（`curlUserMatches`）だけ | する |
| `src/shared/utils/sensitive-text-legacy-trace.ts` | なぞり。変更前の `sanitizeSensitiveText` の14段を、同じ順・同じ置き換えの文字列で当て、元の文字列の上の範囲と最後の表示の文字列を返す | しない |
| `src/__tests__/helpers/legacy-sensitive-text.ts`、`legacy-sensitive-value.ts`、`legacy-sensitive-stream.ts` | 337062193 の3ファイルそのもの（import 先だけテストの写しへ） | する |
| `src/__tests__/helpers/legacy-phase1-execution-log.ts` | 337062193 の `phase1-execution-log.ts`（import 先だけテストの写しへ） | する |

「固定する」ファイルは、`src/__tests__/sensitive-text-legacy.hash.test.ts` が SHA-256（改行を `\n` にそろえたもの）で固定し、`.gitattributes` で `eol=lf` にしている。

## 和集合の経路

| 経路 | 伏せる範囲 |
|---|---|
| 表示 `sanitizeSensitiveText` | (a) 新しい読み、(b) なぞり、(c) 写しの範囲の経路 |
| 範囲 `sensitiveTextRanges` | (a)＋(b)＋(c)＋既知の値の出現（値は `all`） |
| 後の出力 `sanitizeTextWithValues` | 範囲の経路＋(d) 変更前の合成（`legacy` の既知の値を伏せてから、なぞりを当てる） |
| phase1 の記録 | 範囲の経路（値は `all`）＋(e) 変更前の phase1 の合成（変更前の伏せを組み直し、断片ごとになぞりを当てる） |

追跡する値は2本で持つ（`BoundedSensitiveValues`）。`legacy` は変更前の実装が同じ呼び出しで集めたはずの値で、変更前と同じ上限・順番・数えを持つ。`all` は `legacy` と新しい読みが集めた値の和集合である。

## 直してよい場合

- 写しの正規表現と処理は直さない。変更前に漏れ、伏せすぎ、遅さがあっても、直すのは新しい側（`sensitive-text.ts`）である。
- なぞりは写しではないので、誤りは普通の修正として直してよい。正しさは性質 F2・F3（写しの表示・合成と文字列で一致）で守る。
- 写しを直してよいのは次のときだけで、どれも設計の独立レビューと元帥の承認を通す。
  1. 性能：ある形で2乗以上になると測定で分かったとき。同じ範囲を返す線形の読み取りに差し替え、性質 F1 で同じことを確かめる。
  2. 言語・型の都合：意味を変えない書き換え（`export`、型注釈、import の形）。
  3. 和集合をやめるとき：「変更前より漏らさない」の保証をやめるとオーナーが決めたときだけ、写しを消してよい。
- 上流（nrslib/takt）が `src/shared/utils/sensitive*` に触れたら、取り込みの PR で、(i) その版を2つ目の基準として足すか、(ii) 写しをその版に差し替えるかを、設計の独立レビューで決める。どちらも選ばずに取り込まない。
- 写しの値を変えるコミットは、上の 1〜3（または (i)・(ii)）のどれかと、設計レビューの報告の場所を本文に書く。
