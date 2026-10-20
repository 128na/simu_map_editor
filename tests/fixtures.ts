import { deflateSync } from 'node:zlib';
export function crc32(data: Uint8Array): number {
  let crc=0xffffffff;
  for(const byte of data) { crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
export function chunk(type: string, data: Uint8Array): Buffer {
  const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);
  length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([length,name,data,crc]);
}
export function pngFixture(width: number,height: number,channels=3,metadata=false,transparent=false): {bytes: Buffer; red: number[]} {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=channels===1?0:channels===3?2:6;
  let previous=new Uint8Array(width*channels);const rows:Buffer[]=[],red:number[]=[];
  for(let y=0;y<height;y++) {
    const raw=new Uint8Array(width*channels);
    for(let x=0;x<width;x++) {
      const r=(x*31+y*47)%256;red.push(r);
      if(channels===1)raw[x]=r;else{raw[x*channels]=r;raw[x*channels+1]=255-r;raw[x*channels+2]=(r*3)%256;if(channels===4)raw[x*4+3]=transparent?127:255;}
    }
    const filter=y%5,encoded=new Uint8Array(raw.length+1);encoded[0]=filter;
    for(let x=0;x<raw.length;x++) {
      const left=x>=channels?raw[x-channels]:0,up=previous[x],corner=x>=channels?previous[x-channels]:0;
      let prediction=0;
      if(filter===1)prediction=left;
      if(filter===2)prediction=up;
      if(filter===3)prediction=Math.floor((left+up)/2);
      if(filter===4){const p=left+up-corner,a=Math.abs(p-left),b=Math.abs(p-up),c=Math.abs(p-corner);prediction=a<=b&&a<=c?left:b<=c?up:corner;}
      encoded[x+1]=(raw[x]-prediction)&255;
    }
    rows.push(Buffer.from(encoded));previous=raw;
  }
  const gamma=Buffer.alloc(4);gamma.writeUInt32BE(100000);
  return {bytes:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(metadata?[chunk('gAMA',gamma)]:[]),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]),red};
}

export function rleAbsoluteFixture(width:number,height:number):{bytes:Buffer;red:number[]} {
  const red=Array.from({length:width*height},(_,i)=>(i*37+Math.floor(i/width)*11)%256);
  const header=Buffer.alloc(54+1024),rows:Buffer[]=[];
  header.write('BM');header.writeUInt32LE(54+1024,10);header.writeUInt32LE(40,14);header.writeInt32LE(width,18);header.writeInt32LE(height,22);header.writeUInt16LE(1,26);header.writeUInt16LE(8,28);header.writeUInt32LE(1,30);header.writeUInt32LE(256,46);
  for(let i=0;i<256;i++)header.set([255-i,255-i,255-i,0],54+i*4);
  for(let y=height-1;y>=0;y--)rows.push(Buffer.from([0,width,...red.slice(y*width,(y+1)*width).map(v=>255-v),...(width%2?[0]:[]),0,0]));
  rows.push(Buffer.from([0,1]));const data=Buffer.concat(rows);header.writeUInt32LE(header.length+data.length,2);header.writeUInt32LE(data.length,34);
  return {bytes:Buffer.concat([header,data]),red};
}
