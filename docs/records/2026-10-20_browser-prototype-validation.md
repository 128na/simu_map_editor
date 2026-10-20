# ブラウザ試作とゲーム全体での取り込み検証

## 目的 / 発端

画像読込→簡単な3D表示→造成ブラシ→BMP書出の小さな試作で、実装開始前の懸念を確認するよう依頼された。過去の[プローブ検証](2026-10-20_heightmap-probe-validation.md)に、実ブラウザと実ゲームの初期化経路を加えた。

## 実装した検証用試作

TypeScript、Three.js 0.186.1、Vite 8.3.4で静的配信できるアプリを作成した。ファイル入出力と計算は端末内で完結する。都市開発ゲームのような連続ストロークを作り込む前段階として、クリック単位の盛土・掘削・平坦化、Undo/Redo、互換設定、BMP出力を実装した。

- [標高とブラシ](../../src/terrain.ts)
- [PNG/BMP/PPM読込とBMP書出](../../src/codecs.ts)
- [表示と操作](../../src/main.ts)
- [ブラウザ検証](../../tests/browser/prototype.spec.ts)
- [ブラウザ結果サマリー](2026-10-20_browser-prototype-results.json)
- [ゲーム全体の結果サマリー](2026-10-20_world-probe-results.json)

試作の入力上限は各辺4096、総画素数1,048,576、ファイル16 MiB。展開前に寸法を確認する。Undoは20操作分の全標高コピーで、差分保存ではない。対応PNGは8bitの非インターレース灰階/RGB/不透明RGBAに限定し、16bit、パレット、半透明などは拒否する。BMP RLE8はrun/absoluteを扱い、deltaは拒否する。

PNGはCanvasや通常の画像表示パイプラインを通さず、標高として元の画素値を読む。PNGフィルタ0〜4を復元し、gAMA等の表示用メタデータによる色変換を適用しない。実Simutransローダーとの比較で、色管理を経た見た目の輝度ではなく画素のR成分を標高に使う経路を照合した。

## 検証結果（事実）

| 対象 | 結果 |
| --- | --- |
| 従来のネイティブプローブ | 15画像×16条件、240ケース通過 |
| 単体テスト | 地形・PNG全フィルタ・RLE8 absolute・失敗時保持など16件通過 |
| Chrome / Edge E2E | 両ブラウザ合計12件通過、skip・unexpected・flakyは0 |
| ブラウザの標高・補正 | 各ブラウザ227条件で実Simutransプローブと全標高・全頂点が一致 |
| ブラウザの造成後BMP | 各ブラウザ24条件で、盛土・掘削・平坦化後の出力をnativeで読み直した頂点格子が一致 |
| UIの一連操作 | 実ファイル選択、クリック造成、Undo/Redo、download、再読込、入力失敗時保持、20操作の履歴上限を確認 |
| 量子化の表示 | Clampで標高20→Legacy small係数1へ変更すると到達上限9となるケースを、出力前から64画素の範囲外変換として表示。Undoで元の20を復元 |
| 型・文書・ビルド | typecheck、docs-lint、production buildが成功 |

実装中に、外周を複製する前に斜面補正すると、端に近い山の外周頂点が実ゲームと違うことを検出した。順序を外周複製→補正へ修正し、境界ピークの回帰テストとnative比較で確認した。

### 実ゲームの初期化経路

調査対象コミット `af90444e46dfd422bfdf80518aaa568659ec6b00` の専用cloneへ、[計測用パッチ](../../tools/validation/world-probe.patch)を適用してheadlessビルドを作った。地形生成ロジックは変更せず、画像を渡すCLI入口と頂点・水判定の出力、砂浜生成直前のスナップショットだけを追加した。`karte_t::load_heightfield → init` を実行した。

PNG平地・四隅、非対称BMP、UI書出BMP、24×24の全海・海岸BMPの計6入力で、1640頂点がnativeプローブと一致した。1467タイルの水判定を四頂点最大値とローカル水位から求め、実ゲームのis_waterと全件一致した。うち696タイルが水だった。海底の高さには水タイルのzではなくlookup_hgtを使った。

条件はpak128の実設定（高さ係数2、double-height対応、標高上下限-12/32、海面-2）と、linear/clampモード。都市・工場・観光施設・樹木・湖・川は無効にした。砂浜処理は有効にして生成前後を比較し、今回の6画像では頂点変化0だった。一般的に砂浜が地形を変えないという保証にはならない。

UI書出画像のゲーム全体での照合は、このpakプロファイルでnativeとも比較した結果である。ブラウザ側の別プロファイル（係数1・斜面1段）との直接一致を意味しない。ブラウザ側で指定した条件と同じ条件のnative照合は、別のE2Eで行っている。

### 1024×1024の性能観測

WindowsのChrome 156 / Edge 156、RTX 4070 Ti、24 logical processorsの端末で、headlessブラウザから1回ずつ観測した。平均や安定性を保証するベンチマークではない。

| 観測 | Chrome | Edge |
| --- | --- | --- |
| 初期地形計算・メッシュ生成 | 約506 ms | 約533 ms |
| 1回の盛土計算・全メッシュ再生成 | 約612 ms | 約648 ms |
| メッシュCPU配列 | 約60.1 MiB | 約60.1 MiB |
| 報告されたJS heap | 約158 MiB | 約197 MiB |
| 4 MiBバッファのWorker起動＋往復転送 | 約57 ms | 約66 ms |

JS heapはピークメモリでもGPU込みの総量でもない。描画測定はrequestAnimationFrame待ちを除いたrender＋finishの経過時間で、持続FPSと解釈しない。ブラシ測定もテストAPIからの同期呼出時間で、ポインターのraycastや次の描画が見えるまでの全入力遅延ではない。Workerは転送だけの試験であり、地形処理のWorker実装はまだない。

単一メッシュを毎回作り直す方式では、連続ブラシに必要な応答性を示せなかった。局所更新、分割メッシュ、必要な計算のWorker化を次の検討対象とする。

## 再実行

通常のアプリ起動と単体確認:

```sh
npm ci
npm run dev
npm run lint
npm test
npm run build
```

WindowsのMSYS2 MinGW64（g++、libpng等）と対象コミットの外部ソース、インストール済みChrome/Edgeがある場合:

```sh
npm run validate:prototype
```

ゲーム全体の照合は、さらに実行用データとpakset、CMake/NinjaおよびSimutransビルド依存が必要。

```sh
powershell -NoProfile -File tools/validation/run-world-probe.ps1
powershell -NoProfile -File tools/validation/run-world-probe.ps1 -SkipBuild
```

[スクリプト](../../tools/validation/run-world-probe.ps1)の引数で外部ソース・データ・pakset・コンパイラの場所を指定する。専用clone、実行ファイル、画像、出力JSON、専用userdirはすべて `.validation/` に置く。既存ソースとゲームデータは変更しない。再利用時はtracked差分が計測パッチと完全一致すること、追加ソースがないこと、ビルドとパッチのハッシュ、出力の鮮度を確認する。

`-SkipBuild`での再実行も成功した。生成画像・全格子・ブラウザtrace・スクリーンショットは `.validation/` に保存する。CIには文書・型・単体テストとアプリビルドを入れ、外部ソースやローカルpaksetに依存する検証をCI成功と混同しない。

## 残る制約と判断

- 海面は平面による近似表示で、ゲームのタイル単位の海岸描画は未再現。
- 全ゲーム版・pakset、任意の標高上下限、湖・川・砂浜生成を一般化して保証していない。
- 入出力画像は互換設定や小数標高、Undo履歴を保存しない。編集再開ファイルの要否は未決定。
- 端末間の性能差、連続ストローク、raycast遅延、処理のキャンセルとWorker分担、GPU込みのピークメモリは未確認。
- 書出画像のnative一致は、ゲーム内の造成コマンドと操作手順まで同じであることを意味しない。
- ビルドは単一JSチャンクが500 kBを超える警告を出す。試作では許容し、配信最適化を検証済みとは扱わない。

機能と互換変換の試作は成立したが、連続操作の性能基準と実用上限は確定していない。[描画基盤](../adr/0003-typescript-threejs-rendering.md)、[サイズ制約](../adr/0007-editor-size-and-resource-budget.md)、[造成制約](../adr/0008-slope-constrained-brushes.md)は、この試作だけでAcceptedへ変更しない。
