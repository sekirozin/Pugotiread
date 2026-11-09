(() => {
  if (document.querySelector('#pugotilab-ambient')) return;
  const style = document.createElement('style');
  style.textContent = '#pugotilab-ambient{position:fixed;inset:0;z-index:0;width:100%;height:100%;pointer-events:none;opacity:.78}body>*:not(#pugotilab-ambient):not(script):not(style):not(link){position:relative;z-index:1}@media(prefers-reduced-motion:reduce){#pugotilab-ambient{opacity:.55}}';
  document.head.append(style);
  const canvas = document.createElement('canvas');
  canvas.id = 'pugotilab-ambient';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Temas Pugotilab (PQA-286): partículas e cometa na cor do tema (--pt-particula / --pt-brilho, RGB); sem o menu da
  // conta, o azul original.
  const css = (nome, padrao) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim() || padrao;
  const coresDoTema = () => { const c = css('--pt-particula', ''); return c ? [c] : ['96,165,250','59,130,246','37,99,235','125,211,252','147,197,253']; };
  let colors = coresDoTema();
  document.addEventListener('pugoti:paleta', () => { colors = coresDoTema(); for (const p of particles) p.c = colors[Math.floor(Math.random() * colors.length)]; });
  let particles = [], width = 0, height = 0, frame = 0, comet = null;
  let nextCometAt = performance.now() + 5500 + Math.random() * 6500;
  const make = (randomY = true) => {
    const depth = .45 + Math.random() * .9;
    return { x:Math.random()*width, y:randomY?Math.random()*height:height+12, r:(.55+Math.random()*1.65)*depth, vx:(-.04+Math.random()*.1)*depth, vy:(-.055-Math.random()*.14)*depth, a:(.12+Math.random()*.27)*depth, s:Math.random()*6.283, ss:.006+Math.random()*.014, c:colors[Math.floor(Math.random()*colors.length)] };
  };
  function resize() {
    width=innerWidth; height=innerHeight; const dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.round(width*dpr); canvas.height=Math.round(height*dpr); canvas.style.width=width+'px'; canvas.style.height=height+'px'; context.setTransform(dpr,0,0,dpr,0,0);
    const count=Math.min(175,Math.max(55,Math.round(width*height/(width<700?7500:5200))));
    particles=Array.from({length:count},()=>make(true));
  }
  function spawnComet(now) {
    const leftToRight=Math.random()>.5, angle=.16+Math.random()*.18, speed=8+Math.random()*4.5, direction=leftToRight?1:-1;
    comet={x:leftToRight?-180:width+180,y:height*(.12+Math.random()*.58),vx:speed*direction,vy:speed*angle*(Math.random()>.35?1:-1),length:150+Math.random()*130,radius:2.1+Math.random()*1.8,life:0,maxLife:Math.max(1300,width/speed*18),born:now};
  }
  function drawComet(now) {
    if (reduced) return;
    if (!comet && now >= nextCometAt) spawnComet(now);
    if (!comet) return;
    comet.x+=comet.vx; comet.y+=comet.vy; comet.life=now-comet.born;
    const progress=comet.life/comet.maxLife, fade=Math.min(1,progress*5,Math.max(0,(1-progress)*5));
    const magnitude=Math.hypot(comet.vx,comet.vy), ux=comet.vx/magnitude, uy=comet.vy/magnitude;
    const tailX=comet.x-ux*comet.length, tailY=comet.y-uy*comet.length;
    const gradient=context.createLinearGradient(tailX,tailY,comet.x,comet.y);
    const cor = css('--pt-particula', '96,165,250'), brilho = css('--pt-brilho', '224,242,254'); gradient.addColorStop(0,`rgba(${cor},0)`); gradient.addColorStop(.55,`rgba(${cor},${.1*fade})`); gradient.addColorStop(1,`rgba(${brilho},${.9*fade})`);
    context.save(); context.globalCompositeOperation='screen'; context.lineCap='round'; context.strokeStyle=gradient; context.lineWidth=comet.radius*1.7; context.shadowColor=`rgba(${cor},${.8*fade})`; context.shadowBlur=18;
    context.beginPath(); context.moveTo(tailX,tailY); context.lineTo(comet.x,comet.y); context.stroke();
    context.fillStyle=`rgba(239,246,255,${fade})`; context.beginPath(); context.arc(comet.x,comet.y,comet.radius,0,6.283); context.fill(); context.restore();
    if(progress>=1||comet.x < -320||comet.x > width+320||comet.y < -220||comet.y > height+220){comet=null;nextCometAt=now+9000+Math.random()*15000}
  }
  function draw(now=performance.now()) {
    context.clearRect(0,0,width,height);
    for(const p of particles){p.x+=p.vx;p.y+=p.vy;p.s+=p.ss;if(p.y< -12||p.x< -16||p.x>width+16)Object.assign(p,make(false));const alpha=p.a*(.72+Math.sin(p.s)*.28);context.beginPath();context.arc(p.x,p.y,p.r,0,6.283);context.fillStyle=`rgba(${p.c},${alpha})`;context.shadowColor=`rgba(${p.c},${alpha*.6})`;context.shadowBlur=p.r>1.2?8:4;context.fill()}
    context.shadowBlur=0; drawComet(now); if(!reduced) frame=requestAnimationFrame(draw);
  }
  new ResizeObserver(resize).observe(document.documentElement); resize(); draw();
  if(!reduced) document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(frame);if(!document.hidden)draw()});
})();
