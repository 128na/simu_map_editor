# 性能記録をIssueコメントへ保存する運用

## 発端と判断

利用者の提案に従い、artifactの30日期限を超えて蓄積できる専用 [Issue #1](https://github.com/128na/simu_map_editor/issues/1) を作成した。外部DBや新たな保存用ブランチを追加せず、コメントに集計表と生JSONを保存する。GitHub側でコメントやIssueが削除されるまで残る方式であり、別媒体のバックアップを意味しない。

## 実施した内容

mainへのpushのCPU計測、mainでの手動ブラウザ計測が成功した後に、別ジョブで投稿する。計測ジョブには書込権限を追加せず、投稿ジョブだけcontents/actions read・issues writeを付与する。PRとmain以外は投稿しない。投稿スクリプト自体もリポジトリ・イベント・refと計測のrun ID・SHAを検証する。

計測JSONにschemaVersion、benchmarkVersion、日時、SHA、run ID、計測attempt、run URL、workflow、CPU/OS/Node/runner環境、ブラシとプロファイル・warmup/試行条件を追加した。ブラウザ実バージョンとPlaywrightバージョンも保存する。既存の試行配列は温存する。

種別・run ID・計測attemptのmarkerをコメントに埋め、同じ記録があれば二重投稿しない。投稿ジョブだけの再実行では、同じrun/SHAの以前の計測attemptも受け付け、元のmarkerを保つ。新たな再計測attemptは別記録になる。全コメントをページングして確認し、公式github-actionsボットの記録だけを集計対象にする。60,000文字を超えるコメントは切り捨てず拒否する。ブラウザの手動サイズ選択には256/512も追加し、小さな動作確認を可能にした。

## 集計

`npm run performance:export` はIssueコメントのJSONから各試行の中央値を再計算し、`.validation/performance-history.csv` へ出力する。1行は1実行・サイズ・操作、単位はms。種別・計測版・日時・SHA・run/attempt/URL・試行数・環境・元コメントURLを保持する。CPUとブラウザ、異なる版や環境は分けて比較する。

## 検証

ローカルの単体37件、lint・型チェック、メタデータ付きCPU計測9組と専用Chromium256の操作計測が成功した。JSON往復、中央値再計算、CSV引用符、異なるrunの混在・不正時間拒否、計測識別子の一致、投稿ジョブ再試行の条件を検証した。YAML構文も解析できた。

レビューで投稿だけの再実行と元attemptの不一致を指摘され、同run/SHAの過去attemptを認める形へ修正し回帰を追加した。製品の造成・描画処理は変更していない。既存の測定レコードは書き換えず、新たな計測から共通メタデータを付ける。
