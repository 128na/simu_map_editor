# Simutransハイトマップ仕様調査とブラウザエディタ設計案

## 目的 / 発端

ユーザーから、Simutrans向けのマップエディタについて、実装に先立つ画像仕様と実現可能な設計の確認を依頼された。本記録は調査時点の事実と未実装の提案を保存する。

### ユーザー要件

- Webブラウザで動作する。
- 保存などのためのバックエンドは不要。
- 地形の高低差と海を立体的に確認できる。
- 都市開発ゲームのマップエディタのように、平坦化・盛り上げ・掘り下げができる。
- マップ画像をインポート・エクスポートできる。

## 分かったこと（事実）

### 調査対象と根拠

公式 `simutrans/simutrans` の公開masterを確認し、ローカルの `128na/simutrans` コミット `af90444e46dfd422bfdf80518aaa568659ec6b00` と照合した。ローカルのバージョン定義は124.3.2 Nightly。以下の固定URLは再確認可能なローカル調査対象に対応する。公式masterの確認結果は移動する参照であり、全処理の同一性を保証しない。

- [高さ画像の読込・変換](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/dataobj/height_map_loader.cc)
- [画像形式の判定](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/io/raw_image.cc)
- [BMPデコーダ](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/io/raw_image_bmp.cc)
- [PPMデコーダ](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/io/raw_image_ppm.cc)
- [PNGデコーダ](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/io/raw_image_png.cc)
- [画像選択画面](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/gui/load_relief_frame.cc)
- [地形生成](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/world/simworld.cc)
- [頂点の高さ補正](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/world/surface.cc)
- [初期設定](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/dataobj/settings.h)
- [公式の高さ変換処理](https://github.com/simutrans/simutrans/blob/master/src/simutrans/dataobj/height_map_loader.cc)

### 画像形式と意味

| 項目 | 確認内容 |
| --- | --- |
| データの範囲 | 地形の標高画像。都市、道路、建物やセーブゲーム全体を表現する形式ではない |
| 寸法 | 画像W×Hに対してタイルW×H、頂点格子(W+1)×(H+1) |
| BMP | 8bpp無圧縮・RLE8、24bpp無圧縮。32bppは対象外 |
| PPM | バイナリP6、最大値255・RGB各1byteを前提。最大値が異なっても正規化しない |
| PNG | 読込画面から選択可能。16bitは8bitへ縮小される |
| 標高の取得 | 現行loaderは画素先頭byteを利用。カラー画像はR、パレット画像は展開した色のR、灰階画像は灰階値 |
| 海面 | 画像とは別のgroundwater設定。青色などの色指定による水面マスクではない |

BMP/PPMのみと記載されたヘッダコメントより、実際のraw_image形式判定とGUIの読込処理を優先した。書出画像ではRGBを同値にすることで、色成分の解釈差を避けられる。「各成分8bitのグレースケール」と「8bppのBMPファイル」は区別する。

### 高さ変換

入力グレー値を `v=0..255`、設定下限・上限を `min` / `max` とすると、loaderの変換は以下。floorは非負の被除数に対する整数除算を表す。

| モード | loaderが返す標高 |
| --- | --- |
| LINEAR | `min + floor(v * (max-min) / 255)` |
| CLAMP | `clamp(v-128, min, max)` |
| LEGACY_SMALL・高さ係数2 | `clamp(floor(6*v/32)-28, min, max)` |
| LEGACY_SMALL・高さ係数1 | `clamp(floor(6*v/64)-14, min, max)` |
| LEGACY_LARGE・高さ係数2 | `clamp(floor(6*v/24)-34, min, max)` |
| LEGACY_LARGE・高さ係数1 | `clamp(floor(6*v/48)-18, min, max)` |

確認した初期値はLINEAR、min=-12、max=32、海面=-2。ただし利用者の設定・paksetで変わるため固定仕様として扱わない。画像単体から変換モード・標高範囲・海面を復元することはできない。

### 読込後の補正

`simworld.cc` は読込標高に+1して頂点格子へ格納し、右端・下端を複製する。`cleanup_karte` では近傍の高さを補正する。`surface.cc` の `raise_grid_to` は8近傍へ高さを伝播し、許容差は `double_grounds` に応じて1または2となる。この判定と画像変換用のpak高さ係数は別の設定として扱う。

その後の湖・河川・砂浜生成も地形や水域へ影響する。画像の灰階値をそのまま高さにしたメッシュとゲーム内地形は一致しない。水域判定も単一点の高さだけでなく、タイルの頂点と水位を考慮する必要がある。

## 設計提案（未実装・未確定）

### 対象と構成

最初はSimutrans Standardを対象とし、TypeScriptとThree.js/WebGL2を使う静的配信アプリを候補とする。ファイルはFile APIで選択・ドラッグ＆ドロップし、Blobのダウンロードで書き出す。バックエンドは導入しない。ブラウザ内の永続保存や独自プロジェクトファイルは必須要件に含めず、必要性を別途判断する。

- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [ブラウザのファイル入出力](https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications)
- [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)

### データの分離

1. 編集する標高を正本とし、ブラシ計算では小数の累積を許容する。
2. 選択した互換設定で表現できる整数標高へ量子化する。
3. 高さの+1、外周複製、斜面補正を適用してゲーム取り込み後のプレビューを構築する。
4. 出力時は灰階値0..255の逆引き表を使い、同じ設定で復元できる値を選ぶ。
5. 出力バイト列を再デコードし、補正まで再適用した頂点格子をプレビューと比較する。

内部標高がloader標高か+1後の標高かをAPI境界で明示する。表示用の高さ強調倍率は書出データへ影響させない。互換設定には対象版、変換モード、標高上下限、海面、pak高さ係数、double_grounds、再現する自動生成の範囲を含める。旧方式で表現できない標高を黙って丸めない。

### 編集と表示

- 盛り上げ、掘り下げ、指定標高への平坦化、平滑化。
- ブラシ半径・強さ・縁の減衰、標高スポイト、Undo/Redo。
- 陰影、標高色、等高線、水面、回転・ズーム・真上表示。
- 地形の分割メッシュと変更範囲の更新、重い計算のWorker分離。
- 初期の性能評価対象は1024×1024タイル。ゲームのサイズ上限や実測済み対応上限を意味しない。

### 初期版の入出力

BMP・PPM・PNGのインポートを候補とし、主な書出形式はRGB各成分を同値にした24bpp無圧縮BMPとする。PPM/PNG書出は優先度を別途決める。ブラウザの画像デコードやCanvasで色変換・透明度処理が入る可能性があるため、元のサンプル値を保持できる処理と既知値による検証が必要。

## 推測・未確認事項

- エディタの実装、ブラウザ間の互換性、速度、メモリ使用量は未検証。
- 手元の実行ファイルが調査したソースと同一ビルドであることは未確認。
- 使用するゲーム版とpaksetはユーザー未指定。Extendedへの互換性は未調査。
- 湖・河川・砂浜の完全再現は初期版の保証対象にしない案であり、実機との差を明示する必要がある。
- 調査対象の既存テストについて、画像から地形生成までの直接的な保証は確認できていない。

## 次の検証

小さな既知画像に平地、急斜面、海岸、四隅の異なる高さを含め、実際のSimutransへ取り込む。向き、タイル数、+1、外周、近傍補正、水域を比較する。最初は追加の自動生成を抑えた条件を明示し、その後で湖・河川・砂浜の影響を切り分ける。

量子化・逆引きの検証に加え、BMPの行パディング・上下方向・パレット、P6ヘッダ、PNGのサンプル値保持と、ブラシの結果がフレームレートに依存しないことを開発時の確認対象とする。

## 結果どうしたか

ブラウザのみで要件を実現できる構成案を提示した。実装開始前に仕様の実機照合を優先する。文書基盤の採用理由は [ADR-0001](../adr/0001-use-docs-lint.md) に記録し、アプリ本体の採用判断とは分離した。
