/** Experimental spill coordinator; not used by the editor. */
export class HistoryProbe{
 private worker=new Worker(new URL('./idb-history-worker.ts',import.meta.url),{type:'module'});
 private id=0;
 private waits=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 private queue:Promise<unknown>=Promise.resolve();
 private hot=new Map<string,ArrayBuffer>();
 private pendingKeys=new Set<string>();
 private clearing=new Set<string>();
 constructor(private maxHotBytes=512*1024*1024){
  this.worker.onmessage=({data})=>{const pending=this.waits.get(data.id);if(!pending)return;this.waits.delete(data.id);if(data.error)pending.reject(Object.assign(new Error(data.error.message),{name:data.error.name}));else pending.resolve(data.value);};
  this.worker.onerror=event=>{for(const pending of this.waits.values())pending.reject(new Error(event.message));this.waits.clear();};
 }
 private rpc(op:string,data:Record<string,unknown>={},transfer:Transferable[]=[]):Promise<any>{return new Promise((resolve,reject)=>{const id=++this.id;this.waits.set(id,{resolve,reject});this.worker.postMessage({id,op,...data},transfer);});}
 open(name:string){if(!name.startsWith('simu-history-validation-'))throw new Error('Validation database only');return this.rpc('open',{name});}
 spill(session:string,seq:number,buffer:ArrayBuffer,fault?:'abort'|'quota'){
  const key=JSON.stringify([session,seq]);
  if(this.clearing.has(session))return Promise.reject(Object.assign(new Error('History session cleanup is pending'),{name:'HistoryCleanupInProgressError'}));
  if(this.pendingKeys.has(key))return Promise.reject(new Error('History entry already queued'));
  if(this.hotBytes()-(this.hot.get(key)?.byteLength??0)+buffer.byteLength>this.maxHotBytes)return Promise.reject(Object.assign(new Error('Queued history exceeds RAM budget'),{name:'HistoryBudgetExceededError'}));
  this.hot.set(key,buffer);this.pendingKeys.add(key);
  const operation=this.queue.then(async()=>{const started=performance.now(),copy=buffer.slice(0);const pending=this.rpc('put',{session,seq,buffer:copy,fault},[copy]);const preparationMs=performance.now()-started;return {...await pending,preparationMs};});
  this.queue=operation.catch(()=>{});
  return operation.then(value=>{if(this.hot.get(key)===buffer)this.hot.delete(key);return value;}).finally(()=>this.pendingKeys.delete(key));
 }
 async read(session:string,seq:number):Promise<ArrayBuffer|undefined>{const hot=this.hot.get(JSON.stringify([session,seq]));return hot?hot.slice(0):this.rpc('get',{session,seq});}
 head(session:string){return this.rpc('head',{session});}
 clear(session:string){if(this.clearing.has(session))return Promise.reject(new Error('Cleanup already pending'));this.clearing.add(session);const operation=this.queue.then(()=>this.rpc('clear',{session})).then(()=>{for(const key of this.hot.keys())if(JSON.parse(key)[0]===session)this.hot.delete(key);}).finally(()=>this.clearing.delete(session));this.queue=operation.catch(()=>{});return operation;}
 hotBytes(){let bytes=0;for(const buffer of this.hot.values())bytes+=buffer.byteLength;return bytes;}
 async close(){await this.queue;await this.rpc('close');this.worker.terminate();}
}
