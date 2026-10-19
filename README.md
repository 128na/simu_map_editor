# Simu Map Editor

Simutrans向けに、ブラウザ内で地形の立体表示・編集とハイトマップ画像の入出力を行うプロジェクトです。

アプリ本体は未実装です。初期化時点の調査と設計案は `docs/records/`、意思決定は `docs/adr/` に保存します。

## 開発準備

Node.js 22以降とnpmを用意して実行します。

```sh
npm ci
npm run lint
```

アプリの起動・ビルドコマンドは、アプリ実装時に追加します。

WindowsでSimutransの実ソースを照合する場合は `npm run validate:heightmaps` を使います。外部ソース・コンパイラ等の前提と検証範囲は [検証記録](docs/records/2026-10-20_heightmap-probe-validation.md) を参照してください。

## ドキュメント

ドキュメントは [docs/README.md](docs/README.md) の規約に従います。
調査の続報は新しい記録として追加し、過去の記録は書き換えません。
