import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Native JS reporter is exercised directly by Node.
import {makeReport,render,parseComment,toCsv,marker,validatePublication} from '../tools/validation/performance-history.mjs';
const metadata={schemaVersion:1,benchmarkVersion:'cpu-v1',recordedAt:'2026-10-20T00:00:00Z',repository:'128na/simu_map_editor',revision:'abc',runId:'123',runAttempt:'1',runUrl:'https://github.com/128na/simu_map_editor/actions/runs/123',environment:{cpu:'CPU, test'}};
const cpu=()=>({metadata,samples:[{size:1024,tool:'raise',ms:[5,1,4,2,3],medianMs:999}]});
test('Issue comment retains exact raw samples and CSV recalculates the median',()=>{
 const report=makeReport('cpu',[cpu()]),body=render(report);
 assert.equal(marker(report),'<!-- performance-history:v1:cpu:123:1 -->');
 assert.deepEqual(parseComment(body),report);
 const csv=toCsv([{report,commentUrl:'https://example.test/comment'}]);
 assert.ok(csv.includes('"1024","raise","3","5"'));assert.ok(csv.includes('CPU, test'));
 assert.equal(toCsv([{report,commentUrl:''}]).split('\n').length,3);
 assert.equal(parseComment('unrelated comment'),null);
 assert.notEqual(marker({...report,metadata:{...metadata,runAttempt:'2'}}),marker(report));
});
test('history rejects missing identity, mixed runs, unsupported schema and invalid timings',()=>{
 assert.throws(()=>makeReport('cpu',[{...cpu(),metadata:{}}]));
 assert.throws(()=>makeReport('cpu',[cpu(),{...cpu(),metadata:{...metadata,runId:'other'}}]));
 assert.throws(()=>makeReport('cpu',[{...cpu(),samples:[{size:1024,tool:'raise',ms:[NaN]}]}]));
 assert.throws(()=>parseComment(render(makeReport('cpu',[cpu()])).replace('cpu:123:1','cpu:999:1')));
 assert.throws(()=>render({...makeReport('cpu',[cpu()]),results:[{...cpu(),padding:'x'.repeat(60000)}]}));
});
test('browser report produces separate operation rows and escaped JSON roundtrips',()=>{
 const r={metadata:{...metadata,benchmarkVersion:'browser-v1'},size:256,browser:'chromium',browserVersion:'1',metrics:{renderer:'<details>`test'},strokes:{raise:[{ms:2},{ms:4}]},createMs:1,undoMs:1,redoMs:1,dragMs:1,rotateMs:1,frameIntervals:[10,20]};
 const report=makeReport('browser',[r]),body=render(report);assert.deepEqual(parseComment(body),report);
 assert.ok(body.includes('\\u003c'));assert.equal(toCsv([{report,commentUrl:''}]).trim().split('\n').length,8);
});

test('publisher retries can reuse the earlier measurement attempt without changing its identity',()=>{
 const report=makeReport('cpu',[cpu()]);
 const env={GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2',GITHUB_SHA:'abc'};
 validatePublication(report,env);assert.equal(marker(report),'<!-- performance-history:v1:cpu:123:1 -->');
 assert.throws(()=>validatePublication(report,{...env,GITHUB_RUN_ATTEMPT:'0'}));
 assert.throws(()=>validatePublication(report,{...env,GITHUB_RUN_ID:'999'}));
 assert.throws(()=>validatePublication(report,{...env,GITHUB_SHA:'other'}));
});
