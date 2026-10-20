import {DEFAULT_PROFILE,decodeSample,type Profile} from './terrain.ts';
export const COMPATIBILITY_TARGET={name:'Simutrans Standard',revision:'af90444e46dfd422bfdf80518aaa568659ec6b00',gameMaxEdge:32766};
export const PROFILE_PRESETS=[
 {id:'standard-linear',name:'Standard / Linear',profile:{...DEFAULT_PROFILE}},
 {id:'standard-clamp',name:'Standard / Clamp',profile:{...DEFAULT_PROFILE,mode:'clamp' as const}},
 {id:'legacy-small',name:'Legacy small / 係数1',profile:{...DEFAULT_PROFILE,mode:'legacy-small' as const}},
 {id:'legacy-large',name:'Legacy large / 係数1',profile:{...DEFAULT_PROFILE,mode:'legacy-large' as const}},
];
/** Image bytes depend on these settings; sea and slope are applied after decoding. */
export const encodingKey=(p:Profile)=>JSON.stringify([p.mode,p.min,p.max,p.factor]);
export function validateEditorProfile(p:Profile):void {
 decodeSample(0,p);
 if(p.min> -12||p.max<16)throw new Error('標高下限は−127〜−12、上限は16〜125で指定してください（127は現在未対応）');
 const minSea=p.maxSlope===2?-40:-20;
 if(!Number.isInteger(p.seaLevel)||p.seaLevel<minSea||p.seaLevel>20)throw new Error(`海面は${minSea}〜20の整数で指定してください`);
}
