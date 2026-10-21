import {test,expect} from '@playwright/test';

test('production history worker preserves persisted records when a multi-chunk write aborts midway',async({page})=>{
  let instrumented=0;
  await page.route(/\/src\/history-worker\.ts(?:\?.*)?$/,async route=>{
    const response=await route.fetch();
    const fault=`
      const originalPut=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value,...args){
        const request=originalPut.call(this,value,...args);
        if(this.name==='chunks'&&value.key.startsWith('atomic-')&&value.chunk===1&&new Uint8Array(value.buffer)[0]===239){
          request.addEventListener('success',()=>{
            // Fail after two actual chunk writes, rather than before the backend is called.
            this.transaction.abort();
            self.postMessage({atomicWriteAborted:true,key:value.key});
          },{once:true});
        }
        return request;
      };
    `;
    instrumented++;
    await route.fulfill({response,body:fault+await response.text(),contentType:'application/javascript'});
  });
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const modulePath='/src/history-store.ts';const {BrowserHistoryStore}=await import(modulePath);
    const store=new BrowserHistoryStore(),size=9*1024*1024+17;
    const original=new Uint8Array(size);for(let i=0;i<size;i++)original[i]=(i*7+3)%251;
    const replacement=new Uint8Array(size+31).fill(239);
    const aborted:string[]=[];
    // Observe only the test instrumentation's notification; all operations still use BrowserHistoryStore.
    (store as any).worker.addEventListener('message',({data}:MessageEvent)=>{if(data.atomicWriteAborted)aborted.push(data.key);});
    const raw=async()=>{
      const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('app-simu-map-history-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      try{return await new Promise<{chunks:{key:string;chunk:number;bytes:number}[];manifests:{key:string;count:number;bytes:number}[]}>((resolve,reject)=>{
        const tx=db.transaction(['chunks','manifests'],'readonly');
        const chunks=tx.objectStore('chunks').getAll(),manifests=tx.objectStore('manifests').getAll();
        tx.oncomplete=()=>resolve({chunks:chunks.result.filter(v=>v.key.startsWith('atomic-')).map(v=>({key:v.key,chunk:v.chunk,bytes:v.buffer.byteLength})),manifests:manifests.result.filter(v=>v.key.startsWith('atomic-')).map(v=>({key:v.key,count:v.count,bytes:v.bytes}))});
        tx.onabort=()=>reject(tx.error);
      });}finally{db.close();}
    };
    try{
      await store.put('atomic-overwrite',original.buffer);const persistedBefore=await raw();
      const failures:string[]=[];
      for(const key of ['atomic-overwrite','atomic-new']){
        try{await store.put(key,replacement.buffer);failures.push('unexpected success');}catch(error){failures.push(String(error));}
      }
      const persistedAfter=await raw();
      const restored=new Uint8Array((await store.get('atomic-overwrite'))!);
      const same=restored.length===original.length&&restored.every((value,i)=>value===original[i]);
      const missing=await store.get('atomic-new')===undefined;
      await store.put('healthy',new Uint8Array([7,8,9]).buffer);
      const healthy=Array.from(new Uint8Array((await store.get('healthy'))!));
      return {same,missing,healthy,failures,aborted,persistedBefore,persistedAfter,retained:replacement.byteLength};
    }finally{await store.dispose();}
  });
  expect(instrumented).toBeGreaterThan(0);
  expect(result.aborted).toEqual(['atomic-overwrite','atomic-new']);
  expect(result.failures).toHaveLength(2);for(const failure of result.failures)expect(failure).toMatch(/abort/i);
  expect(result.same).toBe(true);expect(result.missing).toBe(true);
  expect(result.persistedAfter).toEqual(result.persistedBefore);
  expect(result.persistedBefore.chunks).toHaveLength(3);
  expect(result.persistedBefore.manifests).toEqual([{key:'atomic-overwrite',count:3,bytes:9*1024*1024+17}]);
  expect(result.healthy).toEqual([7,8,9]);expect(result.retained).toBe(9*1024*1024+48);
});

test('IndexedDB history chunks round-trip, overwrite atomically and retain caller buffers',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const modulePath='/src/history-store.ts';const {BrowserHistoryStore}=await import(modulePath);
    const store=new BrowserHistoryStore();const bytes=new Uint8Array(9*1024*1024+17);
    for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
    try{
      const put=store.put('large',bytes.buffer);const retained=bytes.byteLength;await put;
      const got=new Uint8Array((await store.get('large'))!);let same=got.length===bytes.length;
      for(let i=0;i<got.length;i++)if(got[i]!==bytes[i]){same=false;break;}
      await store.put('large',new Uint8Array([7,8,9]).buffer);
      const replacement=Array.from(new Uint8Array((await store.get('large'))!));
      await store.put('zero',new ArrayBuffer(0));const zero=(await store.get('zero'))!.byteLength;
      await store.delete(['large','zero']);return {same,retained,replacement,zero,missing:await store.get('large')===undefined};
    }finally{await store.dispose();}
  });
  expect(result).toEqual({same:true,retained:9*1024*1024+17,replacement:[7,8,9],zero:0,missing:true});
});

test('IndexedDB history sessions survive other tabs cleanup and dispose waits for accepted writes',async({page,context})=>{
  await page.goto('/');const second=await context.newPage();await second.goto('/');
  await page.evaluate(async()=>{const path='/src/history-store.ts';const {BrowserHistoryStore}=await import(path);(window as any).store=new BrowserHistoryStore();await(window as any).store.put('same',new Uint8Array([1]).buffer);});
  await second.evaluate(async()=>{const path='/src/history-store.ts';const {BrowserHistoryStore}=await import(path);const store=new BrowserHistoryStore();await store.put('same',new Uint8Array([2]).buffer);await store.dispose();});
  expect(await page.evaluate(async()=>Array.from(new Uint8Array(await(window as any).store.get('same'))))).toEqual([1]);
  const result=await page.evaluate(async()=>{
    const store=(window as any).store;const put=store.put('pending',new Uint8Array([3]).buffer);const close=store.dispose();await Promise.all([put,close]);
    try{await store.get('same');return false;}catch{return true;}
  });expect(result).toBe(true);
});
