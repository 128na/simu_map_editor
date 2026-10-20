import {test,expect} from '@playwright/test';

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
