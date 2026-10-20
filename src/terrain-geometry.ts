import * as THREE from 'three';

/** Retain GPU buffers for equal dimensions; update normals of every adjacent face. */
export function terrainGeometry(grid:Int16Array,w:number,h:number,sea:number,existing?:THREE.BufferGeometry,previous?:Int16Array,previousSea=sea):THREE.BufferGeometry {
 const reuse=!!existing&&previous?.length===grid.length&&existing.userData.width===w&&existing.userData.height===h;
 const geometry=reuse?existing!:new THREE.BufferGeometry();
 const positions=reuse?geometry.getAttribute('position') as THREE.BufferAttribute:new THREE.BufferAttribute(new Float32Array(grid.length*3),3);
 const colors=reuse?geometry.getAttribute('color') as THREE.BufferAttribute:new THREE.BufferAttribute(new Float32Array(grid.length*3),3);
 const palette=new Map<number,THREE.Color>();
 const colorFor=(z:number)=>{let c=palette.get(z);if(!c){c=new THREE.Color().setHSL(z<=sea?.13:.29-Math.max(0,z)*.003,z<=sea?.24:.24,z<=sea?.32:.36+Math.max(0,z)*.006);palette.set(z,c);}return c;};
 let minX=w,minY=h,maxX=-1,maxY=-1;
 // Keep pending ranges until Three uploads them; several edits can precede a frame.
 for(let y=0;y<=h;y++){
  let start=-1,end=-1;
  for(let x=0;x<=w;x++){
   const i=y*(w+1)+x,z=grid[i],changed=!reuse||z!==previous![i];
   if(changed){positions.setXYZ(i,x-w/2,z,y-h/2);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
   if(changed||sea!==previousSea){const c=colorFor(z);colors.setXYZ(i,c.r,c.g,c.b);if(start<0)start=i;end=i;}
  }
  if(start>=0){positions.addUpdateRange(start*3,(end-start+1)*3);colors.addUpdateRange(start*3,(end-start+1)*3);}
 }
 if(!reuse){
  const indices=new Uint32Array(w*h*6);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const a=y*(w+1)+x,b=a+1,c=a+w+1,d=c+1,k=(y*w+x)*6;indices[k]=a;indices[k+1]=c;indices[k+2]=b;indices[k+3]=b;indices[k+4]=c;indices[k+5]=d;}
  geometry.setAttribute('position',positions);geometry.setAttribute('color',colors);geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.computeVertexNormals();
  geometry.userData={width:w,height:h};
 }else if(maxX>=0){
  const normals=geometry.getAttribute('normal') as THREE.BufferAttribute;

  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),edge=new THREE.Vector3(),sum=new THREE.Vector3();
  const x0=Math.max(0,minX-1),x1=Math.min(w,maxX+1),y0=Math.max(0,minY-1),y1=Math.min(h,maxY+1);
  for(let y=y0;y<=y1;y++){
   for(let x=x0;x<=x1;x++){
    const vertex=y*(w+1)+x;sum.set(0,0,0);
    for(let cy=Math.max(0,y-1);cy<=Math.min(h-1,y);cy++)for(let cx=Math.max(0,x-1);cx<=Math.min(w-1,x);cx++){
     const aa=cy*(w+1)+cx,bb=aa+1,cc=aa+w+1,dd=cc+1;
     for(const ids of [[aa,cc,bb],[bb,cc,dd]])if(ids.includes(vertex)){
      a.fromBufferAttribute(positions,ids[0]);b.fromBufferAttribute(positions,ids[1]);c.fromBufferAttribute(positions,ids[2]);
      edge.subVectors(c,b);a.sub(b);sum.add(edge.cross(a));
     }
    }
    sum.normalize();normals.setXYZ(vertex,sum.x,sum.y,sum.z);
   }
   normals.addUpdateRange((y*(w+1)+x0)*3,(x1-x0+1)*3);
  }
  normals.needsUpdate=true;
 }
 if(!reuse||maxX>=0||sea!==previousSea){positions.needsUpdate=true;colors.needsUpdate=true;}
 // Heights are native signed-byte values; a stable conservative sphere avoids a full scan.
 geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,0,0),Math.hypot(w/2,h/2,128));
 return geometry;
}
