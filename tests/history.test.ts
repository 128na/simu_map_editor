import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBrushIncremental,DEFAULT_PROFILE,proveLocalHistoryMap,toGrid,type Heightmap} from '../src/terrain.ts';
import { AsyncHistory, createPatch, type HistoryStore } from '../src/history.ts';
const map = (...values: number[]): Heightmap => ({width: values.length, height: 1, heights: Float32Array.from(values)});
const patch = (a: number[], b: number[]) => createPatch(map(...a), map(...b))!;
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; }
class Store implements HistoryStore {
  data = new Map<string, ArrayBuffer>(); putGate?: Promise<void>; getGate?: Promise<void>; fail = false;
  async put(key: string, value: ArrayBuffer) { await this.putGate; if(this.fail) throw new Error('quota'); this.data.set(key, value.slice(0)); }
  async get(key: string) { await this.getGate; return this.data.get(key)?.slice(0); }
  async delete(keys: string[]) { keys.forEach(k => this.data.delete(k)); }
  async dispose() { this.data.clear(); }
}
test('patch hints deduplicate actual differences and own their values', () => {
  const a = map(0,1,2), b = map(1,1,3), p = createPatch(a,b,[2,0,2,1])!;
  assert.deepEqual([...p.indices],[0,2]); a.heights[0]=8; b.heights[2]=9;
  assert.deepEqual([...p.before],[0,2]); assert.deepEqual([...p.after],[1,3]);
  assert.equal(createPatch(map(1),map(1)),null);
  assert.throws(() => createPatch(a,b,[3]));
});
test('record is synchronous, pending Undo works, stored Undo and Redo restore exactly', async () => {
  const store = new Store(), pending = gate(); store.putGate = pending.promise;
  const h = new AsyncHistory(store); let current = map(1,0);
  h.record(patch([0,0],[1,0])); assert.equal(h.getState().undoCount,1); assert.ok(h.getState().queuedBytes);
  await h.undo(current,n => {current=n;}); assert.deepEqual([...current.heights],[0,0]);
  pending.resolve(); await h.settled(); assert.equal(h.getState().queuedBytes,0);
  await h.redo(current,n => {current=n;}); assert.deepEqual([...current.heights],[1,0]);
  await h.undo(current,n => {current=n;}); assert.deepEqual([...current.heights],[0,0]);
});
test('read lock rejects overlap, record and reset; failed renderer preserves cursor', async () => {
  const store = new Store(), h = new AsyncHistory(store); h.record(patch([0],[1])); await h.settled();
  const pending = gate(); store.getGate = pending.promise;
  const undo = h.undo(map(1),()=>{}); assert.equal(h.getState().reading,true);
  assert.throws(()=>h.record(patch([1],[2]))); assert.throws(()=>h.reset());
  await assert.rejects(h.redo(map(1),()=>{})); pending.resolve(); await undo;
  await assert.rejects(h.redo(map(0),()=>{throw new Error('renderer');})); assert.equal(h.getState().redoCount,1);
});
test('branch while pending removes stale records even after delayed writes', async () => {
  const store = new Store(), pending = gate(); store.putGate = pending.promise;
  const h = new AsyncHistory(store); h.record(patch([0],[1])); await Promise.resolve();
  await h.undo(map(1),()=>{}); h.record(patch([0],[2])); pending.resolve(); await h.settled();
  assert.equal(store.data.size,1); assert.equal(h.getState().redoCount,0);
  let result = map(2); await h.undo(result,n=>{result=n;}); assert.equal(result.heights[0],0);
});
test('quota failure retains hot Undo and blocks new records', async () => {
  const store = new Store(); store.fail=true; const errors: Error[]=[];
  const h = new AsyncHistory(store,{onError:e=>errors.push(e)}); h.record(patch([0],[1])); await h.settled();
  assert.equal(h.getState().failed,true); assert.ok(h.getState().queuedBytes); assert.equal(errors.length,1);
  assert.throws(()=>h.record(patch([1],[2]))); let restored=map(1);
  await h.undo(restored,n=>{restored=n;}); assert.equal(restored.heights[0],0);
  h.reset(); assert.equal(h.getState().failed,false);
});
test('reset ignores old generation failures and cleans storage', async () => {
  const store = new Store(), pending=gate(); store.putGate=pending.promise; store.fail=true;
  const h=new AsyncHistory(store); h.record(patch([0],[1])); await Promise.resolve(); h.reset();
  pending.resolve(); await h.settled(); assert.equal(h.getState().failed,false); assert.equal(store.data.size,0);
  store.fail=false; h.record(patch([2],[3])); await h.settled(); assert.equal(h.getState().undoCount,1);
});
test('RAM, disk and entry budget rejection leaves Redo and existing history intact', async () => {
  for (const options of [{ramBudgetBytes:32},{diskBudgetBytes:32},{maxEntries:1}]) {
    const store=new Store(), pending=gate(); store.putGate=pending.promise; const h=new AsyncHistory(store,options);
    h.record(patch([0],[1])); assert.throws(()=>h.record(patch([1],[2]))); assert.equal(h.getState().undoCount,1);
    await h.undo(map(1),()=>{});
    if (!("maxEntries" in options)) { assert.throws(()=>h.record(patch([0,0],[1,1]))); assert.equal(h.getState().redoCount,1); }
    pending.resolve(); await h.settled();
  }
});
test('missing, malformed and mismatched records never advance history',async()=>{
  const store=new Store(), h=new AsyncHistory(store); h.record(patch([0],[1])); await h.settled();
  const key=[...store.data.keys()][0], valid=store.data.get(key)!;
  store.data.delete(key); await assert.rejects(h.undo(map(1),()=>{}));
  store.data.set(key,new ArrayBuffer(20)); await assert.rejects(h.undo(map(1),()=>{}));
  store.data.set(key,valid); await assert.rejects(h.undo(map(9),()=>{}));
  assert.equal(h.getState().undoCount,1); assert.equal(h.getState().reading,false);
});

test('background writes are serial and reset releases failed hot bytes', async () => {
  const store=new Store(), pending=gate(); store.putGate=pending.promise;
  let active=0, peak=0, writes=0; const original=store.put.bind(store);
  store.put=async(key,value)=>{active++;peak=Math.max(peak,active);writes++;try{await original(key,value);}finally{active--;}};
  const h=new AsyncHistory(store); h.record(patch([0],[1])); h.record(patch([1],[2])); await Promise.resolve();
  assert.equal(writes,1); pending.resolve(); await h.settled(); assert.equal(writes,2);assert.equal(peak,1);
  store.fail=true; h.record(patch([2],[3])); await h.settled(); assert.ok(h.getState().queuedBytes);
  h.reset(); await h.settled(); assert.equal(h.getState().queuedBytes,0); assert.equal(store.data.size,0);
  await h.dispose(); assert.throws(()=>h.record(patch([0],[1])));
});
test('branch cleanup commits before replacement write, keeping physical payload within budget',async()=>{
  const store=new Store(), events:string[]=[];
  const originalPut=store.put.bind(store), originalDelete=store.delete.bind(store);
  store.put=async(key,value)=>{events.push('put');await originalPut(key,value);assert.ok([...store.data.values()].reduce((n,b)=>n+b.byteLength,0)<=32);};
  store.delete=async(keys)=>{events.push('delete');await originalDelete(keys);};
  const h=new AsyncHistory(store,{diskBudgetBytes:32});h.record(patch([0],[1]));await h.settled();
  await h.undo(map(1),()=>{});events.length=0;h.record(patch([0],[2]));await h.settled();
  assert.deepEqual(events,['delete','put']);assert.equal(h.getState().failed,false);
});
test('branch cleanup failure stops queued writes and retains replacement hot Undo',async()=>{
  const store=new Store(), errors:Error[]=[];const h=new AsyncHistory(store,{onError:e=>errors.push(e)});
  h.record(patch([0],[1]));await h.settled();await h.undo(map(1),()=>{});
  store.delete=async()=>{throw new Error('delete failed');};h.record(patch([0],[2]));await h.settled();
  assert.equal(store.data.size,1);assert.equal(h.getState().failed,true);assert.equal(h.getState().queuedBytes,32);assert.equal(errors.length,1);
  let current=map(2);await h.undo(current,n=>{current=n;});assert.equal(current.heights[0],0);
});
test('old generation cleanup failure does not stop new generation writes',async()=>{
  const store=new Store(), errors:Error[]=[];const h=new AsyncHistory(store,{onError:e=>errors.push(e)});
  h.record(patch([0],[1]));await h.settled();store.delete=async()=>{throw new Error('old delete failed');};
  h.reset();h.record(patch([4],[5]));await h.settled();assert.equal(h.getState().failed,false);assert.equal(h.getState().queuedBytes,0);assert.equal(errors.length,0);
});


test('history callbacks receive exact changed indices for pending and stored moves before cursor commit',async()=>{
 const store=new Store(),pending=gate();store.putGate=pending.promise;
 const history=new AsyncHistory(store),original=map(0,0,0);let current=map(1,0,2);
 history.record(createPatch(original,current)!);
 const seen:{indices:number[];undoCount:number}[]=[];
 await history.undo(current,(next,indices)=>{seen.push({indices:[...indices],undoCount:history.getState().undoCount});assert.notEqual(next.heights,current.heights);assert.deepEqual([...current.heights],[1,0,2]);current=next;});
 pending.resolve();await history.settled();
 await history.redo(current,(next,indices)=>{seen.push({indices:[...indices],undoCount:history.getState().undoCount});current=next;});
 assert.deepEqual(seen,[{indices:[0,2],undoCount:1},{indices:[0,2],undoCount:0}]);
 const saved=current;
 await assert.rejects(history.undo(current,(next,indices)=>{assert.deepEqual([...indices],[0,2]);next.heights[1]=9;throw new Error('renderer failed');}),/renderer failed/);
 assert.deepEqual([...saved.heights],[1,0,2]);assert.equal(history.getState().undoCount,1);assert.equal(history.getState().reading,false);
});

test('first-stroke Undo and Redo fall back for raw sources instead of applying source-plus-one',async()=>{
 for(const value of [.5,100,20]){
  const p={...DEFAULT_PROFILE,mode:'clamp' as const};
  const original:Heightmap={width:17,height:11,heights:new Float32Array(17*11)};original.heights[0]=value;
  const originalGrid=toGrid(original,p);
  const edited=applyBrushIncremental(original,p,{x:4,y:3,radius:2,amount:3,tool:'raise'});
  assert.equal(edited.incremental,false);const editedGrid=toGrid(edited.map,p);
  const history=new AsyncHistory(new Store());history.record(createPatch(original,edited.map)!);await history.settled();let current=edited.map,grid=editedGrid;
  const decisions:boolean[]=[];
  const restore=(next:Heightmap,indices:Uint32Array)=>{
   const incremental=proveLocalHistoryMap(current,next,p,indices);decisions.push(incremental);
   assert.equal(incremental,false);current=next;grid=toGrid(next,p);
  };
  await history.undo(current,restore);assert.deepEqual(current.heights,original.heights);assert.deepEqual(grid,originalGrid);
  assert.ok(grid.some((v,i)=>v!==current.heights[Math.min(Math.floor(i/(current.width+1)),current.height-1)*current.width+Math.min(i%(current.width+1),current.width-1)]+1));
  await history.redo(current,restore);assert.deepEqual(current.heights,edited.map.heights);assert.deepEqual(grid,editedGrid);
  assert.deepEqual(decisions,[false,false]);
 }
});
