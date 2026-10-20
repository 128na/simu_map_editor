# IndexedDBへの履歴退避の成立条件の検証

## 目的と対象

利用者の依頼で、4096四方を超える地図も考慮したUndo履歴の非同期退避を検証した。製品のUndo/Redoへは統合せず、[Worker](../../tools/validation/idb-history-worker.ts)・[コーディネータ](../../tools/validation/idb-history-client.ts)・[実ブラウザ検証](../../tests/browser/history-storage.spec.ts)を独立した試作として追加した。

Windows / i9-12900F、Chrome 155.0.8059.82、Edge 155.0.4283.62。利用者のプロファイルを使わず、検証専用の永続プロファイルと `simu-history-validation-` prefixのDBを使用し、最後にDBを削除した。最初に実行したephemeral Contextの値は以下の採用値に混ぜていない。通常ディスク保存に近い経路だが、OSキャッシュ等を含むため純粋な物理ディスク速度ではない。

## 方法

4096² Float32標高1枚に相当する64 MiBと、8192²に相当する256 MiBのバイナリを、それぞれ3回保存・読込した。画像の読込や8192地形の描画は行っていない。入力をqueue開始時に複製してWorkerへtransferし、Worker側で4 MiBずつentriesへ分割し、manifestとheadを同じreadwrite transactionで保存した。request successではなくtransaction complete後だけRAM保持を解放した。全体のchecksumと元bufferがdetachされていないことを確認した。

書込時間はqueue・mainの複製・Workerへの転送・IndexedDB transaction完了応答までを含む。読込時間はDBから全chunkを取得してWorkerで再構成し、mainへtransferするまで。データ生成とchecksumは計時外。IO中のrAF間隔は、書込開始から読込応答後の次frameまで測り、生成・checksum区間を除外した。main準備は元bufferのcopyとpostMessageであり、enqueue直後のPromise登録時間とは区別する。

## 結果（ms、各3回中央値）

| Browser | MiB | 書込 | 読込 | main準備 | IO中最大frame間隔 |
| --- | ---: | ---: | ---: | ---: | ---: |
| chrome | 64 | 157.4 | 96.4 | 13.1 | 17.5 |
| chrome | 256 | 727.3 | 439.4 | 62.4 | 65.6 |
| edge | 64 | 169.2 | 93.4 | 15.5 | 17.6 |
| edge | 256 | 706.1 | 429.8 | 51.8 | 57.3 |

生データは [結果JSON](2026-10-20_indexeddb-history-results.json) に保存した。独立した1 MiB payload20件のqueue完了はChrome136.8 ms、Edge137.8 ms。再接続後、全seqの固有値・長さ・共通payload内容を確認した。入力payload準備を含むbatch時間で、実際の地形差分生成やeditorのUndo性能を測ったものではない。

256 MiBは非同期APIでもmain側の事前copyに約52〜62 msを要した。Worker化だけでframe停止がなくなるわけではない。IO後hotBytesがゼロになることは参照解放の確認であり、GCやプロセス全体のRAM回収を測ったものではない。

## 失敗と復帰の検証

- 最初の単一256 MiBレコード経路はInvalidStateErrorで失敗し、4 MiB分割に切り替えると往復成功した。この観測から全ブラウザ共通のレコード上限を断定しない。
- request success後にtransactionをabortする注入試験で、headとデータのrollback、旧履歴維持、失敗分RAM保持を確認した。疑似quota注入は実quota試験とは別に記録した。
- CDP Storage.overrideQuotaForOriginで検証originを1 MiBへ制限し、8 MiBの非圧縮payloadが実際のQuotaExceededErrorになることを両ブラウザで確認した。旧4 KiB履歴とhead0は残り、新8 MiBはRAMへ残りDBに存在しない。実ディスクは埋めていない。
- baseline保存後のquota変更では書込が通るため、DB使用前に制限する順へ変更した。Chromium BucketContextの30秒の容量照会cacheと整合する。CDPのoverrideActive/quotaとnavigator.storage.estimateの値も保存した。estimateだけから確保可否を判断しない。
- pending writeの後にsession cleanupを直列化し、別sessionを残した。cleanup中の同session新spillはhot登録前に拒否し、清掃が後続失敗データを消す競合を防いだ。
- 同キー8 MiB→4 KiB上書きで旧chunkを同transaction内で削除し、短い再書込も読めることを確認した。
- 1 MiBのRAM待ち予算に対し追加分を拒否し、元bufferとpending中のRAM読出、commit後のhot解放を確認した。試作の既定512 MiBは実験用で、製品の予算決定ではない。

4ブラウザケース、型チェックが成功した。レビューの旧chunk残留とcleanup競合の指摘は修正して回帰検証へ追加し、未解消Must/Shouldなしを確認した。

## 一次資料と判断

[IndexedDB仕様](https://www.w3.org/TR/IndexedDB-3/)はWorkerでの利用、transaction lifecycleとdurabilityを定義する。transaction completeはcommit成功の判定に使えるが、既定durabilityで電断耐性まで保証する扱いはしない。[Chrome性能指針](https://web.dev/articles/indexeddb-best-practices-app-state)も大きな値のserializationとWorkerを論点とする。

[Edgeのストレージ説明](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/offline)、[Storage Standard](https://storage.spec.whatwg.org/#usage-and-quota)によればquotaやusageは物理空き容量の保証ではなく、best-effortデータの削除も考慮する必要がある。容量照会cacheは [Chromium BucketContext](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/indexed_db/instance/bucket_context.h) と [実装](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/indexed_db/instance/bucket_context.cc) を確認した。

差分履歴をchunk化し、最近分をRAM・古い分をIndexedDBへ置く方式は採用候補として有望。全snapshotの毎操作退避は大地図ほどcopyと読込待ちが目立つ。RAM待ち/常駐/ディスクに別byte予算を設け、quota失敗時の縮退と通知を設計してから本体へ統合する。

## 制約と再実行

まだ本体Undo/Redo、分岐履歴、現在地形との原子的同期、ブラウザ再起動、クラッシュ・電断・eviction、別タブ同時編集、Worker障害後のfuture RPCやreadとclose競合は未検証。queue中の入力bufferはackまで変更・detachしない契約が必要。hotBytes予算は入力参照の論理合計で、copy/IDB内部/読込再構成/GPU込みの総RAM上限ではない。IndexedDBへ移せるのは過去履歴で、現在地形とGPUメモリは別に削減する必要がある。

PowerShellで `$env:VALIDATE_HISTORY='1'; npm run test:browser -- --grep 'IndexedDB'`。通常はスキップする。試作・計測結果をもって大サイズのエディタ対応や編集再開の永続セーブを実装済みとは扱わない。
