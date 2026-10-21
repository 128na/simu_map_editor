import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEFAULT_PROFILE, LIMITS, decodeSample, toGrid, applyBrush, applyBrushIncremental, createBrushSession, type DirtyBounds, quantizationReport, normalizeImport, validateDimensions, type Heightmap, type Profile } from './terrain';
import { importHeightmap, exportBmp, exportPng } from './codecs';
import { WaterSurface } from './water-surface';
import {waterGeometryBudget} from './water';
import { intersectTerrain } from './picking';
import { TerrainSurface } from './terrain-surface';
import { prepareGridPatch } from './grid-patch';
import { AsyncHistory, createPatch, HistoryBudgetError, type HistoryOptions, type HistoryStore } from './history';
import { BrowserHistoryStore } from './history-store';
import { addTileGrid } from './grid-material';
import { COMPATIBILITY_TARGET, PROFILE_PRESETS, encodingKey, validateEditorProfile } from './compatibility';
import { largeMapWarning } from './resources';
import { editorLayout } from './editor-layout';
import { installEditorInput } from './editor-input';
import { loadPreferences, savePreferences } from './preferences';
import {loadEditorSettings,saveEditorSettings,validateSettings,type EditorSettings} from './editor-settings';
import {DemandRenderer} from './demand-renderer';
import './style.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = editorLayout;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const viewport = el<HTMLDivElement>('viewport');
let profile: Profile = { ...DEFAULT_PROFILE };
let map: Heightmap = { width:128, height:128, heights:new Float32Array(128*128) };
let documentName='新規マップ';
let exportName='simutrans-heightmap.bmp';
let preferences=loadPreferences();
let settings=loadEditorSettings();
LIMITS.maxTiles=settings.maxTiles;LIMITS.maxFileBytes=settings.maxFileMiB*1048576;
preferences.radius=Math.min(preferences.radius,settings.maxBrushRadius);
const gridEnabled={value:preferences.grid??false};
const gridOffset={value:new THREE.Vector2(map.width/2,map.height/2)};
let grid: Int16Array;
let hoverScreen:{clientX:number;clientY:number}|null=null;
let history:AsyncHistory;
let historyPaused=false,waitingForDrain=false,memoryHistory=false;
let historyFault:{putDelayMs?:number;readDelayMs?:number;failPut?:boolean;failRead?:boolean}={};
let revisionSerial=0,revisions=[0],savedRevision=0,savedEncoding=encodingKey(profile);
const revision=()=>revisions[history?.getState().undoCount??0];
const hasUnsavedChanges=()=>revision()!==savedRevision||encodingKey(profile)!==savedEncoding;
const readBudget=(key:string,allowed:number[],fallback:number)=>{try{const value=Number(localStorage.getItem(key));return allowed.includes(value)?value:fallback;}catch{return fallback;}};
let ramBudgetMiB=readBudget('simu-history-ram-mib',[16,64,256],64),diskBudgetMiB=readBudget('simu-history-disk-mib',[128,512,1024],512);
let historyOptions:HistoryOptions={ramBudgetBytes:ramBudgetMiB*1048576,diskBudgetBytes:diskBudgetMiB*1048576,maxEntries:1000};
let busy = false;
let renderLoop:DemandRenderer|undefined;
const invalidate=()=>renderLoop?.invalidate();
const clone = (m: Heightmap): Heightmap => ({width:m.width,height:m.height,heights:m.heights.slice()});
function updateDocumentState(){const dirty=hasUnsavedChanges();el('documentState').textContent=`${documentName} · ${map.width} × ${map.height}${dirty?' · 未保存':''}`;document.title=`${dirty?'* ':''}${documentName} — Simu Map Editor`;}
const status = (text:string,error=false) => { updateDocumentState(); el('status').textContent=text;el('status').classList.toggle('error',error); };
const scene = new THREE.Scene(); scene.background = new THREE.Color('#263c43');
const camera = new THREE.PerspectiveCamera(45,1,1,2000);
let renderer: THREE.WebGLRenderer;
try { renderer = new THREE.WebGLRenderer({antialias:true}); }
catch(error) { status(`WebGL2を初期化できません。ブラウザのGPU設定を確認してください。\n${String(error)}`,true);document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('button,input,select').forEach(e=>e.disabled=true);throw error; }
renderer.setPixelRatio(Math.min(devicePixelRatio,2));viewport.prepend(renderer.domElement);
const controls = new OrbitControls(camera,renderer.domElement);controls.mouseButtons={LEFT:null as unknown as THREE.MOUSE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.ROTATE};controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.49;
scene.add(new THREE.HemisphereLight(0xe4f2ed,0x364b35,2));const sun=new THREE.DirectionalLight(0xfff4d9,2.5);sun.position.set(-100,200,100);scene.add(sun);
let terrain:TerrainSurface|undefined;
let water:WaterSurface|undefined;
const indicator=new THREE.Mesh(new THREE.RingGeometry(.94,1,64),new THREE.MeshBasicMaterial({color:0xffedb3,side:THREE.DoubleSide,depthTest:false,transparent:true,opacity:.9}));indicator.rotation.x=-Math.PI/2;indicator.renderOrder=10;indicator.visible=false;scene.add(indicator);
let geometryBytes=0;
let lastTimings:Record<string,number>={};
const interactionDiagnostics=new URLSearchParams(location.search).has('validate');
const interactionUpdates:{kind:string;totalMs:number;coreMs:number;gridMs:number;geometryMs:number;waterMs:number;points:number}[]=[];
let batchCoreMs=0;
function recordInteraction(kind:string,start:number,points:number){if(interactionDiagnostics&&interactionUpdates.length<600)interactionUpdates.push({kind,totalMs:performance.now()-start,coreMs:batchCoreMs,gridMs:lastTimings.gridMs??0,geometryMs:lastTimings.geometryMs??0,waterMs:lastTimings.quantizationAndWaterMs??0,points});}
let quantization={changed:0,outsideRange:0,fractional:0,reachableMin:-12,reachableMax:32};
function quantizationText(){return `書出時の量子化: ${quantization.changed.toLocaleString()}画素（到達範囲外 ${quantization.outsideRange.toLocaleString()} / 小数 ${quantization.fractional.toLocaleString()}）。到達標高 ${quantization.reachableMin}〜${quantization.reachableMax}。表示は量子化後の結果です。`;}
function historyButtons(){
 if(!history)return;
 updateDocumentState();
 const state=history.getState();
 el<HTMLButtonElement>('undo').disabled=busy||state.reading||state.undoCount===0;
 el<HTMLButtonElement>('redo').disabled=busy||state.reading||state.redoCount===0;
 if(waitingForDrain&&!busy&&!state.reading&&!state.failed&&state.queuedBytes===0){historyPaused=false;waitingForDrain=false;status('履歴の退避が完了しました。造成を再開できます');}
 el('historyState').textContent=`${memoryHistory?`RAM履歴（上限 ${((historyOptions.ramBudgetBytes??0)/1048576).toFixed(0)} MiB）`:'IndexedDB履歴'}: Undo ${state.undoCount} / Redo ${state.redoCount}\n退避待ち ${(state.queuedBytes/1048576).toFixed(2)} MiB / ${memoryHistory?'RAM保存':'保存済み'} ${(state.storedBytes/1048576).toFixed(2)} MiB${state.failed?'\n保存失敗: 未退避履歴をRAMに保持しています':''}${state.reading?'\n履歴を読み込み中…':''}${historyPaused?'\n造成は一時停止中':''}`;
 el<HTMLSelectElement>('historyDisk').disabled=busy||state.reading||memoryHistory;
 el<HTMLButtonElement>('historyMemory').hidden=!(state.failed||historyPaused);
 if(state.failed||historyPaused)el<HTMLDetailsElement>('historySettings').open=true;
}
function makeHistory(options:HistoryOptions=historyOptions,ramOnly=memoryHistory){
 const memory=new Map<string,ArrayBuffer>();
 let backend:HistoryStore;
 try{backend=ramOnly?{put:async(key,buffer)=>{memory.set(key,buffer);},get:async key=>memory.get(key)?.slice(0),delete:async keys=>{for(const key of keys)memory.delete(key);},dispose:async()=>{memory.clear();}}:new BrowserHistoryStore();}catch(error){const failure=error instanceof Error?error:new Error(String(error));backend={put:async()=>{throw failure;},get:async()=>{throw failure;},delete:async()=>{},dispose:async()=>{}};}
 const wrapped:HistoryStore={
  put:async(key,buffer)=>{const fault=ramOnly?{}:{...historyFault};if(fault.putDelayMs)await new Promise(r=>setTimeout(r,fault.putDelayMs));if(fault.failPut)throw new Error('Injected history storage failure');await backend.put(key,buffer);},
  get:async key=>{const fault=ramOnly?{}:{...historyFault};if(fault.readDelayMs)await new Promise(r=>setTimeout(r,fault.readDelayMs));if(fault.failRead)throw new Error('Injected history read failure');return backend.get(key);},
  delete:keys=>backend.delete(keys),dispose:()=>backend.dispose()
 };
 const instance=new AsyncHistory(wrapped,{...options,...(ramOnly?{diskBudgetBytes:options.ramBudgetBytes}:{}),onChange:()=>{if(history===instance)historyButtons();},onError:error=>{
  if(history!==instance)return;
  historyPaused=true;waitingForDrain=false;
  if(gesture)finishGesture(true);
  status(`履歴保存に失敗しました。地形と未退避履歴は保持しています。画像を書き出すか、確認後に履歴を破棄／RAMのみへ切り替えてください。\n${String(error)}`,true);historyButtons();
 }});
 return instance;
}
function historyFailure(error:unknown){
 historyPaused=true;waitingForDrain=error instanceof HistoryBudgetError&&error.reason==='ram'&&error.requiredBytes<=(historyOptions.ramBudgetBytes??0)&&history.getState().queuedBytes>0&&!history.getState().failed;
 status(`造成を反映できませんでした。地形と履歴は変更前へ戻しました。${waitingForDrain?'履歴の退避完了を待っています。':'画像を書き出すか、履歴予算の変更／履歴破棄を確認してください。'}\n${String(error)}`,true);historyButtons();
}
function resetHistory(){history.reset();historyPaused=false;waitingForDrain=false;revisions=[++revisionSerial];historyButtons();}
function rememberRevision(){const count=history.getState().undoCount;revisions=revisions.slice(0,count);revisions.push(++revisionSerial);}
function recordHistory(patch:Parameters<AsyncHistory['record']>[0]){
 const started=performance.now();try{history.record(patch);}finally{lastTimings.historyRecordMs=performance.now()-started;}
}
function editingBlocked(){return busy||historyPaused||history.getState().reading||history.getState().failed;}
history=makeHistory();historyButtons();
input('historyRam').value=String(ramBudgetMiB);input('historyDisk').value=String(diskBudgetMiB);
type Edit={incremental:boolean;bounds:DirtyBounds|null};
function rebuild(next=map,nextProfile=profile,edit?:Edit){
 const start=performance.now();
 const w=next.width,h=next.height;
 const patch=edit?.incremental&&edit.bounds&&nextProfile===profile&&w===map.width&&h===map.height?prepareGridPatch(grid,next,edit.bounds):null;
 const retainWater=patch&&water&&!patch.changesWater(nextProfile.seaLevel);
 patch?.apply();
 const nextGrid=patch?patch.grid:toGrid(next,nextProfile);const gridDone=performance.now();
 const nextQuantization=patch?{changed:0,outsideRange:0,fractional:0,reachableMin:decodeSample(0,nextProfile),reachableMax:decodeSample(255,nextProfile)}:quantizationReport(next,nextProfile);
 // Validate water allocation before mutating the visible terrain buffers.
 let nextWater:WaterSurface,waterEdit:ReturnType<WaterSurface['prepareUpdate']>|undefined;
 try{
  nextWater=patch&&water?water:new WaterSurface(nextGrid,w,h,nextProfile.seaLevel,{budgetBytes:settings.waterMiB?settings.waterMiB*1048576:undefined});
  if(patch&&water&&!retainWater)waterEdit=water.prepareUpdate(nextGrid,w,h,nextProfile.seaLevel,patch.dirty);
 }catch(error){patch?.rollback();throw error;}
 const waterDone=performance.now();
 try{
  if(!terrain){const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:1});addTileGrid(material,gridEnabled,gridOffset);const nextTerrain=new TerrainSurface(material,{cellBudget:settings.displayCells});try{nextTerrain.update(nextGrid,w,h,nextProfile.seaLevel);}catch(error){material.dispose();throw error;}terrain=nextTerrain;scene.add(terrain);}
  else terrain.update(nextGrid,w,h,nextProfile.seaLevel,patch?.dirty);
 }catch(error){patch?.rollback();waterEdit?.dispose();if(nextWater!==water)nextWater.dispose();throw error;}
 waterEdit?.commit();
 if(water&&water!==nextWater){scene.remove(water);water.dispose();}
 water=nextWater;for(const material of water.materials)addTileGrid(material,gridEnabled,gridOffset);scene.add(water);map=next;profile=nextProfile;grid=nextGrid;gridOffset.value.set(w/2,h/2);if(hoverScreen)cursorReadout(pick(hoverScreen));quantization=nextQuantization;el('quantization').textContent=quantizationText();el('quantization').classList.toggle('warning',quantization.outsideRange>0);
 geometryBytes=terrain.metrics.geometryBytes+nextWater.metrics.geometryBytes;
 el('metrics').textContent=`${w} × ${h}タイル / ${(w+1)} × ${(h+1)}頂点\n${(w*h*2).toLocaleString()}三角形（元データ） / 表示間隔 ${terrain.metrics.stride}タイル / ${terrain.metrics.chunkCount}分割 / メッシュ ${(geometryBytes/1048576).toFixed(1)} MiB（CPU配列のみ）`;
 lastTimings={...lastTimings,gridMs:gridDone-start,quantizationAndWaterMs:waterDone-gridDone,geometryMs:performance.now()-waterDone,rebuildMs:performance.now()-start};
 historyButtons();invalidate();
}
function view(top=preferences.view==='top'){const size=Math.max(8,map.width,map.height);controls.target.set(0,0,0);camera.position.set(top?0:size*.7,top?size*1.4:size*.85,top?.001:size*.85);camera.near=Math.max(.5,size/1000);camera.far=Math.max(200,size*6);camera.updateProjectionMatrix();controls.update();scheduleViewDetail();}
function setMap(next:Heightmap){if(history.getState().reading||gesture)throw new Error('履歴読込・造成中は地図を置き換えられません');validateDimensions(next.width,next.height);if(next.heights.length!==next.width*next.height||!next.heights.every(Number.isFinite))throw new Error('画像寸法または標高データが不正です');rebuild(clone(next));resetHistory();view();hoverScreen=null;cursorReadout(null);}
type Stroke = Parameters<typeof applyBrush>[2];
function stroke(options:Stroke){
 if(editingBlocked())throw new Error('History is busy, paused or unavailable');
 const previous=map;const coreStart=performance.now();const result=applyBrushIncremental(map,profile,options);lastTimings={coreMs:performance.now()-coreStart};
 if(result.changed){
  const patchStarted=performance.now();
  const patch=createPatch(previous,result.map,result.changedIndices)!;
  lastTimings.historyPatchMs=performance.now()-patchStarted;
  rebuild(result.map,profile,result);
  try{recordHistory(patch);rememberRevision();}catch(error){rebuild(previous);historyFailure(error);throw error;}
 }
 status(`造成完了: ${result.changed.toLocaleString()}画素変更 / 履歴 ${history.getState().undoCount}回（非同期保存）`);
}
function selectedStroke(x:number,y:number):Stroke{return{x,y,radius:Number(input('radius').value),amount:Number(input('amount').value),tool:el<HTMLSelectElement>('tool').value as Stroke['tool'],smoothingRadius:settings.smoothingRadius,smoothingMode:settings.smoothingMode};}
function getMapDigest(){
 const bits=new Uint32Array(map.heights.buffer,map.heights.byteOffset,map.heights.length);
 let heightsHash=2166136261,gridHash=2166136261;
 for(let i=0;i<bits.length;i++){heightsHash=Math.imul(heightsHash^(bits[i]&0xffff),16777619);heightsHash=Math.imul(heightsHash^(bits[i]>>>16),16777619);}
 for(let i=0;i<grid.length;i++)gridHash=Math.imul(gridHash^grid[i],16777619);
 return {width:map.width,height:map.height,heightsHash:heightsHash>>>0,gridHash:gridHash>>>0};
}
function setBusy(value:boolean){busy=value;document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('button,input,select').forEach(e=>e.disabled=value);historyButtons();}
el('create').addEventListener('click',()=>{
 try{
  const width=Number(input('newWidth').value),height=Number(input('newHeight').value);
  validateDimensions(width,height);
  if(!confirm(largeMapWarning(width,height)+'現在の地形とUndo/Redo履歴を置き換えて新規作成しますか？'))return;
  setMap({width,height,heights:new Float32Array(width*height)});
  documentName='新規マップ';exportName='simutrans-heightmap.bmp';
  indicator.visible=false;el('dragHeight').textContent='開始点で決定';
  status(`${width} × ${height}タイルの平坦な地形を新規作成しました`);
 }catch(error){status(String(error),true);}
});
class ImportCancelled extends Error{}
input('file').addEventListener('change',async()=>{
 const file=input('file').files?.[0];if(!file)return;
 setBusy(true);status('画像を読み込んでいます…');
 try{
  const decoded=await importHeightmap(file,profile,(w,h)=>{const warning=largeMapWarning(w,h);if(warning&&!confirm(warning+'この画像の取り込みを続行しますか？'))throw new ImportCancelled('画像の読み込みを取り消しました。現在の地形と履歴を保持しています');});
  const result=normalizeImport(decoded,profile);
  const warning=result.changed?`補正: ${result.changed.toLocaleString()}画素変更。書出標高への量子化 ${result.quantization.changed.toLocaleString()}画素（範囲外 ${result.quantization.outsideRange.toLocaleString()} / 小数 ${result.quantization.fractional.toLocaleString()}）、斜面補正 ${result.slopeChanged.toLocaleString()}画素。各項目は重複する場合があります。補正済みの地形で編集します。`: '補正はありません。';
  if(!confirm(`${file.name}（${result.map.width} × ${result.map.height}タイル）を開きます。\n${warning}\n現在の地形とUndo/Redo履歴を置き換えますか？`)){status('画像の読み込みを取り消しました。現在の地形と履歴を保持しています');return;}
  setMap(result.map);
  documentName=file.name;exportName=file.name.replace(/\.[^.]+$/,'')+'.bmp';
  if(!result.changed){savedRevision=revision();savedEncoding=encodingKey(profile);}
  status(`${file.name} を読み込みました。${warning}${result.changed?' 保存するにはBMPを書き出してください。':''}`);
 }catch(error){status(String(error),!(error instanceof ImportCancelled));}
 finally{setBusy(false);input('file').value='';}
});
async function downloadMap(format:'bmp'|'png'){
 if(busy)return;
 const source=map,compatibility=profile,exportedRevision=revision();
 setBusy(true);status(`${format.toUpperCase()}を書き出しています…`);
 try{
  const bytes=format==='png'?await exportPng(source,compatibility):exportBmp(source,compatibility);
  const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:`image/${format}`}));
  try{const anchor=document.createElement('a');anchor.href=url;anchor.download=exportName.replace(/\.[^.]+$/,`.${format}`);anchor.click();savedRevision=exportedRevision;savedEncoding=encodingKey(compatibility);}
  finally{setTimeout(()=>URL.revokeObjectURL(url),10000);}
  status(`${format.toUpperCase()}を書き出しました。${quantizationText()} 互換設定を合わせて確認してください。`);
 }catch(error){status(String(error),true);}
 finally{setBusy(false);}
}
el('export').addEventListener('click',()=>void downloadMap('bmp'));
el('exportPng').addEventListener('click',()=>void downloadMap('png'));
async function moveHistory(redo=false){
 if(busy||history.getState().reading)return;
 setBusy(true);status('履歴を読み込み中…');
 try{const moved=await (redo?history.redo(map,next=>rebuild(next)):history.undo(map,next=>rebuild(next)));if(moved)status(redo?'造成をやり直しました':'造成を元に戻しました');}
 catch(error){status(`履歴を復元できませんでした。地形と履歴位置を保持しています。\n${String(error)}`,true);}
 finally{setBusy(false);}
}
el('undo').addEventListener('click',()=>void moveHistory());el('redo').addEventListener('click',()=>void moveHistory(true));
el('historyDiscard').addEventListener('click',()=>{if(!confirm('現在の地形は保持し、Undo/Redo履歴をすべて破棄して続行しますか？'))return;const wasDirty=hasUnsavedChanges();resetHistory();if(!wasDirty)savedRevision=revision();status('履歴を破棄しました。現在の地形は保持しています');});
el('historyMemory').addEventListener('click',()=>{
 if(!confirm('現在の履歴を破棄し、ブラウザ保存を使わずRAMのみで履歴を保持して続行しますか？'))return;
 const old=history,wasDirty=hasUnsavedChanges();memoryHistory=true;history=makeHistory();historyPaused=false;waitingForDrain=false;revisions=[++revisionSerial];if(!wasDirty)savedRevision=revision();void old.dispose().catch(()=>{});historyButtons();status('RAMのみの履歴へ切り替えました。現在の地形は保持しています');
});
for(const id of ['historyRam','historyDisk'])el(id).addEventListener('change',()=>{
 const ram=Number(input('historyRam').value),disk=Number(input('historyDisk').value);
 if(!confirm('履歴予算を変更すると現在のUndo/Redo履歴を破棄します。地形を保持して続行しますか？')){input('historyRam').value=String(ramBudgetMiB);input('historyDisk').value=String(diskBudgetMiB);return;}
 const old=history,wasDirty=hasUnsavedChanges();ramBudgetMiB=ram;diskBudgetMiB=disk;historyOptions={...historyOptions,ramBudgetBytes:ram*1048576,diskBudgetBytes:disk*1048576};
 history=makeHistory();historyPaused=false;waitingForDrain=false;revisions=[++revisionSerial];if(!wasDirty)savedRevision=revision();void old.dispose().catch(()=>{});
 try{localStorage.setItem('simu-history-ram-mib',String(ram));localStorage.setItem('simu-history-disk-mib',String(disk));}catch{/* Settings persistence is optional. */}
 historyButtons();status('履歴予算を更新しました');
});
window.addEventListener('beforeunload',event=>{if(hasUnsavedChanges()){event.preventDefault();event.returnValue='';}});
const profileFields=['mode','factor','maxSlope','seaLevel','min','max'] as const;
el('compatibilityTarget').textContent=`${COMPATIBILITY_TARGET.name} / ${COMPATIBILITY_TARGET.revision.slice(0,9)}`;
el('profilePreset').innerHTML='<option value="custom">カスタム</option>'+PROFILE_PRESETS.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
function syncProfile(){
 for(const id of profileFields)input(id).value=String(profile[id]);
 input('seaLevel').min=profile.maxSlope===2?'-40':'-20';
 el<HTMLSelectElement>('profilePreset').value=PROFILE_PRESETS.find(p=>profileFields.every(key=>p.profile[key]===profile[key]))?.id??'custom';
}
function changeProfile(next:Profile){
 try{
  validateEditorProfile(next);
  if(profileFields.every(key=>next[key]===profile[key]))return;
  const structural=profileFields.some(key=>key!=='seaLevel'&&next[key]!==profile[key]);
  if(!structural){rebuild(map,next);status(`海面を${next.seaLevel}へ変更しました。地形と履歴は保持しています`);return;}
  const result=normalizeImport(map,next);
  const clearHistory=structural||result.changed>0,wasDirty=hasUnsavedChanges();
  const details=result.changed?`標高を${result.changed.toLocaleString()}画素補正し、Undo/Redo履歴を破棄します。`:structural?'標高は保持し、変更前の設定で登録したUndo/Redo履歴を破棄します。':'標高とUndo/Redo履歴を保持します。';
  if(!confirm(`互換設定を変更しますか？\n${details}\n画像には設定が含まれません。ゲーム側にも同じ設定を指定してください。`))return;
  rebuild(result.changed?result.map:map,next);
  if(clearHistory){resetHistory();if(!wasDirty&&!result.changed)savedRevision=revision();}
  status(`互換設定を更新しました。${details}${hasUnsavedChanges()?' 保存するには画像を書き出してください。':''}`);
 }catch(error){status(String(error),true);}
 finally{syncProfile();}
}
syncProfile();
for(const id of profileFields)el(id).addEventListener('change',()=>changeProfile({mode:el<HTMLSelectElement>('mode').value as Profile['mode'],factor:Number(input('factor').value) as 1|2,maxSlope:Number(input('maxSlope').value) as 1|2,seaLevel:Number(input('seaLevel').value),min:Number(input('min').value),max:Number(input('max').value)}));
el('profilePreset').addEventListener('change',()=>{const preset=PROFILE_PRESETS.find(p=>p.id===input('profilePreset').value);if(preset)changeProfile({...preset.profile});});
input('gridToggle').checked=preferences.grid??false;
input('gridToggle').addEventListener('change',()=>{gridEnabled.value=input('gridToggle').checked;preferences.grid=gridEnabled.value;savePreferences(preferences);invalidate();});
for(const id of ['tool','radius','amount'] as const){
 input(id).value=String(preferences[id]);
 el(id).addEventListener('change',()=>{
  const radius=Number(input('radius').value),amount=Number(input('amount').value);
  if(!Number.isInteger(radius)||radius<1||radius>settings.maxBrushRadius||!Number.isInteger(amount)||amount<1||amount>8){input('amount').value=String(preferences.amount);return;}
  preferences={...preferences,tool:el<HTMLSelectElement>('tool').value as typeof preferences.tool,radius,amount};savePreferences(preferences);
 });
}

const settingFields=['maxTiles','maxFileMiB','displayCells','waterMiB','maxBrushRadius'] as const;
function syncSettings(){for(const key of settingFields)input(key).value=String(settings[key]);input('radius').max=String(settings.maxBrushRadius);input('smoothingRadius').value=String(settings.smoothingRadius);input('smoothingMode').value=settings.smoothingMode;}
function smoothingControls(){el('smoothingControls').hidden=input('tool').value!=='smooth';}
input('tool').addEventListener('change',smoothingControls);smoothingControls();syncSettings();
input('smoothingMode').addEventListener('change',()=>{try{settings=validateSettings({...settings,smoothingMode:input('smoothingMode').value as EditorSettings['smoothingMode']});saveEditorSettings(settings);}catch(error){status(String(error),true);syncSettings();}});
input('smoothingRadius').addEventListener('change',()=>{try{const next=validateSettings({...settings,smoothingRadius:Number(input('smoothingRadius').value)});settings=next;saveEditorSettings(settings);}catch(error){status(String(error),true);syncSettings();}});
el('applySettings').addEventListener('click',()=>{
 try{
  const next=validateSettings({...settings,...Object.fromEntries(settingFields.map(key=>[key,Number(input(key).value)]))} as EditorSettings);
  if(map.width*map.height>next.maxTiles)throw new Error('現在のマップより小さい総タイル数には設定できません');
  const waterBudget=next.waterMiB?next.waterMiB*1048576:waterGeometryBudget(map.width,map.height);
  if(water&&water.metrics.geometryBytes>waterBudget)throw new Error('現在の水面使用量より小さい予算には設定できません');
  terrain?.configure({cellBudget:next.displayCells});water?.setBudget(next.waterMiB?next.waterMiB*1048576:undefined);
  settings=next;LIMITS.maxTiles=next.maxTiles;LIMITS.maxFileBytes=next.maxFileMiB*1048576;
  preferences.radius=Math.min(Number(input('radius').value),next.maxBrushRadius);input('radius').value=String(preferences.radius);el('radiusValue').textContent=String(preferences.radius);
  savePreferences(preferences);saveEditorSettings(settings);syncSettings();scheduleViewDetail();refreshMetrics();status('表示品質・上限設定を適用しました。地形と履歴は保持しています');
 }catch(error){status(String(error),true);syncSettings();}
});
let viewDetailTimer:ReturnType<typeof setTimeout>|undefined;
function scheduleViewDetail(){clearTimeout(viewDetailTimer);viewDetailTimer=setTimeout(()=>{if(gesture){scheduleViewDetail();return;}try{terrain?.setView(camera,viewport.clientHeight);refreshMetrics();invalidate();}catch(error){status(String(error),true);}},120);}
controls.addEventListener('change',()=>{scheduleViewDetail();invalidate();});
function refreshMetrics(){if(!terrain||!water)return;const w=map.width,h=map.height;geometryBytes=terrain.metrics.geometryBytes+water.metrics.geometryBytes;el('metrics').textContent=`${w} × ${h}タイル / ${(w+1)} × ${(h+1)}頂点\n表示セル ${terrain.metrics.regularCells.toLocaleString()} / 予算 ${terrain.metrics.cellBudget.toLocaleString()} / メッシュ ${(geometryBytes/1048576).toFixed(1)} MiB\n水面 ${(water.metrics.geometryBytes/1048576).toFixed(1)} / ${(water.metrics.budgetBytes/1048576).toFixed(0)} MiB`;}
el('radiusValue').textContent=String(preferences.radius);
input('radius').addEventListener('input',()=>{el('radiusValue').textContent=input('radius').value;indicator.scale.setScalar(Number(input('radius').value));invalidate();});el('top').addEventListener('click',()=>{preferences.view='top';savePreferences(preferences);view(true);});el('oblique').addEventListener('click',()=>{preferences.view='oblique';savePreferences(preferences);view(false);});
const raycaster=new THREE.Raycaster();
const pointer=new THREE.Vector2();
type Point={x:number;y:number};
type Gesture={id:number;before:Heightmap;session:ReturnType<typeof createBrushSession>;last:Point|null;options:Stroke;changed:Set<number>;screen:{clientX:number;clientY:number};at:Point};
let gesture:Gesture|null=null;
let pendingPointers:{clientX:number;clientY:number}[]=[];
let paintFrame=0;
let holdTimer:ReturnType<typeof setTimeout>|undefined;
function stopHold(){clearTimeout(holdTimer);holdTimer=undefined;}
function scheduleHold(delay=500){
 stopHold();
 if(!gesture||gesture.options.tool==='flatten')return;
 holdTimer=setTimeout(()=>{
  if(!gesture)return;
  try{
   const g=gesture,tool=g.options.tool;
   if(tool==='raise'||tool==='lower'){g.options.target=Math.max(decodeSample(0,profile),Math.min(decodeSample(255,profile),(g.options.target??0)+(tool==='raise'?1:-1)*g.options.amount));el('dragHeight').textContent=String(g.options.target+1);}
   const started=performance.now();batchCoreMs=0;pendingEdit=null;const next=paintAt(g.at,map);if(next!==map){rebuild(next,profile,pendingEdit??undefined);recordInteraction('hold',started,1);}
   scheduleHold(150);
  }catch(error){finishGesture(true);status(String(error),true);}
 },delay);
}
function cursorReadout(point:THREE.Vector3|null){
 el('cursorPosition').textContent=point?`X ${(point.x+map.width/2).toFixed(1)} / Y ${(point.z+map.height/2).toFixed(1)} / 標高 ${point.y.toFixed(1)}`:'X — / Y — / 標高 —';
}
function pick(event:{clientX:number;clientY:number}){
 if(!terrain)return null;
 const rect=renderer.domElement.getBoundingClientRect();
 pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
 raycaster.setFromCamera(pointer,camera);
 return intersectTerrain(raycaster.ray,grid,map.width,map.height);
}
let pendingEdit:Edit|null=null;
function paintPointer(event:{clientX:number;clientY:number},candidate=map):Heightmap{
 const repeated=hoverScreen?.clientX===event.clientX&&hoverScreen?.clientY===event.clientY;
 hoverScreen=event;
 const point=pick(event);
 cursorReadout(point);
 indicator.visible=!!point&&(!busy||!!gesture);
 if(!point){if(gesture){gesture.last=null;stopHold();}return candidate;}
 indicator.position.copy(point);indicator.position.y+=.2;indicator.scale.setScalar(Number(input('radius').value));
 if(!gesture){terrain?.focus(point.x+map.width/2,point.z+map.height/2,Number(input('radius').value));return candidate;}
 if(repeated&&gesture.last&&gesture.options.tool==='smooth')return candidate;
 const at={x:point.x+map.width/2,y:point.z+map.height/2};
 terrain?.focus(at.x,at.y,Number(input('radius').value));
 return paintAt(at,candidate);
}
function paintAt(at:Point,candidate:Heightmap):Heightmap{
 if(!gesture)return candidate;
 gesture.at=at;
 const coreStarted=performance.now();
 const result=gesture.session.apply({...gesture.options,...at,from:gesture.last??undefined});
 batchCoreMs+=performance.now()-coreStarted;
 if(result.changed){
  for(const index of result.changedIndices)gesture.changed.add(index);
  if(!pendingEdit)pendingEdit={incremental:result.incremental,bounds:result.bounds?{...result.bounds}:null};
  else{
   pendingEdit.incremental&&=result.incremental;
   const a=pendingEdit.bounds,b=result.bounds;
   if(a&&b){a.x0=Math.min(a.x0,b.x0);a.y0=Math.min(a.y0,b.y0);a.x1=Math.max(a.x1,b.x1);a.y1=Math.max(a.y1,b.y1);}
   else pendingEdit.bounds=null;
  }
 }
 gesture.last=at;
 return result.changed?result.map:candidate;
}
function flushPointers(){
 const started=performance.now();batchCoreMs=0;
 cancelAnimationFrame(paintFrame);paintFrame=0;const pending=pendingPointers;pendingPointers=[];
 pendingEdit=null;let next=map;for(const point of pending)next=paintPointer(point,next);
 if(next!==map){rebuild(next,profile,pendingEdit??undefined);recordInteraction('move',started,pending.length);}
 invalidate();
}
function finishGesture(cancel=false){
 if(!gesture)return;
 stopHold();
 const completed=gesture;completed.session.finish();gesture=null;
 cancelAnimationFrame(paintFrame);paintFrame=0;pendingPointers=[];
 try{
  if(cancel){rebuild(completed.before);status('ドラッグ造成を取り消しました');}
  else {
   const patchStarted=performance.now();
   const patch=createPatch(completed.before,map,completed.changed);
   lastTimings.historyPatchMs=performance.now()-patchStarted;lastTimings.historyRecordMs=0;
   if(patch){recordHistory(patch);rememberRevision();}
   status(`造成完了: ${(patch?.indices.length??0).toLocaleString()}画素変更 / ${completed.options.tool==='smooth'?'平滑化':`固定標高 ${(completed.options.target??0)+1}`} / 履歴 ${history.getState().undoCount}回（非同期保存）`);
  }
 }catch(error){rebuild(completed.before);historyFailure(error);}
 finally{controls.enabled=true;setBusy(false);if(renderer.domElement.hasPointerCapture(completed.id))renderer.domElement.releasePointerCapture(completed.id);}
}
renderer.domElement.addEventListener('pointerdown',event=>{
 if(event.button!==0||gesture)return;
 if(editingBlocked()){status('履歴の保存・読込待ち、又は保存失敗のため造成を一時停止しています。画像を書き出すか、履歴欄を確認してください。',true);return;}
 const point=pick(event);if(!point)return;
 event.preventDefault();
 cancelAnimationFrame(paintFrame);paintFrame=0;pendingPointers=[];
 const at={x:point.x+map.width/2,y:point.z+map.height/2};
 const options=selectedStroke(at.x,at.y),height=Math.round(point.y)-1;
 const delta=options.tool==='raise'?Math.round(options.amount):options.tool==='lower'?-Math.round(options.amount):0;
 if(options.tool!=='smooth'||options.smoothingMode==='slope')options.target=Math.max(decodeSample(0,profile),Math.min(decodeSample(255,profile),height+delta));
 el('dragHeight').textContent=options.target===undefined?'平滑化':String(options.target+1);
 gesture={id:event.pointerId,before:map,session:createBrushSession(map,profile),last:null,options,changed:new Set<number>(),screen:{clientX:event.clientX,clientY:event.clientY},at};
 controls.enabled=false;setBusy(true);renderer.domElement.setPointerCapture(event.pointerId);
 try{const started=performance.now();batchCoreMs=0;pendingEdit=null;const next=paintPointer(event);if(next!==map){rebuild(next,profile,pendingEdit??undefined);recordInteraction('start',started,1);}status(options.tool==='smooth'?'平滑化中（離すと1操作として確定）':`ドラッグ造成中: 表示標高 ${(options.target??0)+1} に固定（静止長押しで連続増減）`);scheduleHold();invalidate();}
 catch(error){finishGesture(true);status(String(error),true);}
});
renderer.domElement.addEventListener('pointermove',event=>{
 if(busy&&!gesture)return;
 if(gesture&&event.pointerId!==gesture.id)return;
 if(gesture&&Math.hypot(event.clientX-gesture.screen.clientX,event.clientY-gesture.screen.clientY)>6){gesture.screen={clientX:event.clientX,clientY:event.clientY};scheduleHold();}
 const coalesced=event.getCoalescedEvents?.()??[];
 const points=(coalesced.length?coalesced:[event]).map(point=>({clientX:point.clientX,clientY:point.clientY}));
 if(gesture)pendingPointers.push(...points);else pendingPointers=points.slice(-1);
 if(!paintFrame)paintFrame=requestAnimationFrame(()=>{
  try{flushPointers();}catch(error){finishGesture(true);status(String(error),true);}
 });
});
renderer.domElement.addEventListener('pointerup',event=>{
 if(!gesture||event.pointerId!==gesture.id||event.button!==0)return;
 pendingPointers.push({clientX:event.clientX,clientY:event.clientY});
 try{flushPointers();finishGesture();}catch(error){finishGesture(true);status(String(error),true);}
});
renderer.domElement.addEventListener('pointercancel',event=>{if(gesture?.id===event.pointerId)finishGesture(true);});
renderer.domElement.addEventListener('lostpointercapture',event=>{if(gesture?.id===event.pointerId)finishGesture(true);});
renderer.domElement.addEventListener('pointerleave',()=>{indicator.visible=false;hoverScreen=null;cursorReadout(null);stopHold();invalidate();});
window.addEventListener('blur',()=>finishGesture(true));
const editorInput=installEditorInput({
 canvas:renderer.domElement,camera,target:controls.target,
 blocked:()=>busy||gesture!==null||history.getState().reading,
 cancel:()=>finishGesture(true),view:()=>preferences.view,maxRadius:()=>settings.maxBrushRadius,
 wake:invalidate,
 onPan:()=>{indicator.visible=false;hoverScreen=null;cursorReadout(null);},
});

new ResizeObserver(()=>{const width=viewport.clientWidth,height=viewport.clientHeight;renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();scheduleViewDetail();invalidate();}).observe(viewport);
renderLoop=new DemandRenderer({
 update:seconds=>{const panned=editorInput.update(seconds);return controls.update()||panned;},
 render:()=>renderer.render(scene,camera),
});
function visibilityChanged(){if(document.hidden)editorInput.clear();renderLoop!.setSuspended(document.hidden);}
document.addEventListener('visibilitychange',visibilityChanged);
renderer.domElement.addEventListener('webglcontextrestored',invalidate);
visibilityChanged();rebuild();view();invalidate();status('128 × 128タイルの平坦な地形で開始しました。サイズを指定して新規作成するか、マップ画像を開いてください。');
if(new URLSearchParams(location.search).has('validate')){const gl=renderer.getContext();const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(window,{__validation:{getEditorSettings:()=>({...settings}),getDisplayChunks:()=>terrain?.children.map(child=>{const g=(child as THREE.Mesh).geometry;return {x0:g.userData.x0,y0:g.userData.y0,x1:g.userData.x1,y1:g.userData.y1,stride:g.userData.stride,minHeight:g.boundingBox?.min.y,maxHeight:g.boundingBox?.max.y};}).map(({x0,y0,x1,y1,stride,minHeight,maxHeight})=>({x0,y0,x1,y1,stride,minHeight,maxHeight})),getInteractionUpdates:()=>interactionUpdates.map(value=>({...value})),resetInteractionUpdates:()=>{interactionUpdates.length=0;},getHistoryState:()=>({...history.getState(),paused:historyPaused,memoryOnly:memoryHistory,dirty:hasUnsavedChanges()}),waitHistory:()=>history.settled(),setHistoryFault:(fault:typeof historyFault)=>{historyFault={...fault};},configureHistory:(options:HistoryOptions)=>{if(history.getState().reading||gesture)throw new Error('History is busy');const old=history;historyOptions={...historyOptions,...options};memoryHistory=false;history=makeHistory();historyPaused=false;waitingForDrain=false;revisions=[++revisionSerial];void old.dispose().catch(()=>{});historyButtons();},getTimings:()=>({...lastTimings}),projectSample:(x:number,y:number)=>{camera.updateMatrixWorld();const xi=Math.max(0,Math.min(map.width,Math.round(x))),yi=Math.max(0,Math.min(map.height,Math.round(y)));const v=new THREE.Vector3(x-map.width/2,grid[xi+yi*(map.width+1)],y-map.height/2).project(camera);const r=renderer.domElement.getBoundingClientRect();return{x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};},getSnapshot:()=>({width:map.width,height:map.height,heights:Array.from(map.heights),grid:Array.from(grid),profile:{...profile},undoCount:history.getState().undoCount,redoCount:history.getState().redoCount}),setMap,stroke,getMetrics:()=>({displayStride:terrain?.metrics.stride,displayTriangles:terrain?.metrics.triangles,chunkCount:terrain?.metrics.chunkCount,displayCells:terrain?.metrics.regularCells,displayCellBudget:terrain?.metrics.cellBudget,viewAware:terrain?.metrics.viewAware,gridVisible:gridEnabled.value,triangles:map.width*map.height*2,geometryBytes:(terrain?.metrics.geometryBytes??0)+(water?.metrics.geometryBytes??0),waterTriangles:water?.metrics.triangles??0,waterGeometryBytes:water?.metrics.geometryBytes??0,waterBudgetBytes:water?.metrics.budgetBytes??0,drawCalls:renderer.info.render.calls,renderedTriangles:renderer.info.render.triangles,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),webgl2:gl instanceof WebGL2RenderingContext}),renderSample:async(frames=20)=>{const times:number[]=[];for(let i=0;i<frames;i++){await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));const start=performance.now();renderer.render(scene,camera);gl.finish();times.push(performance.now()-start);}times.sort((a,b)=>a-b);return{frameMedianMs:times[Math.floor(times.length*.5)],frameP95Ms:times[Math.min(times.length-1,Math.floor(times.length*.95))]};}}});}
if(interactionDiagnostics)Object.assign((window as unknown as {__validation:object}).__validation,{getMapDigest});
