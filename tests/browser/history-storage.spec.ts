import {test as base,expect,chromium} from '@playwright/test';
import {createPerformanceMetadata} from '../../tools/validation/performance-metadata.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const test=base.extend({page:async({},use,info)=>{
 const context=await chromium.launchPersistentContext(info.outputPath('profile'),{channel:info.project.name==='edge'?'msedge':'chrome',headless:true,baseURL:'http://127.0.0.1:4173',viewport:{width:1280,height:900}});
 try{await use(context.pages()[0]??await context.newPage());}finally{await context.close();}
}});
test.skip(!process.env.VALIDATE_HISTORY,'Explicit disk and memory validation');
const provenance=(page:any,project:string)=>({metadata:createPerformanceMetadata('history-spill-v1'),browser:project,browserVersion:page.context().browser()?.version()??null,profileMode:'isolated persistent profile',chunkBytes:4*1024*1024});

test('IndexedDB worker spill benchmark and recovery',async({page},info)=>{
 test.skip(!process.env.VALIDATE_HISTORY,'Explicit disk and memory validation');test.setTimeout(240000);
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const path='/tools/validation/idb-history-client.ts';const {HistoryProbe}=await import(path);
  const name='simu-history-validation-'+crypto.randomUUID();let store=new HistoryProbe();await store.open(name);
  const estimateBefore=await navigator.storage.estimate();const records:any[]=[];
  const expected=(i:number)=>(Math.imul(i,1664525)+1013904223)|0;
  const buffers=(bytes:number)=>{const array=new Int32Array(bytes/4);for(let i=0;i<array.length;i++)array[i]=expected(i);return array.buffer;};
  const checksum=(buffer:ArrayBuffer)=>{const a=new Int32Array(buffer);let hash=0;for(let i=0;i<a.length;i++)hash=(Math.imul(hash,31)+a[i])|0;return hash;};
  let maxFrameGap=0,last=performance.now(),tracking=true,measuring=false;const tick=()=>{const now=performance.now();if(measuring)maxFrameGap=Math.max(maxFrameGap,now-last);last=now;if(tracking)requestAnimationFrame(tick);};requestAnimationFrame(tick);
  try{
   // Full-source Float32 snapshots: 4096²=64MiB, 8192²=256MiB.
   for(const bytes of [64*1024*1024,256*1024*1024]){
    const writes:number[]=[],reads:number[]=[],enqueue:number[]=[],worker:number[]=[],preparation:number[]=[];maxFrameGap=0;
    const buffer=buffers(bytes),hash=checksum(buffer);
    for(let trial=0;trial<3;trial++){
     await new Promise<void>(r=>requestAnimationFrame(()=>r()));measuring=true;last=performance.now();
     const start=performance.now(),queued=store.spill('snapshot',trial,buffer);enqueue.push(performance.now()-start);
     const detail=await queued;writes.push(performance.now()-start);worker.push(detail.workerMs);preparation.push(detail.preparationMs);
     const readStart=performance.now(),read=await store.read('snapshot',trial);reads.push(performance.now()-readStart);
     await new Promise<void>(r=>requestAnimationFrame(()=>r()));measuring=false;
     if(!read||read.byteLength!==bytes||checksum(read)!==hash)throw new Error('Snapshot corruption');
     if(buffer.byteLength!==bytes)throw new Error('Original snapshot detached');
    }
    records.push({bytes,writes,reads,enqueue,worker,preparation,maxFrameGapDuringIO:maxFrameGap,hotBytes:store.hotBytes()});await store.clear('snapshot');
   }
   const delta=buffers(1024*1024),start=performance.now();const operations=[];
   for(let seq=0;seq<20;seq++){const payload=delta.slice(0);new Int32Array(payload)[0]=1234+seq;operations.push(store.spill('deltas',seq,payload));}await Promise.all(operations);
   const deltaBatchMs=performance.now()-start;
   // Request success followed by transaction abort must roll back data and head.
   const original=buffers(4096);await store.spill('failure',0,original);
   const failures=[];
   for(const fault of ['abort','quota'] as const){
    const before=checksum(original);let caught='';try{await store.spill('failure',1,original,fault);}catch(e){caught=(e as Error).name;}
    const head=await store.head('failure');const retained=await store.read('failure',1);
    failures.push({fault,caught,head,retained:!!retained&&checksum(retained)===before,hotBytes:store.hotBytes()});
   }
   // Queue cleanup after a pending write, and preserve a different session.
   await store.spill('other',0,original);const pending=store.spill('old',0,delta);const cleanup=store.clear('old');let cleanupLateRejected='';try{await store.spill('old',1,delta);}catch(e){cleanupLateRejected=(e as Error).name;}await pending;await cleanup;
   await store.spill('overwrite',0,buffers(8*1024*1024));await store.spill('overwrite',0,original);const shorterOverwriteMatches=(await store.read('overwrite',0))?.byteLength===original.byteLength;
   const oldMissing=await store.read('old',0)===undefined,otherPreserved=!!await store.read('other',0);
   await store.close();store=new HistoryProbe();await store.open(name);
   let reopenMatches=true;for(let seq=0;seq<20;seq++){const persisted=await store.read('deltas',seq);reopenMatches&&=!!persisted&&persisted.byteLength===delta.byteLength&&new Int32Array(persisted)[0]===1234+seq&&new Int32Array(persisted)[100]===expected(100);}
   const abortedAbsent=await store.read('failure',1)===undefined;
   // Enforce a finite queue budget without detaching the rejected caller data.
   const limited=new HistoryProbe(1024*1024);await limited.open(name);const one=new ArrayBuffer(1024*1024);
   const queued=limited.spill('budget',0,one);let budgetError='';try{await limited.spill('budget',1,one);}catch(e){budgetError=(e as Error).name;}
   const retainedDuringWrite=(await limited.read('budget',0))?.byteLength===one.byteLength;await queued;
   const queueBudget={budgetError,retainedDuringWrite,callerBytes:one.byteLength,hotAfterCommit:limited.hotBytes()};await limited.close();
   const estimateAfter=await navigator.storage.estimate();
   return {cleanupLateRejected,shorterOverwriteMatches,queueBudget,records,deltaBatchMs,deltaBytes:20*delta.byteLength,failures,oldMissing,otherPreserved,reopenMatches,abortedAbsent,estimateBefore,estimateAfter,quotaFaultIsInjected:true};
  }finally{tracking=false;await store.close();await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Cleanup blocked'));});}
 });
 expect(result.cleanupLateRejected).toBe('HistoryCleanupInProgressError');expect(result.shorterOverwriteMatches).toBe(true);
 expect(result.queueBudget).toEqual({budgetError:'HistoryBudgetExceededError',retainedDuringWrite:true,callerBytes:1024*1024,hotAfterCommit:0});
 for(const r of result.records)expect(r.hotBytes).toBe(0);
 for(const f of result.failures){expect(f.caught).toBe(f.fault==='quota'?'QuotaExceededError':'AbortError');expect(f.head).toBe(0);expect(f.retained).toBe(true);}
 expect(result.oldMissing&&result.otherPreserved&&result.reopenMatches&&result.abortedAbsent).toBe(true);
 mkdirSync(resolve('.validation'),{recursive:true});writeFileSync(resolve(`.validation/history-storage-${info.project.name}.json`),JSON.stringify({...provenance(page,info.project.name),...result},null,2));console.log(JSON.stringify(result));
});


test('IndexedDB actual quota failure preserves committed history and RAM fallback',async({page},info)=>{
 test.skip(!process.env.VALIDATE_HISTORY,'Explicit quota validation');test.setTimeout(60000);
 await page.goto('/');const cdp=await page.context().newCDPSession(page),origin=new URL(page.url()).origin;
 const name='simu-history-validation-'+crypto.randomUUID();
 try{
  await cdp.send('Storage.overrideQuotaForOrigin',{origin,quotaSize:1024*1024});
  await page.evaluate(async(name)=>{const path='/tools/validation/idb-history-client.ts';const {HistoryProbe}=await import(path);const store=new HistoryProbe();await store.open(name);await store.spill('quota',0,new ArrayBuffer(4096));(window as any).__historyProbe=store;},name);
  const quotaObserved={cdp:await cdp.send('Storage.getUsageAndQuota',{origin}),estimate:await page.evaluate(()=>navigator.storage.estimate())};console.log(JSON.stringify(quotaObserved));
  const result=await page.evaluate(async(name)=>{
   let store=(window as any).__historyProbe;const array=new Uint32Array(2*1024*1024);let seed=123456789;for(let i=0;i<array.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;array[i]=seed>>>0;}
   let caught='';try{await store.spill('quota',1,array.buffer);}catch(e){caught=(e as Error).name;}
   const head=await store.head('quota'),hotBytes=store.hotBytes(),read=await store.read('quota',1);const retained=!!read&&new Uint32Array(read)[1000]===array[1000];
   await store.close();const path='/tools/validation/idb-history-client.ts';const {HistoryProbe}=await import(path);store=new HistoryProbe();(window as any).__historyProbe=store;await store.open(name);
   const failedAbsent=await store.read('quota',1)===undefined,previous=(await store.read('quota',0))?.byteLength;
   return {caught,head,hotBytes,retained,failedAbsent,previous,quotaBytes:1024*1024,attemptedBytes:array.byteLength};
  },name);
  console.log(JSON.stringify(result));expect(result.caught).toBe('QuotaExceededError');expect(result.head).toBe(0);expect(result.retained&&result.failedAbsent).toBe(true);expect(result.previous).toBe(4096);expect(result.hotBytes).toBe(result.attemptedBytes);
  mkdirSync(resolve('.validation'),{recursive:true});writeFileSync(resolve(`.validation/history-quota-${info.project.name}.json`),JSON.stringify({...provenance(page,info.project.name),quotaObserved,...result},null,2));console.log(JSON.stringify(result));
 }finally{
  await cdp.send('Storage.overrideQuotaForOrigin',{origin});
  await page.evaluate(async(name)=>{await (window as any).__historyProbe?.close();await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Cleanup blocked'));});},name);
  await cdp.detach();
 }
});
