# Faceted Prompting: AIプロンプトへの関心の分離

## 問題

マルチエージェントシステムが複雑になるにつれ、プロンプトはモノリシックになる。1つのプロンプトファイルにエージェントの役割、行動規範、タスク固有の指示、ドメイン知識、出力形式がすべて混在する。これは3つの問題を生む。

1. **再利用できない** — 2つのステップが同じレビュアーのペルソナを必要としつつ指示が異なる場合、プロンプト全体を複製するしかない
2. **暗黙的な結合** — コーディング規約を変更すると、それを参照するすべてのプロンプトを編集する必要がある
3. **責任の不明確さ** — プロンプトのどの部分がエージェントの「役割」を定義し、どの部分が「やるべきこと」を定義しているのか区別がつかない

## アイデア

ソフトウェア工学の基本原則である**関心の分離（Separation of Concerns）**をプロンプト設計に適用する。

エージェントごとに1つのモノリシックなプロンプトを書く代わりに、「何の関心を扱っているか」で独立した再利用可能なファイルに分解する。そしてワークフローのステップごとに宣言的に合成する。

## 5つの関心

Faceted Promptingはプロンプトを5つの直交する関心に分解する。

| 関心 | 答える問い | 例 |
|------|-----------|-----|
| **Persona** | エージェントは*誰*か？ | 役割定義、専門性、判断基準 |
| **Stance** | *どう*振る舞うべきか？ | コーディング規約、レビュー基準、行動規範 |
| **Instruction** | *何を*すべきか？ | ステップ固有の手順、変数付きテンプレート |
| **Knowledge** | *何を*知っているか？ | アーキテクチャ文書、API仕様、例示、参照資料 |
| **Report Format** | *何を*出力すべきか？ | 出力構造、レポートテンプレート |

各関心はそれぞれのディレクトリに独立したファイル（Markdownまたはテンプレート）として格納される。

```
workflows/       # ワークフロー定義
personas/        # WHO — 役割定義
stances/         # HOW — 行動規範
instructions/    # WHAT — ステップ手順
knowledge/       # CONTEXT — ドメイン情報
report-formats/  # OUTPUT — レポートテンプレート
```

### なぜこの5つか？

**Persona** と **Instruction** は最低限必要なもの — エージェントが誰で、何をすべきかを定義する必要がある。しかし実際には、さらに3つの関心が独立した軸として現れる。

- **Stance** はタスクをまたがって適用される行動規範を捉える。「コーディングスタンス」（命名規則、エラーハンドリングのルール、テスト要件）は、機能実装でもバグ修正でも同じように適用される。スタンスは「横断的関心事」であり、作業内容に関係なく作業の*やり方*を規定する。

- **Knowledge** は複数のエージェントが必要とするドメイン知識を捉える。アーキテクチャ文書はプランナーにもレビュアーにも関係がある。ナレッジをインストラクションから分離することで重複を防ぎ、インストラクションを手順に集中させる。

- **Report Format** は作業そのものとは独立した出力構造を捉える。同じレビューフォーマットをアーキテクチャレビュアーとセキュリティレビュアーの両方で使える。出力形式の変更がエージェントの振る舞いに影響しない。

## 宣言的な合成

Faceted Promptingの中核メカニズムは**宣言的な合成**である。ワークフロー定義が各ステップでプロンプトの内容を直接埋め込むのではなく、*どの*関心を組み合わせるかを宣言する。

主要な特性は次の通り。

- **各ファイルは1つの関心だけを持つ。** ペルソナファイルには役割と専門性のみを記述し、ステップ固有の手順は書かない。
- **合成は宣言的。** ワークフローは*どの*関心を組み合わせるかを記述し、プロンプトを*どう*組み立てるかは記述しない。
- **自由に組み合わせ可能。** 同じ `coder` ペルソナを異なるスタンスとインストラクションで異なるステップに使える。
- **ファイルが再利用の単位。** 同じファイルを指すことでスタンスをワークフロー間で共有する。

### TAKTでの実装例

[TAKT](https://github.com/nrslib/takt) はFaceted PromptingをYAMLベースのワークフロー定義（「ピース」と呼ぶ）で実装している。各関心はセクションマップで短いキーにマッピングされ、各ステップ（TAKTでは「ムーブメント」と呼ぶ）からキーで参照される。

```yaml
name: my-workflow
max_iterations: 10
initial_movement: plan

# セクションマップ — キー: ファイルパス（このYAMLからの相対パス）
personas:
  coder: ../personas/coder.md
  reviewer: ../personas/architecture-reviewer.md

stances:
  coding: ../stances/coding.md
  review: ../stances/review.md

instructions:
  plan: ../instructions/plan.md
  implement: ../instructions/implement.md

knowledge:
  architecture: ../knowledge/architecture.md

report_formats:
  review: ../report-formats/review.md

movements:
  - name: implement
    persona: coder            # WHO — personas.coder を参照
    stance: coding            # HOW — stances.coding を参照
    instruction: implement    # WHAT — instructions.implement を参照
    knowledge: architecture   # CONTEXT — knowledge.architecture を参照
    edit: true
    rules:
      - condition: Implementation complete
        next: review

  - name: review
    persona: reviewer         # 異なる WHO
    stance: review            # 異なる HOW
    instruction: review       # 異なる WHAT（共有も可能）
    knowledge: architecture   # 同じ CONTEXT — 再利用
    report:
      name: review.md
      format: review          # OUTPUT — report_formats.review を参照
    edit: false
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
```

エンジンは各キーをファイルに解決し、内容を読み込み、実行時に最終的なプロンプトを組み立てる。ワークフローの作者がモノリシックなプロンプトを書くことはない — どのファセットを組み合わせるかを選択するだけである。

## 既存手法との違い

| 手法 | 内容 | 本手法との違い |
|------|------|--------------|
| **Decomposed Prompting** (Khot et al.) | *タスク*をサブタスクに分解して異なるLLMに委任 | 分解するのはタスクではなく*プロンプトの構造* |
| **Modular Prompting** | XML/HTMLタグを使った単一プロンプト内のセクション分け | 関心を*独立ファイル*に分離し、宣言的に合成する |
| **Prompt Layering** (Airia) | エンタープライズ向けのスタック可能なプロンプトセグメント | 管理ツールであり、プロンプト設計のデザインパターンではない |
| **PDL** (IBM) | データパイプライン向けのYAMLベースプロンプトプログラミング言語 | 制御フロー（if/for/model呼び出し）が焦点で、関心の分離ではない |
| **Role/Persona Prompting** | 役割を割り当ててレスポンスを方向付ける | ペルソナは5つの関心の1つにすぎない — スタンス、インストラクション、ナレッジ、出力形式も分離する |

核心的な違いは次の点にある。既存手法は*タスク*（何をするか）を分解するか、*プロンプトの構造*（どう書式化するか）を整理する。Faceted Promptingは*プロンプトの関心*（各部分がなぜ存在するか）を独立した再利用可能な単位に分解する。

## 実用上の利点

**ワークフロー作者にとって:**
- コーディング規約を1つのスタンスファイルで変更すれば、それを使うすべてのワークフローに反映される
- 既存のペルソナ、スタンス、インストラクションを組み合わせて新しいワークフローを作れる
- 各ファイルを単一の責務に集中させられる

**チームにとって:**
- プロンプトを複製せずにプロジェクト間で振る舞い（スタンス）を標準化できる
- ドメイン専門家がナレッジファイルを管理し、ワークフロー設計者がインストラクションを管理する分業ができる
- 個々の関心を独立してレビューできる

**エンジンにとって:**
- プロンプト組み立ては決定的 — 同じワークフロー定義とファイルからは同じプロンプトが構築される
- スタンスの配置を最適化できる（例: 「Lost in the Middle」効果に対抗するためプロンプトの先頭と末尾に配置）
- 各関心を他の部分に影響を与えずにステップごとに注入・省略・上書きできる

## まとめ

Faceted Promptingは、関心の分離（Separation of Concerns）をAIプロンプト工学に適用するデザインパターンである。プロンプトを5つの独立した関心 — Persona、Stance、Instruction、Knowledge、Report Format — に分解し、宣言的に合成することで、再利用可能で保守しやすく透明なマルチエージェントワークフローを実現する。
