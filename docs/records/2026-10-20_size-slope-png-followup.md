# マップサイズ・造成時の斜面・PNG対応の追加確認

## 目的 / 発端

初期ADRに対し、ユーザーからサイズ上限と性能、造成時の斜面制限、PNGの可否について懸念が提示された。初期調査を補足し、実装前に不足する判断を切り分ける。

## 分かったこと（事実）

対象は [初期調査](2026-10-19_simutrans-heightmap-research.md) と同じStandardソースのコミット `af90444e46dfd422bfdf80518aaa568659ec6b00`。実機計測は行っていない。

### サイズ

[welt.cc](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/gui/welt.cc#L141) の新規マップ画面は、各軸8〜32766を許容する。反対軸を変更してもこの上限は変わらず、同ファイル359行以降はメモリ概算を表示する処理である。これは32766×32766が実用的に動くという保証ではない。

画像読込は [height_map_loader.cc](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/dataobj/height_map_loader.cc#L31) で画像寸法をsint16へ渡す経路があり、GUIの上限チェックが全形式の読込を安全に制限してくれるとは扱えない。エディタ側でヘッダ寸法を検証し、確保前に独立した上限を適用する必要がある。

### 造成時の斜面

[terraformer.cc](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/world/terraformer.cc#L202) は、タイル四隅の最大標高と最小標高の差を、double_groundsが無効なら1段、有効なら2段以内とする。[surface.cc](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/world/surface.cc#L388) の読込後補正も、8近傍へ1段または2段の差で高さを伝播する。自然地形に垂直壁や1タイル3段以上の斜面を作れる設計にはできない。人工構造物の壁はこの調査の対象外。

ADR-0004/0005は取り込み後の斜面補正を考慮しているが、掘削時に周囲を下げるなど、操作意図を保つための編集側の補正を具体化していない。読込時の盛土方向の補正だけでは、山の隣を掘っても表示上は下がらない場合がある。

### PNG

[raw_image.cc](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/io/raw_image.cc#L73) はPNGを読み込む。[load_relief_frame.cc](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/gui/load_relief_frame.cc#L129) は同じloaderで判定するため、確認した版ではマップ画像として選択できる。[raw_image_png.cc](https://github.com/128na/simutrans/blob/af90444e46dfd422bfdf80518aaa568659ec6b00/src/simutrans/io/raw_image_png.cc#L70) は16bitを8bitへ縮小する。

ADR-0006でBMPを標準出力にした理由は互換性で、PNGが読めないためではない。PNGインポートは既に対象に含めており、PNGエクスポートはまだ採用していない。調査対象以外の古い版でのPNG対応開始時期は未確認。

## 性能の概算（推定・実測ではない）

全解像度の単純なindexed meshで、各頂点にFloat32の位置3成分と法線3成分、各タイルにUint32の三角形インデックス6個を持つと仮定する。メッシュ配列1組は `24*(W+1)*(H+1)+24*W*H` byte。タイル別メッシュ、UV、色、分割境界の重複などは含めない。

| 正方形の辺 | 三角形数 | メッシュ配列1組 | 編集用Float32標高 |
| --- | --- | --- | --- |
| 1024 | 約210万 | 約48 MiB | 4 MiB |
| 2048 | 約839万 | 約192 MiB | 16 MiB |
| 4096 | 約3355万 | 約768 MiB | 64 MiB |

CPUとGPUの両方に同じメッシュ情報を保持する場合、両者をそれぞれ計上する必要がある。変換用バッファ、画像デコード、Undo、Workerへのコピー、水面も加算される。PNGの圧縮ファイルが小さくても、展開後の標高とメッシュが小さくなるわけではない。

## 結果どうしたか

サイズに関する制限と性能確認の方針を [ADR-0007](../adr/0007-editor-size-and-resource-budget.md)、造成中の斜面制約を [ADR-0008](../adr/0008-slope-constrained-brushes.md) の提案として追加した。具体的な対応サイズとブラシ補正方式は検証前にAcceptedにしない。
