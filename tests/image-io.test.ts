import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ImageIoClient} from '../src/image-io.ts';
import {DEFAULT_PROFILE} from '../src/terrain.ts';
import {decodeHeightmap,exportBmp,exportPng} from '../src/codecs.ts';
import type {ImageIoResponse} from '../src/image-io-protocol.ts';

const limits={maxTiles:67108864,maxFileBytes:268435456};
const file=()=>new File([new Uint8Array([1,2,3])],'map.png');
class FakeWorker extends EventTarget {
  terminated=false;
  readonly sent: {message:any;transfer:unknown}[]=[];
  readonly listeners=new Set<EventListenerOrEventListenerObject>();
  throwOnPost: Error|undefined;
  postMessage(message:unknown,transfer?:unknown){
    if(this.throwOnPost)throw this.throwOnPost;
    this.sent.push({message:structuredClone(message),transfer});
  }
  terminate(){this.terminated=true;}
  override addEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:AddEventListenerOptions|boolean){
    if(callback)this.listeners.add(callback);super.addEventListener(type,callback,options);
  }
  override removeEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:EventListenerOptions|boolean){
    if(callback)this.listeners.delete(callback);super.removeEventListener(type,callback,options);
  }
  emit(data:ImageIoResponse){this.dispatchEvent(new MessageEvent('message',{data}));}
}
function clientWith(...workers:FakeWorker[]){let n=0;return new ImageIoClient({workerFactory:()=>workers[n++] as unknown as Worker});}
const result=(id:number):ImageIoResponse=>({kind:'result',id,operation:'import',result:{map:{width:1,height:1,heights:new Float32Array([0])},changed:0,slopeChanged:0,quantization:{changed:0,outsideRange:0,fractional:0,reachableMin:-12,reachableMax:32},timings:[],arrays:[]}});
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

test('aborting an operation terminates CPU work, removes listeners and ignores late results',async()=>{
  const worker=new FakeWorker(),client=clientWith(worker),abort=new AbortController();let progress=0;
  const promise=client.import(file(),DEFAULT_PROFILE,limits,{signal:abort.signal,onProgress:()=>progress++});
  const id=worker.sent[0].message.id;
  worker.emit({kind:'progress',id,progress:{stage:'decode',elapsedMs:2}});
  const failed=assert.rejects(promise,{name:'AbortError'});abort.abort();await failed;
  assert.equal(worker.terminated,true);assert.equal(worker.listeners.size,0);
  worker.emit(result(id));worker.emit({kind:'progress',id,progress:{stage:'complete',elapsedMs:3}});
  assert.equal(progress,1);
});

test('replacement operations reject stale results and cancelled dimension confirmations never resume work',async()=>{
  const first=new FakeWorker(),second=new FakeWorker(),client=clientWith(first,second);
  let accept:((value:boolean)=>void)|undefined;
  const one=client.import(file(),DEFAULT_PROFILE,limits,{onDimensions:()=>new Promise<boolean>(resolve=>{accept=resolve;})});
  const firstId=first.sent[0].message.id;first.emit({kind:'dimensions',id:firstId,width:4096,height:4096});await turn();
  const rejected=assert.rejects(one,{name:'AbortError'});const two=client.import(file(),DEFAULT_PROFILE,limits);await rejected;
  accept!(true);await turn();assert.equal(first.sent.length,1);assert.equal(first.terminated,true);
  second.emit(result(firstId));assert.equal(second.terminated,false);
  const secondId=second.sent[0].message.id;second.emit(result(secondId));
  const got=await two;assert.equal(got.map.width,1);assert.ok(got.totalMs>=0);assert.equal(second.listeners.size,0);
});

test('dimension acceptance is awaited, rejection aborts, and source heights are cloned without transfer',async()=>{
  const worker=new FakeWorker(),client=clientWith(worker);let dimensions:number[]=[];
  const promise=client.import(file(),DEFAULT_PROFILE,limits,{onDimensions:async(w,h)=>{dimensions=[w,h];return false;}});
  const rejected=assert.rejects(promise,{name:'AbortError'});worker.emit({kind:'dimensions',id:worker.sent[0].message.id,width:8192,height:4096});await rejected;
  assert.deepEqual(dimensions,[8192,4096]);assert.equal(worker.sent.length,1);assert.equal(worker.terminated,true);

  const exported=new FakeWorker(),exportClient=clientWith(exported),map={width:2,height:1,heights:new Float32Array([0,1])};
  const output=exportClient.export(map,DEFAULT_PROFILE,'bmp',limits);
  assert.equal(exported.sent[0].transfer,undefined);assert.notEqual(exported.sent[0].message.map.heights.buffer,map.heights.buffer);
  assert.deepEqual(Array.from(map.heights),[0,1]);assert.equal(map.heights.byteLength,8);
  const error=assert.rejects(output,{name:'AbortError'});exportClient.cancel();await error;
  assert.deepEqual(Array.from(map.heights),[0,1]);
});

test('accepted dimensions resume only their operation and callback errors clean up the worker',async()=>{
  const worker=new FakeWorker(),client=clientWith(worker);
  const promise=client.import(file(),DEFAULT_PROFILE,limits,{onDimensions:async()=>true});
  const id=worker.sent[0].message.id;worker.emit({kind:'dimensions',id,width:1,height:1});await turn();
  assert.deepEqual(worker.sent[1].message,{kind:'dimensions-accepted',id});worker.emit(result(id));await promise;
  const bad=new FakeWorker(),badClient=clientWith(bad),failure=new Error('progress UI failed');
  const failed=badClient.import(file(),DEFAULT_PROFILE,limits,{onProgress:()=>{throw failure;}});
  const rejected=assert.rejects(failed,error=>error===failure);bad.emit({kind:'progress',id:bad.sent[0].message.id,progress:{stage:'decode',elapsedMs:1}});await rejected;
  assert.equal(bad.terminated,true);assert.equal(bad.listeners.size,0);
});

test('timeout, worker error, message decoding and postMessage failure all terminate cleanly',async()=>{
  const timeoutWorker=new FakeWorker(),timeoutClient=new ImageIoClient({workerFactory:()=>timeoutWorker as unknown as Worker,timeoutMs:5});
  await assert.rejects(timeoutClient.import(file(),DEFAULT_PROFILE,limits),/タイムアウト/);assert.equal(timeoutWorker.terminated,true);assert.equal(timeoutWorker.listeners.size,0);
  for(const type of ['error','messageerror']){
    const worker=new FakeWorker(),client=clientWith(worker),promise=client.import(file(),DEFAULT_PROFILE,limits);
    const rejected=assert.rejects(promise);worker.dispatchEvent(new Event(type,{cancelable:true}));await rejected;
    assert.equal(worker.terminated,true);assert.equal(worker.listeners.size,0);
  }
  const broken=new FakeWorker();broken.throwOnPost=new Error('clone failed');
  await assert.rejects(clientWith(broken).import(file(),DEFAULT_PROFILE,limits),/clone failed/);assert.equal(broken.terminated,true);assert.equal(broken.listeners.size,0);
  const abort=new AbortController();abort.abort();let constructed=false;
  const client=new ImageIoClient({workerFactory:()=>{constructed=true;return broken as unknown as Worker;}});
  await assert.rejects(client.import(file(),DEFAULT_PROFILE,limits,{signal:abort.signal}),{name:'AbortError'});assert.equal(constructed,false);
});

test('PNG, BMP and PPM dimension callbacks stop before full pixel decode',async()=>{
  const map={width:2,height:3,heights:new Float32Array(6)},png=await exportPng(map,DEFAULT_PROFILE);
  const headers=[png.subarray(0,33),exportBmp(map,DEFAULT_PROFILE).subarray(0,54),new TextEncoder().encode('P6\n2 3\n255\n')];
  for(const bytes of headers){
    const reason=new Error('dimensions only');let found:number[]=[];
    await assert.rejects(decodeHeightmap(bytes,DEFAULT_PROFILE,(w,h)=>{found=[w,h];throw reason;}),error=>error===reason);
    assert.deepEqual(found,[2,3]);
  }
});
