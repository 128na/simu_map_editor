import {PerspectiveCamera,Vector3} from 'three';

interface EditorInputOptions {
  canvas:HTMLCanvasElement;
  camera:PerspectiveCamera;
  target:Vector3;
  blocked:()=>boolean;
  cancel:()=>void;
  view:()=> 'top'|'oblique';
  maxRadius:()=>number;
  onPan:()=>void;
  wake?:()=>void;
}

const arrowKeys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'];
const editableTarget=(target:EventTarget|null)=>target instanceof HTMLElement&&
  (!!target.closest('input,select,textarea')||target.isContentEditable);

/** Keyboard bindings and screen-relative camera panning; editing remains owned by the editor. */
export function installEditorInput(options:EditorInputOptions){
  const {camera,target,canvas}=options;
  const panKeys=new Set<string>();
  const listeners=new AbortController();
  const right=new Vector3(),up=new Vector3(),delta=new Vector3(),worldUp=new Vector3(0,1,0);
  const element=(id:string)=>document.getElementById(id)!;
  const field=(id:string)=>element(id) as HTMLInputElement;
  const clear=()=>panKeys.clear();
  const wake=()=>options.wake?.();

  function update(seconds:number):boolean {
    if(!panKeys.size)return false;
    if(options.blocked()||editableTarget(document.activeElement)){clear();return false;}
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld,0);right.y=0;right.normalize();
    up.crossVectors(worldUp,right).normalize();
    const x=Number(panKeys.has('ArrowRight'))-Number(panKeys.has('ArrowLeft'));
    const y=Number(panKeys.has('ArrowUp'))-Number(panKeys.has('ArrowDown'));
    delta.copy(right).multiplyScalar(x).addScaledVector(up,y);
    if(!delta.lengthSq())return false;
    delta.normalize().multiplyScalar(camera.position.distanceTo(target)*seconds*.6);
    camera.position.add(delta);target.add(delta);options.onPan();
    return true;
  }

  function keydown(event:KeyboardEvent){
    if(event.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'){clear();options.cancel();return;}
    if(editableTarget(event.target)||event.altKey)return;
    const key=event.key.toLowerCase(),command=event.ctrlKey||event.metaKey;
    if(command){
      const id=key==='z'?(event.shiftKey?'redo':'undo'):key==='y'&&!event.shiftKey?'redo':key==='o'&&!event.shiftKey?'file':key==='s'&&!event.shiftKey?'exportPng':null;
      if(!id)return;
      event.preventDefault();clear();
      if(!event.repeat&&!options.blocked())element(id).click();
      return;
    }
    if(arrowKeys.includes(event.key)){
      event.preventDefault();
      if(!options.blocked()){panKeys.add(event.key);wake();}
      return;
    }
    const tool=['raise','lower','flatten','smooth'][Number(key)-1];
    const radiusDelta=key==='['?-1:key===']'?1:0;
    const amountDelta=key==='-'?-1:key==='+'||key==='='?1:0;
    if(!tool&&!radiusDelta&&!amountDelta&&key!=='g'&&key!=='v')return;
    event.preventDefault();
    if(options.blocked())return;
    if(tool){
      if(event.repeat)return;
      field('tool').value=tool;field('tool').dispatchEvent(new Event('change'));
    }else if(radiusDelta||amountDelta){
      const input=field(radiusDelta?'radius':'amount');
      input.value=String(Math.max(1,Math.min(radiusDelta?options.maxRadius():8,Number(input.value)+(radiusDelta||amountDelta))));
      input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));
    }else if(!event.repeat){
      if(key==='g')field('gridToggle').click();
      else element(options.view()==='top'?'oblique':'top').click();
    }
  }

  const eventOptions={signal:listeners.signal};
  window.addEventListener('keyup',event=>{if(panKeys.delete(event.key))wake();},eventOptions);
  window.addEventListener('blur',clear,eventOptions);
  window.addEventListener('focusin',clear,eventOptions);
  canvas.addEventListener('pointerdown',clear,eventOptions);
  window.addEventListener('keydown',keydown,eventOptions);
  for(const [id,title] of Object.entries({tool:'1: 盛土 / 2: 掘削 / 3: 平坦化 / 4: なだらかにする',radius:'[ / ]: ブラシ半径を縮小 / 拡大',amount:'- / +: 強さを下げる / 上げる',undo:'Ctrl+Z: 元に戻す',redo:'Ctrl+Shift+Z / Ctrl+Y: やり直す',file:'Ctrl+O: 画像を開く',exportPng:'Ctrl+S: PNGを書き出す',gridToggle:'G: グリッド表示',top:'V: 真上 / 斜めを切り替え',oblique:'V: 真上 / 斜めを切り替え'}))element(id).title=title;
  return {
    update,
    get active(){return panKeys.size>0;},
    clear,
    dispose(){clear();listeners.abort();},
  };
}
