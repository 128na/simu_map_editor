export interface HistoryStore {
  put(key:string,buffer:ArrayBuffer):Promise<void>;
  get(key:string):Promise<ArrayBuffer|undefined>;
  delete(keys:string[]):Promise<void>;
  dispose():Promise<void>;
}
/** One temporary, tab-isolated history session. Input buffers remain owned by the caller. */
export class BrowserHistoryStore implements HistoryStore {
  private readonly worker:Worker;
  private serial=0;
  private failed:Error|undefined;
  private closed=false;
  private closing:Promise<void>|undefined;
  private readonly pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private readonly ready:Promise<void>;
  constructor() {
    this.worker=new Worker(new URL('./history-worker.ts',import.meta.url),{type:'module'});
    this.worker.onmessage=({data})=>{
      const entry=this.pending.get(data.id);if(!entry)return;
      clearTimeout(entry.timer);this.pending.delete(data.id);
      if(data.error){const error=new Error(data.error.message);error.name=data.error.name;entry.reject(error);}else entry.resolve(data.value);
    };
    this.worker.onerror=(event)=>{event.preventDefault();this.fail(new Error(event.message||'History worker failed'));};
    this.worker.onmessageerror=()=>this.fail(new Error('History worker message could not be decoded'));
    this.ready=this.rpc('open',{session:crypto.randomUUID()});
    // Initialization may fail before the first edit. Keep the rejected promise observable by API calls.
    void this.ready.catch(()=>{});
  }
  private fail(error:Error):void {
    this.failed??=error;this.worker.terminate();
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(this.failed);}this.pending.clear();
  }
  private rpc(op:string,args:Record<string,unknown>={}):Promise<any> {
    if(this.failed)return Promise.reject(this.failed);
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error('History storage timed out')),120000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({id,op,...args});}catch(error){this.fail(error instanceof Error?error:new Error(String(error)));}
    });
  }
  private async request(op:string,args:Record<string,unknown>={}):Promise<any> {
    if(this.closed)throw new Error('History storage is closed');
    await this.ready;
    // Calls accepted before dispose are sent before its close RPC through promise order.
    return this.rpc(op,args);
  }
  async put(key:string,buffer:ArrayBuffer):Promise<void>{await this.request('put',{key,buffer});}
  async get(key:string):Promise<ArrayBuffer|undefined>{return this.request('get',{key});}
  async delete(keys:string[]):Promise<void>{await this.request('delete',{keys});}
  dispose():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;
    this.closing=(async()=>{try{await this.ready;await this.rpc('close');}finally{this.worker.terminate();}})();
    return this.closing;
  }
}
