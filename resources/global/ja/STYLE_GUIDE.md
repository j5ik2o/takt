# スタイルガイド

プロンプトアーキテクチャの各レイヤーごとにスタイルガイドを用意している。

| レイヤー | ガイド | 配置先 |
|---------|--------|--------|
| ペルソナ | [PERSONA_STYLE_GUIDE.md](PERSONA_STYLE_GUIDE.md) | system prompt（`{{agentDefinition}}`） |
| スタンス | [STANCE_STYLE_GUIDE.md](STANCE_STYLE_GUIDE.md) | user message（instruction 内） |
| インストラクション | [INSTRUCTION_STYLE_GUIDE.md](INSTRUCTION_STYLE_GUIDE.md) | Phase 1 メッセージ（`{{instructions}}`） |
| レポートフォーマット | [REPORT_STYLE_GUIDE.md](REPORT_STYLE_GUIDE.md) | `report.format` |

## テンプレート

`templates/` にテンプレートファイルを用意している。新規作成時はコピーまたは参照して使う。

```
templates/
├── personas/          # ペルソナテンプレート
│   ├── simple.md      # ドメイン知識なし
│   ├── expert.md      # ドメイン知識あり
│   └── character.md   # キャラクター型
├── stances/           # スタンステンプレート
│   └── stance.md
├── instructions/      # インストラクションテンプレート
│   ├── plan.md
│   ├── architect.md
│   ├── implement.md
│   ├── review.md
│   ├── ai-review-standalone.md
│   ├── ai-fix.md
│   ├── fix.md
│   ├── arbitrate.md
│   └── supervise.md
└── reports/           # レポートフォーマットテンプレート
    ├── plan.md
    ├── architecture-design.md
    ├── review.md
    ├── security-review.md
    ├── validation.md
    └── summary.md
```

## 3層プロンプトアーキテクチャ

```
System Prompt:
  [TAKT コンテキスト]
  [ペルソナ]              ← エージェントの identity・専門知識

User Message (Phase 1):
  [実行コンテキスト]
  [Piece Context]
  [User Request]
  [Previous Response]
  [Instructions]          ← ムーブメント固有の手順
    └── [スタンス]        ← 共有行動規範（instruction 内に含まれる）
```

## 分離の判断フロー

```
この内容は…
├── 特定のエージェントだけが必要 → ペルソナ
├── 複数のエージェントが共有 → スタンス
├── ムーブメント固有の手順 → インストラクション
└── エージェント出力の構造定義 → レポートフォーマット
```
