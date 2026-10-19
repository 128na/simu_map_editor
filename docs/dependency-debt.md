# dependency-debt

上げられない依存関係の台帳。「未マージPR数」ではなくこの表を棚卸し・監査の対象にする。
`/dependabot-maintenance` スキルがこのファイルを参照・更新する（スキーマ変更禁止）。

| Package | Current | Target | Blocker | Type | Revisit condition | Recorded |
| ------- | ------- | ------ | ------- | ---- | ----------------- | -------- |

<!--
運用メモ:
- Type: temporary（上流未対応など一時的ブロック。PRは寝かせる） / infra（インフラ・環境都合。PRはClose + dependabot.ymlにignore追加） / behavior-change（挙動変更を伴い検証が必要）
- Revisit condition: 「上流のissue #NNN が閉じたら」「PHP 8.5 移行後」など、再挑戦の条件を具体的に書く
- 解消したら行を削除する（履歴は git log が持つ）
-->
