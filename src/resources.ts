import {LIMITS,validateDimensions} from './terrain.ts';
/** Conservative working-array estimate, excluding decoded image/GPU/browser overhead. */
export function mapResources(width:number,height:number){
 validateDimensions(width,height);
 const pixels=width*height,vertices=(width+1)*(height+1);
 return {large:width>LIMITS.standardEdge||height>LIMITS.standardEdge||pixels>LIMITS.standardTiles,
 sourceBytes:pixels*4,gridBytes:vertices*2,workingBytes:pixels*20+vertices*8+96*1048576};
}
export function largeMapWarning(width:number,height:number):string {
 const estimate=mapResources(width,height);
 return estimate.large?`大サイズマップ: ${width.toLocaleString()} × ${height.toLocaleString()}タイル。標準の4096四方を超えます。\n作業配列の概算 ${(estimate.workingBytes/1048576).toFixed(0)} MiB以上（画像展開・GPU等は別途）。端末によっては確保できません。全体表示は間引き、編集位置周辺を詳細表示します。\n`:'';
}
