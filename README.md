# Simu Map Editor

Simutrans向けの、ブラウザ内で動作する地形エディタの検証用試作です。画像の読込、3D地形と水面の表示、ドラッグによる造成、Undo/Redo、BMP書き出しを試せます。

## 起動

Node.js 22.18以降とnpmを用意して実行します。

```sh
npm ci
npm run dev
```

表示されたローカルURLをChromeまたはEdgeで開きます。幅・高さ（タイル数）を指定して平坦な地形を新規作成するか、マップ画像を読み込んで開始します。新規作成は現在の地形とUndo履歴を置き換えます。左ドラッグで連続造成し、右ドラッグで回転、ホイールでズームします。盛土・掘削は開始点の高さ±強さ、平坦化は開始点の高さに固定します。1ドラッグを1回のUndoで戻せます。Escapeで途中のドラッグを取り消します。海面表示は近似で、ゲームの湖・河川・砂浜生成は再現していません。画像から復元できない互換設定は、ゲーム側と合わせて指定してください。

入力は非インターレース8bitの灰階/RGB/不透明RGBA PNG、8bit・24bit BMP、PPM P6（最大値255）に対応します。PNGパレット・16bit・半透明、BMP RLEのdelta命令などは試作では明示的に拒否します。上限は各辺4096・総画素数1,048,576・ファイル16 MiBです。水面の頂点・法線CPU配列には別途16 MiBの上限があり、海岸線が複雑すぎる画像は拒否します。これは検証用の処理制限で、あらゆる端末での快適な操作を保証する値ではありません。

## 検証

```sh
npm run lint
npm test
npm run build
```

Windows上で、外部SimutransソースとMSYS2 MinGW64を使う検証:

```sh
npm run validate:heightmaps
npm run test:browser
powershell -NoProfile -File tools/validation/run-world-probe.ps1
```

ブラウザテストにはインストール済みのChromeとEdgeが必要です。ゲーム全体の検証には追加でpakset・実行用データ・CMake/Ninja等が必要です。再現条件と検証の限界は [試作の検証記録](docs/records/2026-10-20_browser-prototype-validation.md) を参照してください。

## ドキュメント

ドキュメントは [docs/README.md](docs/README.md) の規約に従います。初期調査は `docs/records/`、意思決定は `docs/adr/` に保存し、調査の続報は新しい記録として追加します。
