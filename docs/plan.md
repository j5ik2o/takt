- perform_phase1_message.md
  - ここから status Rule を排除する（phase3に書けばいい）
- perform_phase2_message.md
  - 「上記のReport Directory内のファイルのみ使用してください。** 他のレポートディレクトリは検索/参照しないでください。」は上記ってのがいらないのではないか
  - 「**このフェーズではツールは使えません。レポート内容をテキストとして直接回答してください。**」が重複することがあるので削除せよ。
  - JSON形式について触れる必要はない。
- perform_phase3_message.md
  - status Rule を追加する聞く
- perform_agent_system_prompt.md
  - これ、エージェントのデータを挿入してないの……？
- 全体的に
  - 音楽にひもづける
    - つまり、workflowsをやめて pieces にする
    - 現workflowファイルにあるstepsもmovementsにする（全ファイルの修正）
    - stepという言葉はmovementになる。phaseもmovementが適しているだろう（これは interactive における phase のことをいっていない）
  - _language パラメータは消せ
  - ワークフローを指定すると実際に送られるプロンプトを組み立てて表示する機能かツールを作れるか
  - メタ領域を用意して説明、どこで利用されるかの説明、使えるテンプレートとその説明をかいて、その他必要な情報あれば入れて。
  - 英語と日本語が共通でもかならずファイルはわけて同じ文章を書いておく
  - 無駄な空行とか消してほしい
    ```
    {{#if hasPreviousResponse}}
  
    ## Previous Response
    {{previousResponse}}
    {{/if}}
    {{#if hasUserInputs}}
  
    ## Additional User Inputs
    {{userInputs}}
    ```
    これは↓のがいいんじゃない？
    ```
    {{#if hasPreviousResponse}}
    ## Previous Response
    {{previousResponse}}
    {{/if}}
  
    {{#if hasUserInputs}}
    ## Additional User Inputs
    {{userInputs}}
    ```