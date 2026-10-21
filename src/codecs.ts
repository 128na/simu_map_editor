import { decodeSample, encodeSamples, LIMITS, validateDimensions, type Heightmap, type Profile } from './terrain.ts';

function requireBytes(data: Uint8Array, offset: number, count: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + count > data.length) throw new Error('画像データが途中で切れています');
}
function mapFromSamples(width: number, height: number, samples: Uint8Array, profile: Profile): Heightmap {
  validateDimensions(width, height);
  const table=Array.from({length:256},(_,v)=>decodeSample(v,profile));
  return { width, height, heights: Float32Array.from(samples, value => table[value]) };
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function pngSamples(data: Uint8Array, checkDimensions?:(w:number,h:number)=>void): Promise<{width: number; height: number; samples: Uint8Array}> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8, width = 0, height = 0, channels = 0, ended = false;
  const compressed: Uint8Array[] = [];
  let seenIdat = false, closedIdat = false;
  while (offset < data.length) {
    requireBytes(data, offset, 12);
    const size = view.getUint32(offset);
    requireBytes(data, offset, size + 12);
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    const body = data.subarray(offset + 8, offset + 8 + size);
    if (crc32(data.subarray(offset + 4, offset + 8 + size)) !== view.getUint32(offset + 8 + size)) throw new Error('PNGのCRCが一致しません');
    if (offset === 8 && type !== 'IHDR') throw new Error('PNGのヘッダが不正です');
    if (seenIdat && type !== 'IDAT') closedIdat = true;
    if (type === 'IHDR') {
      if (offset !== 8 || size !== 13) throw new Error('PNGのヘッダが不正です');
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      validateDimensions(width, height);
      if (body[8] !== 8) throw new Error('試作版は8bit PNGのみ対応しています（16bitは未対応）');
      channels = body[9] === 0 ? 1 : body[9] === 2 ? 3 : body[9] === 6 ? 4 : 0;
      if (!channels || body[10] || body[11] || body[12]) throw new Error('試作版は非インターレースの灰階・RGB・RGBA PNGに対応しています');
      checkDimensions?.(width,height);
    } else if (type === 'IDAT') {
      if (!channels || closedIdat) throw new Error('PNGのIDAT順序が不正です');
      seenIdat = true; compressed.push(body);
    } else if (type === 'IEND') {
      if (size !== 0 || !seenIdat) throw new Error('PNGの終端が不正です');
      ended = true; offset += 12; break;
    } else if (type === 'tRNS') {
      throw new Error('透明度を指定したPNGは試作版では未対応です');
    } else if ((type.charCodeAt(0) & 32) === 0) {
      throw new Error(`未対応のPNGチャンクです: ${type}`);
    }
    offset += size + 12;
  }
  if (!ended || offset !== data.length) throw new Error('PNGの終端が不正です');
  const stride = width * channels, expectedSize = (stride + 1) * height;
  const joined = new Uint8Array(compressed.reduce((sum, part) => sum + part.length, 0));
  let write = 0;
  for (const part of compressed) { joined.set(part, write); write += part.length; }
  const reader = new Blob([joined.buffer]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const filtered = new Uint8Array(expectedSize);
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (received + value.length > expectedSize) throw new Error('PNGの展開サイズがヘッダと一致しません');
      filtered.set(value, received); received += value.length;
    }
  } catch (error) { await reader.cancel(); throw error; }
  if (received !== expectedSize) throw new Error('PNGの展開データが途中で切れています');
  const samples = new Uint8Array(width * height);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1), filter = filtered[base];
    if (filter > 4) throw new Error('PNGのフィルタが不正です');
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x-channels] : 0;
      const up = previous[x], corner = x >= channels ? previous[x-channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      if (filter === 2) prediction = up;
      if (filter === 3) prediction = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - corner, a = Math.abs(p-left), b = Math.abs(p-up), c = Math.abs(p-corner);
        prediction = a <= b && a <= c ? left : b <= c ? up : corner;
      }
      row[x] = filtered[base + 1 + x] + prediction;
    }
    for (let x = 0; x < width; x++) {
      if (channels === 4 && row[x*4+3] !== 255) throw new Error('半透明PNGは試作版では未対応です');
      samples[x+y*width] = row[x*channels];
    }
    previous = row;
  }
  return { width, height, samples };
}
function bmpSamples(data: Uint8Array, checkDimensions?:(w:number,h:number)=>void): {width: number; height: number; samples: Uint8Array} {
  requireBytes(data, 0, 54);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offset = view.getUint32(10, true), dibSize = view.getUint32(14, true);
  const width = view.getInt32(18, true), signedHeight = view.getInt32(22, true), height = Math.abs(signedHeight);
  validateDimensions(width, height);
  if (dibSize < 40) throw new Error('未対応のBMPヘッダです');
  requireBytes(data, 14, dibSize);
  const depth = view.getUint16(28, true), compression = view.getUint32(30, true);
  if (view.getUint16(26,true) !== 1 || !(depth === 24 && compression === 0 || depth === 8 && (compression === 0 || compression === 1))) throw new Error('BMPは8bit無圧縮/RLE8または24bit無圧縮を選んでください');
  checkDimensions?.(width,height);
  const samples = new Uint8Array(width * height);
  let palette: Uint8Array | undefined;
  let headerEnd = 14 + dibSize;
  if (depth === 8) {
    const colors = view.getUint32(46, true) || 256;
    if (colors > 256) throw new Error('BMPのパレットが不正です');
    requireBytes(data, headerEnd, colors * 4);
    palette = new Uint8Array(colors);
    for (let i=0;i<colors;i++) palette[i] = data[headerEnd + i*4+2];
    headerEnd += colors*4;
  }
  if (offset < headerEnd || offset > data.length) throw new Error('BMPの画素位置が不正です');
  const paletteRed = (index: number) => {
    if (!palette || index >= palette.length) throw new Error('BMPのパレット番号が不正です');
    return palette[index];
  };
  if (compression === 0) {
    const pitch = Math.ceil(width * depth / 32) * 4;
    requireBytes(data, offset, pitch * height);
    for(let row=0;row<height;row++) {
      const y = signedHeight < 0 ? row : height-row-1;
      for(let x=0;x<width;x++) samples[x+y*width] = depth===24 ? data[offset+row*pitch+x*3+2] : paletteRed(data[offset+row*pitch+x]);
    }
  } else {
    if (signedHeight < 0) throw new Error('上下反転RLE BMPは試作版では未対応です');
    samples.fill(paletteRed(0));
    let cursor = offset, x = 0, row = 0, ended = false;
    const put = (index: number) => {
      if (x>=width || row>=height) throw new Error('BMPのRLE範囲が不正です');
      samples[x+++(height-row-1)*width] = paletteRed(index);
    };
    while(cursor<data.length) {
      requireBytes(data,cursor,2);
      const count=data[cursor++], command=data[cursor++];
      if(count) { for(let i=0;i<count;i++) put(command); }
      else if(command===0) { x=0; row++; }
      else if(command===1) { ended=true; break; }
      else if(command===2) { throw new Error('RLEのdelta命令は試作版では未対応です'); }
      else {
        requireBytes(data,cursor,command+(command&1));
        for(let i=0;i<command;i++) put(data[cursor++]);
        cursor += command&1;
      }
    }
    if(!ended) throw new Error('BMPのRLE終端がありません');
  }
  return { width, height, samples };
}
function ppmSamples(data: Uint8Array, checkDimensions?:(w:number,h:number)=>void): {width: number; height: number; samples: Uint8Array} {
  let cursor = 0;
  const whitespace = (v: number) => [9,10,11,12,13,32].includes(v);
  const token = () => {
    while(cursor<data.length) {
      if(whitespace(data[cursor])) cursor++;
      else if(data[cursor]===35) { while(cursor<data.length && data[cursor]!==10) cursor++; }
      else break;
    }
    const begin=cursor;
    while(cursor<data.length && !whitespace(data[cursor]) && data[cursor]!==35) cursor++;
    return new TextDecoder('ascii').decode(data.subarray(begin,cursor));
  };
  if(token()!=='P6') throw new Error('PPMはバイナリP6を選んでください');
  const width=Number(token()),height=Number(token()),max=Number(token());
  validateDimensions(width,height);
  if(max!==255) throw new Error('PPMの最大値は255にしてください');
  checkDimensions?.(width,height);
  if(!whitespace(data[cursor])) throw new Error('PPMヘッダの区切りが不正です');
  if(data[cursor]===13 && data[cursor+1]===10) cursor+=2; else cursor++;
  requireBytes(data,cursor,width*height*3);
  const samples=new Uint8Array(width*height);
  for(let i=0;i<samples.length;i++) samples[i]=data[cursor+i*3];
  return {width,height,samples};
}
export async function decodeHeightmap(data: Uint8Array, profile: Profile, checkDimensions?:(w:number,h:number)=>void): Promise<Heightmap> {
  if(data.length>LIMITS.maxFileBytes) throw new Error(`画像ファイルは${LIMITS.maxFileBytes/1048576} MiB以下にしてください`);
  let image: {width:number;height:number;samples:Uint8Array};
  if(data[0]===137 && data[1]===80 && data[2]===78 && data[3]===71 && data[4]===13 && data[5]===10 && data[6]===26 && data[7]===10) image=await pngSamples(data,checkDimensions);
  else if(data[0]===66 && data[1]===77) image=bmpSamples(data,checkDimensions);
  else if(data[0]===80 && data[1]===54) image=ppmSamples(data,checkDimensions);
  else throw new Error('PNG・BMP・PPM P6の画像を選んでください');
  return mapFromSamples(image.width,image.height,image.samples,profile);
}
export async function importHeightmap(file: File, profile: Profile, checkDimensions?:(w:number,h:number)=>void): Promise<Heightmap> {
  if(file.size>LIMITS.maxFileBytes) throw new Error(`画像ファイルは${LIMITS.maxFileBytes/1048576} MiB以下にしてください`);
  return decodeHeightmap(new Uint8Array(await file.arrayBuffer()),profile,checkDimensions);
}
export function exportBmp(map: Heightmap, profile: Profile): Uint8Array {
  validateDimensions(map.width,map.height);
  const samples=encodeSamples(map,profile),pitch=Math.ceil(map.width*3/4)*4;
  const data=new Uint8Array(54+pitch*map.height), view=new DataView(data.buffer);
  data.set([66,77]); view.setUint32(2,data.length,true); view.setUint32(10,54,true); view.setUint32(14,40,true);
  view.setInt32(18,map.width,true); view.setInt32(22,map.height,true); view.setUint16(26,1,true); view.setUint16(28,24,true); view.setUint32(34,pitch*map.height,true);
  for(let y=0;y<map.height;y++) for(let x=0;x<map.width;x++) {
    const sample=samples[x+y*map.width], offset=54+(map.height-y-1)*pitch+x*3;
    data[offset]=data[offset+1]=data[offset+2]=sample;
  }
  return data;
}

/** Encode raw 8-bit grayscale samples, without canvas color conversion or metadata. */
export async function exportPng(map:Heightmap, profile:Profile):Promise<Uint8Array> {
  const samples=encodeSamples(map,profile);
  const rows=new Uint8Array((map.width+1)*map.height);
  for(let y=0;y<map.height;y++)rows.set(samples.subarray(y*map.width,(y+1)*map.width),y*(map.width+1)+1);
  const compressed=new Uint8Array(await new Response(new Blob([rows.buffer]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const chunk=(type:string,body:Uint8Array)=>{
    const bytes=new Uint8Array(body.length+12),view=new DataView(bytes.buffer);
    view.setUint32(0,body.length);for(let i=0;i<4;i++)bytes[4+i]=type.charCodeAt(i);
    bytes.set(body,8);view.setUint32(body.length+8,crc32(bytes.subarray(4,body.length+8)));return bytes;
  };
  const header=new Uint8Array(13),view=new DataView(header.buffer);
  view.setUint32(0,map.width);view.setUint32(4,map.height);header[8]=8;
  const chunks=[Uint8Array.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',compressed),chunk('IEND',new Uint8Array())];
  const bytes=new Uint8Array(chunks.reduce((sum,c)=>sum+c.length,0));let offset=0;
  for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return bytes;
}
