/// <reference lib="webworker" />
export {};
const context=self as unknown as DedicatedWorkerGlobalScope;
const DB_NAME='app-simu-map-history-v1',CHUNK_BYTES=4*1024*1024;
let database:IDBDatabase|undefined,session='',unlock:(()=>void)|undefined;
function lockName(id:string):string{return `${DB_NAME}:${id}`;}
function transaction(stores:string[],mode:IDBTransactionMode,body:(tx:IDBTransaction)=>void):Promise<void>{
  return new Promise((resolve,reject)=>{
    const tx=database!.transaction(stores,mode);
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('History transaction aborted'));tx.onerror=()=>{};
    try{body(tx);}catch(error){tx.abort();reject(error);}
  });
}
function range(id:string):IDBKeyRange{return IDBKeyRange.bound([id],[id,[]]);}
async function clearSession(id:string):Promise<void>{
  await transaction(['chunks','manifests','sessions'],'readwrite',tx=>{
    tx.objectStore('chunks').delete(range(id));tx.objectStore('manifests').delete(range(id));tx.objectStore('sessions').delete(id);
  });
}
async function open(id:string):Promise<void>{
  session=id;
  // Keep the lock until all own-session transactions have completed. A crashed worker releases it automatically.
  if(navigator.locks){
    await new Promise<void>((resolve,reject)=>{
      void navigator.locks.request(lockName(session),async()=>{resolve();await new Promise<void>(release=>{unlock=release;});}).catch(reject);
    });
  }
  database=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('chunks',{keyPath:['session','key','chunk']});request.result.createObjectStore('manifests',{keyPath:['session','key']});request.result.createObjectStore('sessions',{keyPath:'session'});};
    request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('History database is blocked'));
    request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
  });
  await transaction(['sessions'],'readwrite',tx=>{tx.objectStore('sessions').put({session,createdAt:Date.now()});});
  if(navigator.locks){
    let ids:string[]=[];
    await transaction(['sessions'],'readonly',tx=>{const req=tx.objectStore('sessions').getAllKeys();req.onsuccess=()=>{ids=req.result as string[];};});
    for(const id of ids)if(id!==session)await navigator.locks.request(lockName(id),{ifAvailable:true},async lock=>{if(lock)await clearSession(id);});
  }
}
async function execute(message:any):Promise<unknown>{
  if(message.op==='open'){await open(message.session);return;}
  if(!database)throw new Error('History database is closed');
  const key=message.key as string;
  if(message.op==='put'){
    const buffer=message.buffer as ArrayBuffer,count=Math.ceil(buffer.byteLength/CHUNK_BYTES);
    await transaction(['chunks','manifests'],'readwrite',tx=>{
      const chunks=tx.objectStore('chunks');chunks.delete(IDBKeyRange.bound([session,key],[session,key,[]]));
      for(let chunk=0;chunk<count;chunk++)chunks.put({session,key,chunk,buffer:buffer.slice(chunk*CHUNK_BYTES,Math.min(buffer.byteLength,(chunk+1)*CHUNK_BYTES))});
      tx.objectStore('manifests').put({session,key,count,bytes:buffer.byteLength});
    });return;
  }
  if(message.op==='get'){
    let manifest:{count:number;bytes:number}|undefined,chunks:{chunk:number;buffer:ArrayBuffer}[]=[];
    await transaction(['chunks','manifests'],'readonly',tx=>{
      const meta=tx.objectStore('manifests').get([session,key]);meta.onsuccess=()=>{manifest=meta.result;};
      const req=tx.objectStore('chunks').getAll(IDBKeyRange.bound([session,key],[session,key,[]]));req.onsuccess=()=>{chunks=req.result;};
    });
    if(!manifest)return undefined;
    if(chunks.length!==manifest.count)throw new Error('History chunks are missing');
    const result=new Uint8Array(manifest.bytes);let offset=0;
    for(let i=0;i<chunks.length;i++){if(chunks[i].chunk!==i)throw new Error('History chunks are invalid');const bytes=new Uint8Array(chunks[i].buffer);result.set(bytes,offset);offset+=bytes.byteLength;}
    if(offset!==manifest.bytes)throw new Error('History size is invalid');return result.buffer;
  }
  if(message.op==='delete'){
    await transaction(['chunks','manifests'],'readwrite',tx=>{for(const key of message.keys as string[]){tx.objectStore('chunks').delete(IDBKeyRange.bound([session,key],[session,key,[]]));tx.objectStore('manifests').delete([session,key]);}});return;
  }
  if(message.op==='close'){
    try{await clearSession(session);}finally{database.close();database=undefined;unlock?.();unlock=undefined;}return;
  }
  throw new Error('Unknown history operation');
}
// Message arrival order also orders close, pending writes, and deletion after a redo branch.
let queue=Promise.resolve();
context.onmessage=({data})=>{
  queue=queue.then(async()=>{
    try{const value=await execute(data);context.postMessage({id:data.id,value},value instanceof ArrayBuffer?[value]:[]);}
    catch(error){const detail=error instanceof Error?error:new Error(String(error));context.postMessage({id:data.id,error:{name:detail.name,message:detail.message}});}
  });
};
