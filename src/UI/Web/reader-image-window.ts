/** Release distant decoded images while retaining their exact intrinsic geometry. */
export function observeReaderImages(stage:HTMLElement):()=>void {
  const sources=new WeakMap<HTMLImageElement,string>();
  const nearby=new WeakSet<HTMLImageElement>();
  const listeners:Array<()=>void>=[];
  function release(image:HTMLImageElement) {
    if(nearby.has(image) || image.dataset.readerPlaceholder || !image.complete || !image.naturalWidth || !image.naturalHeight)return;
    sources.set(image,image.src);
    image.dataset.readerPlaceholder='true';
    // Empty SVG keeps intrinsic width/height, unlike a 1x1 spacer which changes layout.
    image.src=`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${image.naturalWidth}" height="${image.naturalHeight}"/>`)}`;
  }
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries){
      const image=entry.target as HTMLImageElement;
      if(entry.isIntersecting){
        nearby.add(image);
        const source=sources.get(image);
        if(source && image.dataset.readerPlaceholder){delete image.dataset.readerPlaceholder;image.src=source;}
      }else{nearby.delete(image);release(image);}
    }
  },{root:stage,rootMargin:'800px 0px'});
  for(const image of Array.from(stage.querySelectorAll<HTMLImageElement>('img.vertical-page'))){
    const loaded=()=>release(image);
    image.addEventListener('load',loaded);listeners.push(()=>image.removeEventListener('load',loaded));
    observer.observe(image);
  }
  return ()=>{observer.disconnect();for(const remove of listeners)remove();};
}
