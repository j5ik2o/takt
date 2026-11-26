# PR #163 の追いの直し：出来上がった時点の設計

対象：https://github.com/j5ik2o/takt/pull/163 （枝 j5ik2o/takt-331-finish-hook-version）。副元帥側の独立レビューで出た中 1・中 2・低 1・低 2 を直す。上流 nrslib/takt の main には `scripts/check-takt-runtime.sh` も `configValidation.ts` も無く、同じ直しの開いた PR も無い（2026-11-26 に確認）。

## 変えたこと

1. `scripts/check-takt-runtime.sh`（中 1）
   - `--key` の値を、空白ではなく改行で区切って持つ。ループは `for key in $keys` から、ヒアドキュメントを読む `while IFS= read -r key` に変えた。値は単語に割れず、glob にも展開されない。
   - 照合は `grep -Fqx -- "$key"`。正規表現として読まない（`-F`）、行全体で一致（`-x`）、`-v` のような値をオプションとして読まない（`--`）。
   - 変えていないこと：ok/NG の文言、終了コード（0/1/2）、既定のキー `task_finish_hook`、ほかの確認。
2. `src/__tests__/it-check-takt-runtime.test.ts`（中 1・中 2）
   - `--key 'task_.*'` と `--key '*'` が NG・終了コード 1 になる。`*` の場合は、cwd に `task_finish_hook` という名前のファイルを置いて、glob に展開されないことを見る。
   - `--contains`：一時の git リポジトリに、祖先・配置したコミット・別の根の枝のコミットを作る。祖先なら ok・0、祖先でなければ NG・1 になる。
3. `src/__tests__/globalConfig.test.ts`（低 1・低 2）
   - 低 1（M2）：レビューでは「raw の2つ目の検査はファイル由来のキーでは届かない」とされ、消す案もあった。調べると、根の JSON の環境変数（例 `TAKT_OBSERVABILITY='{"future_only_key":true}'`）で、知らないキーが raw にだけ入る。そのときは2つ目の検査が版つきの文で止める。消すと、後ろの `GlobalConfigSchema.parse` が ZodError の JSON で止めるので、拒否は変わらないが文が変わる。そこで検査は消さず、この場面のテストを足した。
   - 低 2（M7d）：型の違う値（`language: 123`）と知らないキーを両方含む global の config で、エラーが知らないキーと版を名乗ることを固定した。
   - 実装のコード（`configValidation.ts`、`globalConfigCore.ts`）は変えていない。

範囲の外：低 3（global の型エラーが ZodError の JSON のまま）、低 4（node の stderr を捨てる）、低 5（版の表記）。

## 守る不変条件

- `--key K` が ok になるのは、ProjectConfigSchema のキーの一覧に K と全く同じ行があるときだけ。K の中の `.` `*` `[` `-` は文字そのものとして扱う。
- 祖先でない `--contains` は、必ず NG・終了コード 1。
- config の読み込みで、受け付ける入力と拒否する入力は変わらない（実装を変えていないため）。知らないキーは、ファイル由来でも環境変数由来でも、版つきの文で止まる。

## PBT の性質と除外

PBT は付けない。スクリプトの照合は固定文字列の行一致で、正規表現・glob・オプションに当たる代表の入力を例のテストで押さえた。テストはシェルの子プロセスを起動するので、乱数の入力を大量に流すと重い。TS で性質を書き直すと、確かめる対象がシェルでなくなる。config 側は実装を変えていないので、既存の例のテストと変異で守る。

## 変異で確かめたこと

| # | 壊した所 | 結果 |
|---|---|---|
| M14 | `--contains` の不合格を ok にする | `fails when the deployed commit does not contain the commit` が落ちる |
| M2 | global の raw の検査を消す | `... unknown key from a root JSON env override` が落ちる |
| M7d | `onlyUnrecognizedKeys` の絞り込みを外す | `should name the unknown key, not a type error, when the file has both` が落ちる（文が `invalid language ...` になる） |

どの変異も試した後で元に戻した。

## 壊しうる入力（手で確かめたもの、macOS の `/bin/sh` と `/bin/dash`）

| `--key` の値 | 結果 |
|---|---|
| なし（既定） | ok・0 |
| `language` と `task_finish_hook` の2つ | 両方 ok・0 |
| `-v`、`--` | NG・1（grep のオプションにならない） |
| `task.finish_hook`、`task_.*` | NG・1（正規表現にならない） |
| `*` | NG・1（glob に展開されない） |
| `a b`（空白を含む） | 1つのキーとして NG・1（以前は2つに割れていた） |

改行を含む値は2行に割れるが、各行を固定文字列で照合するので、偽の合格にはならない。空行は飛ばす。

## 影響

- 上流：なし（フォークだけのファイル）。
- 保存済みのデータ：なし。
- 公開の設定：受け付けるキー・拒否するキー、エラー文は変わらない。
- 守りの仕組み：確認スクリプトの偽の合格が無くなる（強くなる方向）。テストの分類は変えていない。
- 状態遷移ではないので Quint は使わない。
