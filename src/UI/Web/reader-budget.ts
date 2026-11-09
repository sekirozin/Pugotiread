/** Conservative fallback: older browsers often expose neither memory nor connection. */
export type DeviceHints = { deviceMemory?: number; hardwareConcurrency?: number; saveData?: boolean; effectiveType?: string };
export function deviceHints(): DeviceHints {
  if (typeof navigator === 'undefined') return {};
  const device = navigator as Navigator & {deviceMemory?:number;connection?:{saveData?:boolean;effectiveType?:string}};
  return {deviceMemory:device.deviceMemory,hardwareConcurrency:device.hardwareConcurrency,saveData:device.connection?.saveData,effectiveType:device.connection?.effectiveType};
}
export function readerBudget(hints:DeviceHints) {
  const capable=(hints.deviceMemory ?? 0)>=8 && (hints.hardwareConcurrency ?? 0)>=8;
  return {pdfCanvases:capable?6:3,pdfPixels:capable?4_000_000:2_000_000,pdfConcurrency:capable?2:1,pdfMargin:capable?1000:400,imageEntries:capable?8:4,imageBytes:capable?64*1024*1024:24*1024*1024};
}
export function canvasSize(width:number,height:number,dpr:number,maxPixels:number) {
  const scale=Math.min(dpr || 1,2,Math.sqrt(maxPixels/(width*height)));
  return {width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale)),scale};
}
export function canvasPixels(width:number,height:number,dpr:number,maxPixels:number) {
  const size=canvasSize(width,height,dpr,maxPixels);return size.width*size.height;
}
export function imagePrefetchOffsets(hints:DeviceHints,direction:number):number[] {
  if(hints.saveData || hints.effectiveType==='slow-2g' || hints.effectiveType==='2g')return [];
  const step=direction<0?-1:1;
  return hints.effectiveType==='3g'?[step]:[step,2*step,-step];
}
