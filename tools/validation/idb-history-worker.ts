/// <reference lib="webworker" />
export {};
const ctx=self as unknown as DedicatedWorkerGlobalScope;
let database:IDBDatabase|undefined;
function open(name:string):Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 const request=indexedDB.open(name,1);
 request.onupgradeneeded=()=>{request.result.createObjectStore('entries',{keyPath:['session','seq','chunk']});request.result.createObjectStore('head');request.result.createObjectStore('manifests',{keyPath:['session','seq']});};
 request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('IndexedDB open blocked'));
 request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
});}
ctx.onmessage=async({data:m})=>{
 const start=performance.now();
 try{
  if(m.op==='open'){database=await open(m.name);ctx.postMessage({id:m.id,value:true});return;}
  if(!database)throw new Error('Database not open');
  if(m.op==='close'){database.close();database=undefined;ctx.postMessage({id:m.id,value:true});return;}
  if(m.op==='put'){
   const db=database;
   await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['entries','head','manifests'],'readwrite');let injected:Error|undefined;
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(injected??tx.error??new Error('Transaction aborted'));tx.onerror=()=>{};
    const entries=tx.objectStore('entries'),head=tx.objectStore('head'),manifests=tx.objectStore('manifests');
    entries.delete(IDBKeyRange.bound([m.session,m.seq,0],[m.session,m.seq,Number.MAX_SAFE_INTEGER]));
    const chunkBytes=4*1024*1024,count=Math.ceil(m.buffer.byteLength/chunkBytes);let last:IDBRequest|undefined;
    for(let chunk=0;chunk<count;chunk++)last=entries.put({session:m.session,seq:m.seq,chunk,buffer:m.buffer.slice(chunk*chunkBytes,Math.min(m.buffer.byteLength,(chunk+1)*chunkBytes))});
    manifests.put({session:m.session,seq:m.seq,count,bytes:m.buffer.byteLength});head.put(m.seq,m.session);
    if(last)last.onsuccess=()=>{
     if(m.fault){injected=m.fault==='quota'?new DOMException('Injected quota failure (not actual disk exhaustion)','QuotaExceededError'):new DOMException('Injected abort after request success','AbortError');tx.abort();}
    };
   });
   ctx.postMessage({id:m.id,value:{workerMs:performance.now()-start,bytes:m.buffer.byteLength}});return;
  }
  if(m.op==='get'){
   const value=await new Promise<ArrayBuffer|undefined>((resolve,reject)=>{
    const tx=database!.transaction(['entries','manifests'],'readonly');let chunks:any[]=[],manifest:any;
    const req=tx.objectStore('entries').getAll(IDBKeyRange.bound([m.session,m.seq,0],[m.session,m.seq,Number.MAX_SAFE_INTEGER]));req.onsuccess=()=>chunks=req.result;
    const meta=tx.objectStore('manifests').get([m.session,m.seq]);meta.onsuccess=()=>manifest=meta.result;
    tx.oncomplete=()=>{
     if(!manifest){resolve(undefined);return;}
     if(chunks.length!==manifest.count){reject(new Error('Missing history chunks'));return;}
     const result=new Uint8Array(manifest.bytes);let offset=0;
     for(let i=0;i<chunks.length;i++){if(chunks[i].chunk!==i){reject(new Error('Invalid history chunk'));return;}const bytes=new Uint8Array(chunks[i].buffer);result.set(bytes,offset);offset+=bytes.byteLength;}
     if(offset!==manifest.bytes){reject(new Error('Invalid history size'));return;}resolve(result.buffer);
    };tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};
   });ctx.postMessage({id:m.id,value},value?[value]:[]);return;
  }
  if(m.op==='head'){
   const value=await new Promise<any>((resolve,reject)=>{const tx=database!.transaction('head','readonly');let result:any;const req=tx.objectStore('head').get(m.session);req.onsuccess=()=>result=req.result;tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});
   ctx.postMessage({id:m.id,value});return;
  }
  if(m.op==='clear'){
   await new Promise<void>((resolve,reject)=>{
    const tx=database!.transaction(['entries','head','manifests'],'readwrite');
    tx.objectStore('entries').delete(IDBKeyRange.bound([m.session,0,0],[m.session,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]));tx.objectStore('manifests').delete(IDBKeyRange.bound([m.session,0],[m.session,Number.MAX_SAFE_INTEGER]));tx.objectStore('head').delete(m.session);
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};
   });ctx.postMessage({id:m.id,value:true});return;
  }
  throw new Error('Unknown operation');
 }catch(error){ctx.postMessage({id:m.id,error:{name:(error as Error).name,message:m.op+' bytes='+m.buffer?.byteLength+': '+String(error)+' '+(error as Error).stack}});}
};
