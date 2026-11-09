import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

/** Byte-bounded LRU, shared promises, and bounded CPU/process concurrency. */
export class ResourceCache {
  private entries=new Map<string,Buffer>();
  private pending=new Map<string,Promise<Buffer|null>>();
  private bytes=0;
  private active=0;
  private waiters:Array<()=>void>=[];
  constructor(private maxBytes:number,private concurrency=2) {}
  async get(key:string,loader:()=>Promise<Buffer|null>):Promise<Buffer|null> {
    const cached=this.entries.get(key);
    if(cached){this.entries.delete(key);this.entries.set(key,cached);return cached;}
    const pending=this.pending.get(key);if(pending)return pending;
    const work=this.load(key,loader);this.pending.set(key,work);
    try{return await work;}finally{this.pending.delete(key);}
  }
  private async load(key:string,loader:()=>Promise<Buffer|null>) {
    if(this.active>=this.concurrency)await new Promise<void>(resolve=>this.waiters.push(resolve));
    else this.active++;
    try {
      const result=await loader();
      if(result && result.length<=this.maxBytes){
        this.entries.set(key,result);this.bytes+=result.length;
        while(this.bytes>this.maxBytes || this.entries.size>256){
          const oldest=this.entries.keys().next().value!;
          this.bytes-=this.entries.get(oldest)!.length;this.entries.delete(oldest);
        }
      }
      return result;
    }finally{const next=this.waiters.shift();if(next)next();else this.active--;}
  }
}
export const epubResourceCache=new ResourceCache(24*1024*1024,2);
const imageCache=new ResourceCache(24*1024*1024,1);
const widths=new Set([640,960,1280,1600,2048]);
export async function pageImageVariant(file:string,widthValue:string|null):Promise<{data:Buffer;etag:string}|null> {
  if(!widthValue || !/^\d+$/.test(widthValue) || !widths.has(Number(widthValue)) || !['.jpg','.jpeg','.png','.webp'].includes(path.extname(file).toLowerCase()))return null;
  const stat=await fs.stat(file);
  const width=Number(widthValue);
  const key=`image-v1:${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${width}`;
  const data=await imageCache.get(key,async()=>{
    const source=sharp(file,{limitInputPixels:64_000_000});
    const meta=await source.metadata();
    // Keep animated, rotated and already-small originals untouched.
    if((meta.pages ?? 1)>1 || (meta.orientation ?? 1)!==1 || !meta.width || meta.width<=width)return Buffer.alloc(0);
    const resized = await source.resize({width,withoutEnlargement:true}).webp({quality:88,effort:2}).toBuffer();
    // Some PNGs compress exceptionally well: never increase transferred bytes.
    return resized.length < stat.size ? resized : Buffer.alloc(0);
  });
  return data?.length?{data,etag:`"${crypto.createHash('sha256').update(key).digest('hex')}"`}:null;
}
