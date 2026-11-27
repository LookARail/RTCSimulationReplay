"use strict";
/* Stringline (time–distance) pane docked beside the map.
   Shares the model, replay time, selection and hover with replay.js (loaded first).
   The distance axis is a corridor between two chosen locations: the shortest connected track path
   between them, which may cross several subdivisions. Within each subdivision, distance comes from the
   NODE file's field markers; subdivisions are chained end to end where the path crosses between them. */
const Stringline=(()=>{
  const pane=$('#stringline'),plot=$('#slSvg'),SVGNS='http://www.w3.org/2000/svg',fin=Number.isFinite;
  const STEPS=[60,120,300,600,900,1800,3600,7200,10800,21600,43200,86400];
  const M={l:150,r:12,t:10,b:24};
  const el=(tag,attrs={})=>{const e=document.createElementNS(SVGNS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e};
  const fmtMP=m=>String(Number(m.toFixed(2)));
  const trunc=(s,n)=>s.length>n?s.slice(0,n-1)+'…':s;
  const marked=n=>n&&n.subdivision&&fin(n.fieldMarker);

  let open=false,adj=null,stops=new Map(),segs=[],dist=new Map(),locs=[],series=[],dom=null,vw=null,G=null,drag=null,raf=0,lastSel=null,lines=new Map();
  const clipRect=el('rect'),clip=el('clipPath',{id:'slClip'}),defs=el('defs');clip.append(clipRect);defs.append(clip);
  const gGrid=el('g',{class:'sl-grid'}),gAxis=el('g',{class:'sl-axis'}),gPlot=el('g',{'clip-path':'url(#slClip)'}),
        gLines=el('g',{class:'sl-lines'}),gLabels=el('g',{class:'sl-labels'}),gHit=el('g',{class:'sl-hit'}),gNow=el('g',{class:'sl-now'});
  gPlot.append(gLines,gLabels,gHit,gNow);plot.append(defs,gGrid,gPlot,gAxis);

  const X=t=>M.l+(t-vw.t0)/(vw.t1-vw.t0)*G.pw, Y=d=>M.t+(d-vw.d0)/(vw.d1-vw.d0)*G.ph;
  const T=x=>vw.t0+(x-M.l)/G.pw*(vw.t1-vw.t0), D=y=>vw.d0+(y-M.t)/G.ph*(vw.d1-vw.d0);
  const dOf=id=>dist.has(id)?dist.get(id):null;

  /* ---------- corridor ---------- */
  function buildGraph(){
    adj=new Map();const add=(a,b,w)=>{if(!adj.has(a))adj.set(a,[]);adj.get(a).push([b,w])};
    for(const l of model.links.links){const a=nodeOf(l.a),b=nodeOf(l.b);if(!marked(a)||!marked(b))continue;const w=l.d>0?l.d:.001;add(l.a,l.b,w);add(l.b,l.a,w)}
  }
  function shortestPath(a,b){
    const best=new Map([[a,0]]),prev=new Map(),heap=[[0,a]];
    const push=(d,id)=>{heap.push([d,id]);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p][0]<=heap[i][0])break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p}};
    const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){heap[0]=last;for(let i=0;;){const l=2*i+1,r=l+1;let m=i;if(l<heap.length&&heap[l][0]<heap[m][0])m=l;if(r<heap.length&&heap[r][0]<heap[m][0])m=r;if(m===i)break;[heap[m],heap[i]]=[heap[i],heap[m]];i=m}}return top};
    while(heap.length){const [d,id]=pop();if(id===b)break;if(d>best.get(id))continue;for(const [n,w] of adj.get(id)||[]){const nd=d+w;if(nd<(best.has(n)?best.get(n):Infinity)){best.set(n,nd);prev.set(n,id);push(nd,n)}}}
    if(!best.has(b))return null;const path=[b];while(path[path.length-1]!==a)path.push(prev.get(path[path.length-1]));return path.reverse();
  }
  /* Split the path into per-subdivision sections and give every marked node on those sections a corridor distance. */
  function buildCorridor(fromId,toId){
    segs=[];dist=new Map();locs=[];
    const path=fromId===toId?null:shortestPath(fromId,toId);if(!path)return false;
    for(const id of path){const n=nodeOf(id),s=segs[segs.length-1];if(s&&s.sub===n.subdivision)s.exit=n.fieldMarker;else segs.push({sub:n.subdivision,enter:n.fieldMarker,exit:n.fieldMarker})}
    // fold zero-length detours (e.g. a junction node coded to another subdivision) back into the surrounding section
    const folded=[];
    segs.forEach((s,i)=>{if(i>0&&i<segs.length-1&&Math.abs(s.exit-s.enter)<1e-6)return;const p=folded[folded.length-1];if(p&&p.sub===s.sub)p.exit=s.exit;else folded.push(s)});
    segs=folded;let cum=0;for(const s of segs){s.cum=cum;s.lo=Math.min(s.enter,s.exit);s.hi=Math.max(s.enter,s.exit);cum+=s.hi-s.lo}
    const byName=new Map();
    for(const n of model.nodes.list){
      if(!marked(n))continue;
      for(const s of segs){
        if(s.sub!==n.subdivision||n.fieldMarker<s.lo-1e-6||n.fieldMarker>s.hi+1e-6)continue;
        const d=s.cum+Math.abs(n.fieldMarker-s.enter);dist.set(n.id,d);
        if(n.name){const k=s.sub+'|'+n.name.toUpperCase();if(!byName.has(k))byName.set(k,{name:n.name,d,m:n.fieldMarker,sub:s.sub,major:STATION_RE.test(n.name)})}
        break;
      }
    }
    // path nodes left unmapped by folding take their neighbour's distance, so trains through them stay continuous
    path.forEach((id,i)=>{if(!dist.has(id)){const p=path[i-1],q=path[i+1];const d=dist.has(p)?dist.get(p):dist.get(q);if(d!==undefined)dist.set(id,d)}});
    locs=[...byName.values()].sort((a,b)=>a.d-b.d);
    dom={t0:tMin,t1:tMax,d0:0,d1:Math.max(cum,.2),total:Math.max(cum,.2)};return true;
  }
  /* Picker locations: stations, plus each subdivision's first and last named node. */
  function buildStops(){
    const bySub=new Map();
    for(const n of model.nodes.list){if(!marked(n)||!n.name||!adj.has(n.id))continue;if(!bySub.has(n.subdivision))bySub.set(n.subdivision,[]);bySub.get(n.subdivision).push(n)}
    stops=new Map();const groups=[];
    for(const sub of [...bySub.keys()].sort((a,b)=>a.localeCompare(b))){
      const ns=bySub.get(sub).sort((a,b)=>a.fieldMarker-b.fieldMarker),pick=new Map();
      for(const n of [ns[0],...ns.filter(n=>STATION_RE.test(n.name)),ns[ns.length-1]]){const k=n.name.toUpperCase();if(!pick.has(k))pick.set(k,n)}
      const list=[...pick.values()].sort((a,b)=>a.fieldMarker-b.fieldMarker);for(const n of list)stops.set(n.id,n);groups.push([sub,list]);
    }
    for(const id of ['#slFrom','#slTo']){
      const s=$(id);s.replaceChildren(...groups.map(([sub,list])=>{const g=document.createElement('optgroup');g.label=sub;for(const n of list)g.append(new Option(n.name+' · MP '+fmtMP(n.fieldMarker),n.id));return g}));
    }
  }
  /* Default: the two ends of the subdivision with the most recorded train movements. */
  function defaultEnds(){
    const count=new Map();for(const t of model.history.trains)for(const e of t.events){const n=nodeOf(e.id);if(marked(n))count.set(n.subdivision,(count.get(n.subdivision)||0)+1)}
    const top=[...count].sort((a,b)=>b[1]-a[1])[0];if(!top)return null;
    const list=[...stops.values()].filter(n=>n.subdivision===top[0]);if(list.length<2)return null;
    return [list[list.length-1].id,list[0].id];
  }
  /* One polyline per train: dwells are flat, runs join consecutive linked nodes inside the corridor. */
  function buildSeries(){
    series=[];const graph=model.links.graph;
    if(segs.length)for(const train of model.history.trains){
      if(!inScope(train))continue;const es=train.events,parts=[];
      for(let i=0;i<es.length;i++){
        const e=es[i],a=dOf(e.id);if(a===null)continue;
        if(e.departure>e.arrival)parts.push([e.arrival,a,e.departure,a]);
        const nx=es[i+1];if(!nx)continue;const b=dOf(nx.id);
        if(b!==null&&graph.get(e.id)?.has(nx.id))parts.push([e.departure,a,nx.arrival,b]);
      }
      if(parts.length)series.push({train,parts,t0:parts[0][0],t1:parts[parts.length-1][2]});
    }
    const subs=segs.length;
    $('#slMeta').textContent=!subs?'':series.length+' train'+(series.length===1?'':'s')+' · '+(subs>1?subs+' subdivisions':segs[0].sub);
    $('#slMeta').title=segs.map(s=>s.sub+' MP '+fmtMP(s.enter)+'–'+fmtMP(s.exit)).join('\n');
  }
  function setEmpty(msg){const e=$('#slEmpty');e.hidden=!msg;e.textContent=msg||''}

  /* ---------- map ---------- */
  function corridor(){
    corridorLayer.replaceChildren();if(!open||!segs.length)return null;
    const seen=new Set(),frag=document.createDocumentFragment();let a=Infinity,b=-Infinity,c=Infinity,d=-Infinity;
    for(const l of model.links.links){
      if(!dist.has(l.a)||!dist.has(l.b))continue;const key=l.a<l.b?l.a+'|'+l.b:l.b+'|'+l.a;if(seen.has(key))continue;seen.add(key);
      const p=nodeOf(l.a),q=nodeOf(l.b);frag.append(svg('line',{x1:p.x,y1:p.y,x2:q.x,y2:q.y}));
      a=Math.min(a,p.x,q.x);b=Math.max(b,p.x,q.x);c=Math.min(c,p.y,q.y);d=Math.max(d,p.y,q.y);
    }
    corridorLayer.append(frag);return a<Infinity?{a,b,c,d}:null;
  }
  function frameCorridor(){const r=corridor();if(r){fitBounds(r.a,r.b,r.c,r.d,fitUpp*80);updateView();render()}}
  /* Bring a train into the free part of the map if it is off-screen. */
  function reveal(symbol){
    const p=position(model.trainBySymbol.get(symbol),currentTime());if(!p||p.missing)return;
    const u=upp(),ins=insets(),W=map.clientWidth,H=map.clientHeight,sx=(p.x-view.x)/u,sy=(p.y-view.y)/u;
    if(sx>ins.left&&sx<W-ins.right&&sy>ins.top&&sy<H-ins.bottom)return;
    view.x=p.x-(ins.left+(W-ins.left-ins.right)/2)*u;view.y=p.y-(ins.top+(H-ins.top-ins.bottom)/2)*u;updateView();render();
  }

  /* ---------- drawing ---------- */
  function draw(){
    if(!open||!vw)return;const W=plot.clientWidth,H=plot.clientHeight;if(W<40||H<40)return;
    M.l=Math.round(clamp(W*.3,112,190));G={W,H,pw:W-M.l-M.r,ph:H-M.t-M.b};
    plot.setAttribute('viewBox',`0 0 ${W} ${H}`);for(const [k,v] of [['x',M.l],['y',M.t],['width',G.pw],['height',G.ph]])clipRect.setAttribute(k,v);
    gGrid.replaceChildren();gAxis.replaceChildren();gLines.replaceChildren();gLabels.replaceChildren();gHit.replaceChildren();lines=new Map();
    if(!segs.length){gNow.replaceChildren();return}

    // time grid, aligned to the displayed (Eastern) clock; midnights are emphasised
    const span=vw.t1-vw.t0,step=STEPS.find(s=>s/span*G.pw>=66)||86400;
    for(let k=Math.ceil((vw.t0+TZ_OFFSET)/step)*step;k-TZ_OFFSET<=vw.t1;k+=step){
      const t=k-TZ_OFFSET,x=X(t),day=mod(k,86400)===0,c=clockParts(t);
      gGrid.append(el('line',{x1:x,x2:x,y1:M.t,y2:M.t+G.ph,class:day?'day':''}));
      const lab=el('text',{x,y:H-7,'text-anchor':'middle',class:day?'day':''});lab.textContent=day?'Day '+c.day:c.hms.slice(0,5);gAxis.append(lab);
    }
    // subdivision sections: a boundary rule and the subdivision name at the top of each section
    const inView=d=>d>=vw.d0&&d<=vw.d1,placed=[];
    if(segs.length>1)segs.forEach((s,i)=>{
      const y0=Y(s.cum),y1=Y(s.cum+s.hi-s.lo);if(y1<M.t||y0>M.t+G.ph)return;
      if(i>0&&inView(s.cum))gGrid.append(el('line',{x1:0,x2:M.l+G.pw,y1:y0,y2:y0,class:'bound'}));
      const ty=Math.max(y0,M.t)+11;if(Math.min(y1,M.t+G.ph)-ty>4){const t=el('text',{x:M.l+6,y:ty,class:'sub'});t.textContent=s.sub;gLabels.append(t)}
    });
    // location rows: stations first, then other named nodes where there is room
    const chars=Math.max(6,Math.floor((M.l-52)/6.4)),vis=locs.filter(l=>inView(l.d));
    for(const l of [...vis.filter(l=>l.major),...vis.filter(l=>!l.major)]){
      const y=Y(l.d);if(placed.some(p=>Math.abs(p-y)<15))continue;placed.push(y);
      gGrid.append(el('line',{x1:M.l,x2:M.l+G.pw,y1:y,y2:y,class:l.major?'stn':''}));
      const name=el('text',{x:M.l-44,y:y+3.5,'text-anchor':'end',class:l.major?'stn':''}),mp=el('text',{x:M.l-8,y:y+3.5,'text-anchor':'end',class:'mp'});
      name.textContent=trunc(l.name,chars);mp.textContent=fmtMP(l.m);gAxis.append(name,mp);
      const tt=el('title');tt.textContent=l.name+' · '+l.sub+' MP '+fmtMP(l.m);name.append(tt);
    }
    gGrid.append(el('rect',{x:M.l,y:M.t,width:G.pw,height:G.ph,class:'frame'}));

    // train lines (+ wide invisible hit paths), and the best visible stretch of each line for its label
    const cands=[];
    for(const s of series){
      if(s.t1<vw.t0||s.t0>vw.t1)continue;let d='',lx=NaN,ly=NaN,run=null,best=null;
      for(const [a,b,c,e] of s.parts){
        if(c<vw.t0||a>vw.t1)continue;const x1=X(a),y1=Y(b),x2=X(c),y2=Y(e),joined=Math.abs(lx-x1)<.5&&Math.abs(ly-y1)<.5;
        d+=(joined?'':'M'+x1.toFixed(1)+' '+y1.toFixed(1))+'L'+x2.toFixed(1)+' '+y2.toFixed(1);lx=x2;ly=y2;
        // continuous visible stretches of the line, used to place its label
        const inside=Math.min(x1,x2)>M.l+12&&Math.max(x1,x2)<M.l+G.pw-12&&Math.min(y1,y2)>M.t+8&&Math.max(y1,y2)<M.t+G.ph-8,l=Math.hypot(x2-x1,y2-y1);
        if(!inside){run=null;continue}
        if(run&&joined){run.pts.push([x2,y2]);run.len+=l}else{run={pts:[[x1,y1],[x2,y2]],len:l}}
        if(!best||run.len>best.len)best=run;
      }
      if(!d)continue;const sym=s.train.symbol;
      const line=el('path',{d,class:s.train.via?'via':'frt'});gLines.append(line);gHit.append(el('path',{d,'data-train':sym}));lines.set(sym,line);
      const need=sym.length*5.9+16;
      if(best&&best.len>need){const h=best.len/2,[x,y]=pointAt(best,h),p0=pointAt(best,h-need/2),p1=pointAt(best,h+need/2);
        cands.push({x,y,ang:Math.atan2(p1[1]-p0[1],p1[0]-p0[0]),len:best.len,sym,via:s.train.via,rank:sym===selected?2:sym===hovered?1:0})}
    }
    placeLabels(cands);paintState();drawNow(currentTime());
  }
  function pointAt(run,s){
    s=clamp(s,0,run.len);let acc=0;
    for(let i=1;i<run.pts.length;i++){const [ax,ay]=run.pts[i-1],[bx,by]=run.pts[i],l=Math.hypot(bx-ax,by-ay);if(acc+l>=s){const f=l?(s-acc)/l:0;return [ax+(bx-ax)*f,ay+(by-ay)*f]}acc+=l}
    return run.pts[run.pts.length-1];
  }
  /* Labels run along their line, kept upright; overlapping ones are dropped (the selected train always keeps its label). */
  function placeLabels(cands){
    cands.sort((a,b)=>b.rank-a.rank||b.len-a.len);const boxes=[];
    for(const c of cands){
      let ang=c.ang;if(ang>Math.PI/2)ang-=Math.PI;if(ang<-Math.PI/2)ang+=Math.PI;
      const w=c.sym.length*5.9+8,h=13,cs=Math.abs(Math.cos(ang)),sn=Math.abs(Math.sin(ang)),hw=(w*cs+h*sn)/2,hh=(w*sn+h*cs)/2;
      const box=[c.x-hw,c.y-hh,c.x+hw,c.y+hh];
      if(c.rank<2&&boxes.some(o=>o[0]<box[2]&&o[2]>box[0]&&o[1]<box[3]&&o[3]>box[1]))continue;boxes.push(box);
      const deg=ang*180/Math.PI,t=el('text',{x:c.x,y:c.y-4,'text-anchor':'middle',transform:`rotate(${deg.toFixed(1)} ${c.x.toFixed(1)} ${c.y.toFixed(1)})`,class:(c.via?'via':'frt')+(c.rank===2?' sel':''),'data-label':c.sym});
      t.textContent=c.sym;gLabels.append(t);
    }
  }
  function schedule(){if(!raf)raf=requestAnimationFrame(()=>{raf=0;draw()})}
  function paintState(){
    plot.classList.toggle('has-sel',lines.has(selected));
    for(const [sym,line] of lines){line.classList.toggle('sel',sym===selected);line.classList.toggle('hover',sym===hovered)}
    for(const t of gLabels.querySelectorAll('[data-label]')){const s=t.dataset.label;t.classList.toggle('sel',s===selected);t.classList.toggle('hover',s===hovered)}
    for(const sym of [hovered,selected]){const line=lines.get(sym);if(line&&line!==gLines.lastChild)gLines.append(line)}
  }
  /* Replay clock line plus each train's current position in the corridor. */
  function drawNow(time){
    gNow.replaceChildren();if(!G||!segs.length)return;
    if(time>=vw.t0&&time<=vw.t1){const x=X(time);gNow.append(el('line',{x1:x,x2:x,y1:M.t,y2:M.t+G.ph}))}
    for(const s of series){
      if(time<s.t0||time>s.t1)continue;const p=position(s.train,time);if(!p||p.missing)continue;let d=null;
      if(p.next){const a=dOf(p.event.id),b=dOf(p.next.id);if(a!==null&&b!==null)d=a+(b-a)*clamp((time-p.event.departure)/((p.next.arrival-p.event.departure)||1),0,1)}
      else d=dOf(p.event.id);
      if(d===null||d<vw.d0||d>vw.d1)continue;const sym=s.train.symbol,isSel=sym===selected;
      gNow.append(el('circle',{cx:X(time),cy:Y(d),r:isSel?5.5:3.5,class:(s.train.via?'via':'frt')+(isSel?' sel':'')+(sym===hovered?' hover':'')}));
    }
  }

  /* ---------- state ---------- */
  function setEnds(fromId,toId,keepTime){
    $('#slFrom').value=fromId;$('#slTo').value=toId;
    const ok=buildCorridor(fromId,toId);buildSeries();
    if(!ok)setEmpty(fromId===toId?'Choose two different locations':'No track connection between these locations');
    else setEmpty(series.length?'':'No train movements in this corridor');
    if(!keepTime||!vw){const now=currentTime(),span=Math.min(12*3600,tMax-tMin),t0=clamp(now-2*3600,tMin,Math.max(tMin,tMax-span));vw={t0,t1:t0+span,d0:0,d1:1}}
    if(dom){vw.d0=dom.d0;vw.d1=dom.d1}
    frameCorridor();draw();
  }
  function sync(time){
    if(!open||!vw||!G)return;const span=vw.t1-vw.t0;
    if(selected!==lastSel){
      lastSel=selected;const s=series.find(x=>x.train.symbol===selected);
      if(s&&(s.t1<vw.t0||s.t0>vw.t1)){vw.t0=clamp(time,s.t0,s.t1)-span*.3;vw.t1=vw.t0+span}
      draw();return;
    }
    if(playing&&(time>vw.t1||time<vw.t0)){vw.t0=time-span*.1;vw.t1=vw.t0+span;draw();return}
    paintState();drawNow(time);
  }
  function onModel(){
    segs=[];dist=new Map();series=[];vw=null;dom=null;lines=new Map();lastSel=null;corridorLayer.replaceChildren();
    buildGraph();buildStops();const ends=defaultEnds(),b=$('#stringlineBtn');
    b.disabled=!ends;b.title=ends?'Stringline (S)':'No field markers in this model';
    if(!ends){setOpen(false);return}
    pane.dataset.from=ends[0];pane.dataset.to=ends[1];if(open)setEnds(ends[0],ends[1]);
  }
  function setOpen(v){
    open=!!v&&!!model&&!$('#stringlineBtn').disabled;pane.hidden=!open;document.body.classList.toggle('sl-open',open);
    const b=$('#stringlineBtn');b.setAttribute('aria-pressed',String(open));b.setAttribute('aria-label',open?'Hide stringline':'Show stringline');
    if(!open){corridorLayer.replaceChildren();return}
    if(!vw)setEnds(pane.dataset.from,pane.dataset.to);else{frameCorridor();draw()}
  }
  function refresh(){if(segs.length){buildSeries();draw()}}

  /* ---------- interaction ---------- */
  $('#stringlineBtn').addEventListener('click',()=>setOpen(!open));
  $('#slClose').addEventListener('click',()=>setOpen(false));
  for(const id of ['#slFrom','#slTo'])$(id).addEventListener('change',()=>setEnds($('#slFrom').value,$('#slTo').value,true));
  $('#slSwap').addEventListener('click',()=>setEnds($('#slTo').value,$('#slFrom').value,true));
  const fitAll=()=>{if(dom){vw={t0:dom.t0,t1:dom.t1,d0:dom.d0,d1:dom.d1};draw()}};
  $('#slFitAll').addEventListener('click',fitAll);
  plot.addEventListener('dblclick',e=>{e.preventDefault();fitAll()});

  /* The distance axis never scrolls past the corridor's two ends; at full extent, dragging only moves time. */
  function clampDistance(){const span=Math.min(vw.d1-vw.d0,dom.total);vw.d0=clamp(vw.d0,dom.d0,dom.d1-span);vw.d1=vw.d0+span}
  function local(e){const r=plot.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top}}
  function showLineTip(e,symbol){
    const {x,y}=local(e),t=T(x),d=D(y);let near=null;for(const l of locs)if(!near||Math.abs(l.d-d)<Math.abs(near.d-d))near=l;
    tip.innerHTML='<b></b><span></span>';tip.firstChild.textContent=symbol;
    tip.lastChild.textContent=clockParts(t).hms.slice(0,5)+(near?' · near '+near.name+(segs.length>1?' ('+near.sub+')':''):'');
    tip.hidden=false;tip.style.left=Math.min(e.clientX+14,innerWidth-tip.offsetWidth-8)+'px';tip.style.top=(e.clientY+14)+'px';
  }
  plot.addEventListener('pointerdown',e=>{
    if(!vw||!G||e.button!==0)return;drag={...local(e),cx:e.clientX,cy:e.clientY,v:{...vw},moved:false,train:e.target.dataset?.train||null};
    plot.setPointerCapture(e.pointerId);tip.hidden=true;
  });
  plot.addEventListener('pointermove',e=>{
    if(!drag){const sym=e.target.dataset?.train||null;setHover(sym);if(sym)showLineTip(e,sym);else tip.hidden=true;return}
    const dx=e.clientX-drag.cx,dy=e.clientY-drag.cy;if(!drag.moved&&Math.hypot(dx,dy)<4)return;
    if(!drag.moved){drag.moved=true;plot.classList.add('dragging');setHover(null)}
    const v=drag.v,ts=(v.t1-v.t0)/G.pw*dx,ds=(v.d1-v.d0)/G.ph*dy;vw={t0:v.t0-ts,t1:v.t1-ts,d0:v.d0-ds,d1:v.d1-ds};clampDistance();schedule();
  });
  // A click seeks the replay to that time; clicking a line also selects the train and brings it into view on the map.
  plot.addEventListener('pointerup',()=>{
    const d=drag;drag=null;plot.classList.remove('dragging');if(!d||d.moved||!segs.length||d.x<M.l||d.x>M.l+G.pw||d.y>M.t+G.ph)return;
    if(d.train&&selected!==d.train)select(d.train);
    setTime(T(d.x));if(d.train)reveal(d.train);
  });
  plot.addEventListener('pointercancel',()=>{drag=null;plot.classList.remove('dragging')});
  plot.addEventListener('pointerleave',()=>{if(!drag){setHover(null);tip.hidden=true}});
  // Wheel zooms time; over the location axis (or with Shift) it zooms distance.
  plot.addEventListener('wheel',e=>{
    if(!vw||!G||!dom)return;e.preventDefault();const {x,y}=local(e),dy=e.deltaMode===1?e.deltaY*16:e.deltaY,f=Math.exp(clamp(dy,-300,300)*.0025);
    if(x<M.l||e.shiftKey){const fy=clamp((y-M.t)/G.ph,0,1),d=D(M.t+fy*G.ph),span=clamp((vw.d1-vw.d0)*f,.2,dom.total);vw.d0=d-fy*span;vw.d1=vw.d0+span;clampDistance()}
    else{const fx=clamp((x-M.l)/G.pw,0,1),t=T(M.l+fx*G.pw),span=clamp((vw.t1-vw.t0)*f,600,(dom.t1-dom.t0)*1.5);vw.t0=t-fx*span;vw.t1=vw.t0+span}
    schedule();
  },{passive:false});

  // Resizable width (remembered per browser), and room for the replay dock below the pane.
  const root=document.documentElement;
  try{const w=Number(localStorage.getItem('slWidth'));if(w>0)root.style.setProperty('--sl-w',w+'px')}catch{}
  $('#slResize').addEventListener('pointerdown',e=>{
    e.preventDefault();const h=e.currentTarget;h.setPointerCapture(e.pointerId);h.classList.add('active');
    const move=ev=>root.style.setProperty('--sl-w',clamp(innerWidth-ev.clientX-16,360,Math.max(360,innerWidth-420))+'px');
    const up=()=>{h.classList.remove('active');h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',up);try{localStorage.setItem('slWidth',parseFloat(root.style.getPropertyValue('--sl-w')))}catch{}};
    h.addEventListener('pointermove',move);h.addEventListener('pointerup',up);
  });
  new ResizeObserver(()=>schedule()).observe(plot);
  new ResizeObserver(()=>root.style.setProperty('--dock-h',$('#dock').offsetHeight+'px')).observe($('#dock'));

  return {sync,onModel,refresh,toggle:()=>setOpen(!open),get open(){return open}};
})();
