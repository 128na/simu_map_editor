import type {MeshStandardMaterial, IUniform, Vector2} from 'three';

/** Draw tile boundaries in the existing surface shader, without another mesh. */
export function addTileGrid(material:MeshStandardMaterial, enabled:IUniform<boolean>, offset:IUniform<Vector2>):void {
 if(material.userData.tileGrid)return;
 material.userData.tileGrid=true;
 material.onBeforeCompile=shader=>{
  shader.uniforms.tileGridEnabled=enabled;
  shader.uniforms.tileGridOffset=offset;
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 tileGridPosition;\nuniform vec2 tileGridOffset;').replace('#include <begin_vertex>','#include <begin_vertex>\ntileGridPosition = position.xz + tileGridOffset;');
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 tileGridPosition;\nuniform bool tileGridEnabled;').replace('#include <color_fragment>',`#include <color_fragment>
 if (tileGridEnabled) {
   vec2 coord = tileGridPosition;
   vec2 width = max(fwidth(coord), vec2(0.0001));
   vec2 edge = abs(fract(coord - 0.5) - 0.5) / width;
   float line = 1.0 - min(min(edge.x, edge.y), 1.0);
   float fade = 1.0 - smoothstep(0.35, 0.8, max(width.x, width.y));
   diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08, 0.14, 0.16), line * fade * 0.7);
 }`);
 };
 material.customProgramCacheKey=()=> 'tile-grid-v1';
}
