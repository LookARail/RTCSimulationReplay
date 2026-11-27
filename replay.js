"use strict";
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],NS='http://www.w3.org/2000/svg',map=$('#map'),stage=$('#stage');
const GRID=28,MIN_ZOOM=1/400,MAX_ZOOM=6;
const TZ_OFFSET=-5*3600; // RTC times are UTC; display as Eastern (fixed UTC−5, no daylight saving)
let model=null,view=null,fitUpp=1,lastW=0,zs=0,selected=null,follow=false,playing=false,lastFrame=0,playbackTime=0,drag=null,loading=false;
let hovered=null,scope='all',speed=300,tMin=0,tMax=1,density=null,labels=[],routePath='',colors={},panelOpen=true,listKey='',rows=new Map();
const corridorLayer=svg('g',{class:'corridor'}),trackLayer=svg('g',{class:'tracks'}),labelLayer=svg('g',{class:'labels'}),highlightLayer=svg('g'),trainLayer=svg('g');
map.append(corridorLayer,trackLayer,labelLayer,highlightLayer,trainLayer);
const STATION_RE=/\bvia\b|\bstation\b|\bgare\b/i; // node names treated as stations (bolder labels)

/* ---------- helpers ---------- */
function svg(tag,attrs={}){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e}
function tooltip(e,value){const t=svg('title');t.textContent=value;e.append(t)}
const pad2=x=>String(x).padStart(2,'0'),mod=(a,b)=>((a%b)+b)%b,fmtN=n=>n.toLocaleString(),clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
function clockParts(s){s=Math.floor(s+TZ_OFFSET);const d=Math.floor(s/86400),n=mod(s,86400);return {day:d,hms:pad2(Math.floor(n/3600))+':'+pad2(Math.floor(n%3600/60))+':'+pad2(n%60)}}
function formatTime(s){const c=clockParts(s);return 'D'+c.day+' '+c.hms}
const upp=()=>view?view.w/Math.max(1,map.clientWidth):1;
const nodeOf=id=>model.nodes.byId.get(id);
const nodeName=id=>{const n=nodeOf(id);return n&&n.name?n.name:id};
const inScope=t=>scope==='all'||(scope==='via')===t.via;
const currentTime=()=>Number($('#time').value);
const isNarrow=()=>innerWidth<=860;
function readColors(){const cs=getComputedStyle(document.documentElement);for(const k of ['accent','density'])colors[k]=cs.getPropertyValue('--'+k).trim()}
function setPressed(group,value){for(const b of group.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.v===String(value)))}
function statusText(p){return !p?'':p.missing?nodeName(p.from)+' → '+nodeName(p.to):p.next?nodeName(p.event.id)+' → '+nodeName(p.next.id):'At '+nodeName(p.event.id)}

/* ---------- view ---------- */
/* Lines, markers and text grow with zoom: zs is log2 of the zoom relative to "fit whole network". */
function updateView(){
  if(!view)return;map.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);
  const u=upp();zs=Math.log2(fitUpp/u);
  stage.style.backgroundPosition=`${mod(-view.x/u,GRID)}px ${mod(-view.y/u,GRID)}px`;
  const tw=clamp(2+.8*zs,1.5,9),st=map.style;
  st.setProperty('--tw',tw+'px');st.setProperty('--tw-xo',tw*1.2+'px');st.setProperty('--tw-route',tw*2.6+3+'px');st.setProperty('--tw-seg',tw*1.6+1.5+'px');
  labelLayer.setAttribute('font-size',11.5*textScale()*u);labelLayer.setAttribute('stroke-width',3.5*u);cullLabels();
}
const textScale=()=>clamp(1+.08*zs,1,1.5);
const markerScale=()=>clamp(1+.14*zs,.9,1.9);
/* Map area not covered by floating UI, in screen px. */
function insets(){
  const W=map.clientWidth,H=map.clientHeight,ins={left:32,top:32,right:W-$('.controls').getBoundingClientRect().left+16,bottom:32},p=$('#panel').getBoundingClientRect(),d=$('#dock'),sl=$('#stringline');
  if(isNarrow())ins.top=p.bottom+16;else if(panelOpen&&model)ins.left=p.right+24;else ins.top=Math.max(ins.top,p.bottom+16);
  if(!d.hidden)ins.bottom=H-d.getBoundingClientRect().top+16;
  if(!$('#trainCard').hidden&&isNarrow())ins.bottom=H-$('#trainCard').getBoundingClientRect().top+16;
  if(!sl.hidden&&isNarrow())ins.bottom=H-sl.getBoundingClientRect().top+16;
  ins.left=Math.min(ins.left,W-120);ins.top=Math.min(ins.top,H-120);return ins;
}
function fitBounds(a,b,c,d,minSpan=0){
  const W=map.clientWidth||1,H=map.clientHeight||1,ins=insets(),avW=Math.max(60,W-ins.left-ins.right),avH=Math.max(60,H-ins.top-ins.bottom);
  const u=Math.max(Math.max(b-a,minSpan)/avW,Math.max(d-c,minSpan)/avH,fitUpp*MIN_ZOOM);lastW=W;
  view={w:W*u,h:H*u};view.x=(a+b)/2-(ins.left+avW/2)*u;view.y=(c+d)/2-(ins.top+avH/2)*u;
  return u;
}
function fit(){
  if(!model)return;let a=Infinity,b=-Infinity,c=Infinity,d=-Infinity;
  for(const n of model.nodes.list){a=Math.min(a,n.x);b=Math.max(b,n.x);c=Math.min(c,n.y);d=Math.max(d,n.y)}
  fitUpp=0;fitUpp=fitBounds(a,b,c,d);follow=false;syncFollow();updateView();render();
}
function zoomAt(px,py,f){
  if(!view)return;const u=upp(),nu=clamp(u*f,fitUpp*MIN_ZOOM,fitUpp*MAX_ZOOM);
  const wx=view.x+px*u,wy=view.y+py*u;view.w*=nu/u;view.h*=nu/u;view.x=wx-px*nu;view.y=wy-py*nu;updateView();render();
}
function centerOn(x,y){view.x=x-view.w/2;view.y=y-view.h/2;updateView()}

/* ---------- network ---------- */
function drawNetwork(){
  if(!model)return;trackLayer.replaceChildren();labelLayer.replaceChildren();labels=[];
  const seen=new Set(),frag=document.createDocumentFragment();
  for(const link of model.links.links){
    const a=nodeOf(link.a),b=nodeOf(link.b),key=link.a<link.b?link.a+'|'+link.b:link.b+'|'+link.a;if(seen.has(key))continue;seen.add(key);
    const line=svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:/crossover|turnout/i.test(link.type)?'xo':'trk'});tooltip(line,a.id+' ↔ '+b.id+' · '+link.type);frag.append(line);
  }
  trackLayer.append(frag);
  const named=new Set(),major=[],minor=[];
  for(const n of model.nodes.list){if(!n.name)continue;const k=n.name.toUpperCase();if(named.has(k))continue;named.add(k);(STATION_RE.test(n.name)?major:minor).push(n)}
  const lf=document.createDocumentFragment();
  for(const [list,isMajor] of [[major,true],[minor,false]])for(const n of list){
    const t=svg('text',{x:n.x,y:n.y,dy:'-0.9em','text-anchor':'middle',class:isMajor?'stn':'loc'});t.textContent=n.name;tooltip(t,n.id+(n.subdivision?' · '+n.subdivision:''));lf.append(t);
    labels.push({el:t,n,major:isMajor,chars:n.name.length,shown:true});
  }
  labelLayer.append(lf);fit();
}
/* Hide labels that are off-screen or collide; minor location names appear only when zoomed in. */
function cullLabels(){
  if(!view||!labels.length)return;const u=upp(),W=map.clientWidth,H=map.clientHeight,showMinor=zs>2,C=90,grid=new Map(),ts=textScale(),lh=9*ts;
  for(const L of labels){
    let show=L.major||showMinor;
    if(show){
      const hw=(L.chars*(L.major?6.8:5.8)*ts+8)/2,sx=(L.n.x-view.x)/u,sy=(L.n.y-view.y)/u-12*ts,x0=sx-hw,x1=sx+hw,y0=sy-lh,y1=sy+lh;
      if(x1<0||x0>W||y1<0||y0>H)show=false;
      else{
        const gx0=Math.floor(x0/C),gx1=Math.floor(x1/C),gy0=Math.floor(y0/C),gy1=Math.floor(y1/C);
        check:for(let gx=gx0;gx<=gx1;gx++)for(let gy=gy0;gy<=gy1;gy++)for(const o of grid.get(gx*7919+gy)||[])if(o[0]<x1&&o[2]>x0&&o[1]<y1&&o[3]>y0){show=false;break check}
        if(show){const box=[x0,y0,x1,y1];for(let gx=gx0;gx<=gx1;gx++)for(let gy=gy0;gy<=gy1;gy++){const k=gx*7919+gy;if(!grid.has(k))grid.set(k,[]);grid.get(k).push(box)}}
      }
    }
    if(show!==L.shown){L.el.style.display=show?'':'none';L.shown=show}
  }
}

/* ---------- trains ---------- */
function position(train,time){
  const es=train.events;if(time<es[0].arrival||time>es[es.length-1].departure)return null;
  let low=0,high=es.length;while(low<high){const middle=(low+high)>>1;if(es[middle].arrival<=time)low=middle+1;else high=middle}
  const i=low-1,e=es[i];if(!e)return null;const n=nodeOf(e.id);
  if(time<=e.departure||i===es.length-1)return {x:n.x,y:n.y,event:e,index:i};
  const next=es[i+1],link=model.links.graph.get(e.id)?.get(next.id);if(!link)return {missing:true,from:e.id,to:next.id,event:e,next,index:i};
  const b=nodeOf(next.id),f=(time-e.departure)/(next.arrival-e.departure);return {x:n.x+(b.x-n.x)*f,y:n.y+(b.y-n.y)*f,event:e,next,index:i};
}
function buildRoute(train){
  let d='',prev=null;
  for(const e of train.events){const n=nodeOf(e.id);d+=(prev&&model.links.graph.get(prev)?.has(e.id)?'L':'M')+n.x+' '+n.y;prev=e.id}
  return d;
}
function select(symbol){
  selected=symbol&&symbol!==selected?symbol:null;follow=false;syncFollow();
  routePath=selected?buildRoute(model.trainBySymbol.get(selected)):'';render();
  if(selected)rows.get(selected)?.scrollIntoView({block:'nearest'});
}
/* Select a train and frame its whole trip. */
function focusTrip(symbol){
  const train=model.trainBySymbol.get(symbol);if(!train)return;
  if(selected!==symbol){selected=symbol;routePath=buildRoute(train)}
  follow=false;syncFollow();render();
  let a=Infinity,b=-Infinity,c=Infinity,d=-Infinity;for(const e of train.events){const n=nodeOf(e.id);a=Math.min(a,n.x);b=Math.max(b,n.x);c=Math.min(c,n.y);d=Math.max(d,n.y)}
  const span=Math.max(b-a,d-c);fitBounds(a-span*.04,b+span*.04,c-span*.04,d+span*.04,fitUpp*240);updateView();render();
}
function syncFollow(){$('#tcFollow').setAttribute('aria-pressed',String(follow))}

function render(){
  if(!model||!view)return;
  const time=currentTime(),u=upp(),c=clockParts(time),ms=markerScale(),ts=textScale();
  $('#clockDay').textContent='Day '+c.day+' · ET';$('#clockTime').textContent=c.hms;
  let missing=0,via=0,frt=0,sel=null;const drawn=[],active=[];
  for(const train of model.history.trains){
    const isSel=train.symbol===selected;if(!isSel&&!inScope(train))continue;
    const p=position(train,time);if(isSel)sel={train,p};if(!p||!inScope(train))continue;
    active.push({train,p});
    if(p.missing){missing++;continue}
    train.via?via++:frt++;drawn.push({train,p,isSel});
  }
  if(sel&&sel.p&&!sel.p.missing&&follow)centerOn(sel.p.x,sel.p.y);

  highlightLayer.replaceChildren();
  if(sel){
    highlightLayer.append(svg('path',{d:routePath,class:'route'}));
    if(sel.p&&sel.p.next){const a=nodeOf(sel.p.event.id),b=nodeOf(sel.p.next.id);highlightLayer.append(svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:'seg-now'}))}
  }

  // Greedy screen-space placement: the selected train is labelled first, then any label that doesn't collide.
  drawn.sort((a,b)=>b.isSel-a.isSel);const boxes=[],W=map.clientWidth,H=map.clientHeight;
  for(const d of drawn){
    const sx=(d.p.x-view.x)/u,sy=(d.p.y-view.y)/u,box=[sx-7*ms,sy-8*ts,sx+(12*ms)+d.train.symbol.length*6.4*ts,sy+8*ts];
    d.label=d.isSel||(box[2]>0&&box[0]<W&&box[3]>0&&box[1]<H&&!boxes.some(o=>o[0]<box[2]&&o[2]>box[0]&&o[1]<box[3]&&o[3]>box[1]));
    if(d.label)boxes.push(box);
  }
  drawn.reverse();
  const frag=document.createDocumentFragment();
  for(const {train,p,isSel,label} of drawn){
    const g=svg('g',{transform:`translate(${p.x} ${p.y})`,class:'train '+(train.via?'via':'frt')+(isSel?' sel':'')+(train.symbol===hovered?' hover':''),'data-train':train.symbol});
    if(isSel)g.append(svg('circle',{r:13*ms*u,class:'halo'}));
    g.append(svg('circle',{r:(isSel?7:5.5)*ms*u,class:'dot'}));
    if(label){const t=svg('text',{x:(isSel?11:9)*ms*u,y:3.8*ts*u,'font-size':(isSel?12:10.5)*ts*u,'stroke-width':3*u});t.textContent=train.symbol;g.append(t)}
    frag.append(g);
  }
  trainLayer.replaceChildren(frag);

  $('#countVia b').textContent=via;$('#countFrt b').textContent=frt;
  const m=$('#countMissing');m.hidden=!missing;m.querySelector('b').textContent=missing;m.title=missing+' active train'+(missing===1?'':'s')+' between nodes with no direct link (not drawn)';
  $('#countVia').hidden=scope==='freight';$('#countFrt').hidden=scope==='via';
  updateList(active);updateCard(sel,time);drawDensity(time);
  Stringline.sync(time);
}

/* ---------- active train list (rows are reused so clicks and hover survive playback) ---------- */
function updateList(active){
  if(!panelOpen)return;
  const q=$('#search').value.trim().toUpperCase(),shown=(q?active.filter(a=>a.train.symbol.includes(q)):active).sort((a,b)=>a.train.symbol.localeCompare(b.train.symbol));
  $('#activeCount').textContent=q?shown.length+' / '+active.length:active.length;
  $('#listEmpty').hidden=shown.length>0;$('#listEmpty').textContent=q?'No running trains match':'No trains running at this time';
  const key=shown.map(a=>a.train.symbol).join('|'),list=$('#trainList');
  if(key!==listKey){
    listKey=key;const keep=new Set();
    const els=shown.map(({train})=>{keep.add(train.symbol);let li=rows.get(train.symbol);if(!li){li=document.createElement('li');li.dataset.train=train.symbol;li.innerHTML='<i class="dot"></i><div class="t-text"><b></b><span></span></div>';li.firstChild.className='dot '+(train.via?'via':'frt');li.querySelector('b').textContent=train.symbol;rows.set(train.symbol,li)}return li});
    for(const k of rows.keys())if(!keep.has(k))rows.delete(k);
    list.replaceChildren(...els);
  }
  for(const {train,p} of shown){const li=rows.get(train.symbol),s=statusText(p),span=li.lastChild.lastChild;if(span.textContent!==s)span.textContent=s;li.classList.toggle('gap',!!p.missing);li.classList.toggle('sel',train.symbol===selected)}
}
function setPanel(open){
  panelOpen=open;document.body.classList.toggle('panel-open',open&&!!model);$('#panelBody').hidden=!open||!model;
  const b=$('#collapseBtn');b.setAttribute('aria-expanded',String(open));b.title=b.ariaLabel=open?'Hide train list':'Show train list';
  listKey='';if(model){render();resizeDensity()}
}

function updateCard(sel,time){
  const card=$('#trainCard');if(!selected||!sel){card.hidden=true;return}card.hidden=false;
  const {train,p}=sel,es=train.events,first=es[0].arrival,last=es[es.length-1].departure;
  $('#tcSymbol').textContent=train.symbol;const kind=$('#tcKind');kind.textContent=train.via?'VIA':'Freight';kind.className='pill '+(train.via?'via':'frt');
  let status,sub;
  if(!p){status=time<first?'Not yet running':'Run complete';sub=time<first?'Starts '+formatTime(first):'Ended '+formatTime(last)}
  else if(p.missing){status=statusText(p);sub='No direct link — not drawn'}
  else if(p.next){status=statusText(p);sub='Arrives '+clockParts(p.next.arrival).hms}
  else{status=statusText(p);sub='Departs '+clockParts(p.event.departure).hms}
  $('#tcStatus').textContent=status;$('#tcSub').textContent=sub;
  $('#tcProgress').style.width=clamp((time-first)/((last-first)||1),0,1)*100+'%';
  $('#tcStart').textContent=formatTime(first);$('#tcEnd').textContent=formatTime(last);
}

/* ---------- timeline density ---------- */
function computeDensity(){
  const B=400,diff=new Float64Array(B+1),span=(tMax-tMin)||1;
  for(const t of model.history.trains){if(!inScope(t))continue;const a=Math.floor((t.events[0].arrival-tMin)/span*(B-1)),b=Math.floor((t.events[t.events.length-1].departure-tMin)/span*(B-1));diff[Math.max(0,a)]++;diff[Math.min(B,b+1)]--}
  const bins=new Float64Array(B);let s=0,max=1;for(let i=0;i<B;i++){s+=diff[i];bins[i]=s;max=Math.max(max,s)}density={bins,max};
}
function resizeDensity(){const cv=$('#density');cv.width=0;drawDensity(currentTime())}
function drawDensity(time){
  const cv=$('#density'),dpr=devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;if(!w||!density)return;
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr)}
  const ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const B=density.bins.length,bw=w/B,cut=(time-tMin)/((tMax-tMin)||1)*w;
  for(let i=0;i<B;i++){const v=density.bins[i];if(!v)continue;const bh=Math.max(1.5,v/density.max*h),x=i*bw;ctx.fillStyle=x<cut?colors.accent:colors.density;ctx.fillRect(x,h-bh,bw+.3,bh)}
}

/* ---------- loading ---------- */
async function filesFromDrop(dt){
  const entries=[...dt.items].map(i=>i.webkitGetAsEntry&&i.webkitGetAsEntry()).filter(Boolean);
  if(!entries.length)return [...dt.files];const out=[];
  async function walk(entry){
    if(entry.isFile)out.push(await new Promise((res,rej)=>entry.file(res,rej)));
    else if(entry.isDirectory){const reader=entry.createReader();for(;;){const batch=await new Promise((res,rej)=>reader.readEntries(res,rej));if(!batch.length)break;for(const e of batch)await walk(e)}}
  }
  for(const e of entries)await walk(e);return out;
}
/* File slots: files can arrive in one go (drop folder / select all) or a few at a time. */
const EXTS=['NODE','LINK','HISTORY','ROUTE'];let pending=new Map(),pendingBase=null;
function showOpen(open){
  $('#empty').hidden=!open;$('#emptyClose').hidden=!model;
  if(open){pending=new Map();pendingBase=null;updateSlots();setLoadStatus('',false)}
}
function updateSlots(missing=false){
  for(const li of $$('#slots li')){const ok=pending.has(li.dataset.ext);li.classList.toggle('ok',ok);li.classList.toggle('miss',missing&&!ok);li.title=ok?pending.get(li.dataset.ext).name:''}
}
function addFiles(files){
  if(loading)return;
  const parsed=files.map(f=>{const m=f.name.match(/^(.*)\.(NODE|LINK|HISTORY|ROUTE)$/i);return m&&{file:f,base:m[1].toUpperCase(),ext:m[2].toUpperCase()}}).filter(Boolean);
  if(!parsed.length){setLoadStatus('No .NODE, .LINK, .HISTORY or .ROUTE files found',false,true);updateSlots(true);return}
  const bases=new Set(parsed.map(p=>p.base));
  // A full set arrived at once (e.g. a dropped folder): let the loader pick and validate it.
  if([...bases].some(b=>EXTS.every(x=>parsed.some(p=>p.base===b&&p.ext===x)))){
    pending=new Map(parsed.filter(p=>p.base===parsed[0].base).map(p=>[p.ext,p.file]));updateSlots();void loadFiles(files);return;
  }
  if(bases.size>1){setLoadStatus('These files come from different models',false,true);return}
  const base=parsed[0].base;if(base!==pendingBase){pending=new Map();pendingBase=base}
  for(const p of parsed)pending.set(p.ext,p.file);updateSlots();
  const missing=EXTS.filter(x=>!pending.has(x));
  if(!missing.length){void loadFiles([...pending.values()]);return}
  setLoadStatus('Still need '+missing.map(x=>'.'+x).join(', '),false);updateSlots(true);
}
function setLoadStatus(msg,busy,err){
  const s=$('#loadStatus');s.textContent=msg;s.classList.toggle('busy',!!busy);s.classList.toggle('err',!!err);
  if(msg&&!busy&&$('#empty').hidden){$('#empty').hidden=false;$('#emptyClose').hidden=!model}
  if(model)$('#modelName').textContent=busy?msg:model.name;
}
async function loadFiles(files){
  if(!files.length||loading)return;loading=true;setLoadStatus('Reading model…',true);
  try{
    await new Promise(r=>setTimeout(r,20));
    const loaded=await window.RTCModelLoader.load(files,msg=>setLoadStatus(msg.replace(/…$/,'')+'…',true));
    if(playing)togglePlay();model=loaded;selected=null;hovered=null;follow=false;routePath='';listKey='';rows=new Map();
    model.trainBySymbol=new Map(model.history.trains.map(t=>[t.symbol,t]));
    tMin=Infinity;tMax=-Infinity;for(const t of model.history.trains)for(const e of t.events){tMin=Math.min(tMin,e.arrival);tMax=Math.max(tMax,e.departure)}
    tMin=Math.floor(tMin);tMax=Math.ceil(tMax);
    const slider=$('#time');slider.min=tMin;slider.max=tMax;slider.value=tMin;playbackTime=tMin;
    $('#start').textContent=formatTime(tMin);$('#end').textContent=formatTime(tMax);
    $('#empty').hidden=true;$('#dock').hidden=false;$('#modelInfo').hidden=false;$('#collapseBtn').hidden=false;
    $('#modelName').textContent=model.name;$('#modelName').title=model.name;
    setPanel(!isNarrow());fillInfo();setLoadStatus('',false);computeDensity();drawNetwork();Stringline.onModel();
  }catch(error){
    setLoadStatus(error.message,false,true);
  }finally{loading=false}
}
function fillInfo(){
  const h=model.history,stats=[['Nodes',model.nodes.list.length],['Links',model.links.links.length],['Trains',h.trains.length],['Events',h.rows]];
  $('#stats').replaceChildren(...stats.map(([k,v])=>{const d=document.createElement('div');d.innerHTML='<dt></dt><dd></dd>';d.firstChild.textContent=k;d.lastChild.textContent=fmtN(v);return d}));
  const checks=[[fmtN(h.checked)+' events match ROUTE',false],[h.missingLinks?fmtN(h.missingLinks)+' node pairs lack a direct link':'All consecutive nodes linked',!!h.missingLinks]];
  $('#checks').replaceChildren(...checks.map(([t,w])=>{const li=document.createElement('li');li.textContent=t;if(w)li.className='warn';return li}));
}

/* ---------- playback ---------- */
function setTime(t){const s=$('#time');s.value=clamp(t,tMin,tMax);playbackTime=Number(s.value);render()}
function togglePlay(){
  if(!model)return;playing=!playing;const b=$('#play');b.classList.toggle('on',playing);b.title=playing?'Pause (Space)':'Play (Space)';b.setAttribute('aria-label',playing?'Pause':'Play');
  lastFrame=0;playbackTime=currentTime();if(playing&&playbackTime>=tMax)setTime(tMin);if(playing)requestAnimationFrame(tick);
}
function tick(now){
  if(!playing)return;
  if(lastFrame){playbackTime+=(now-lastFrame)/1000*speed;$('#time').value=Math.min(tMax,playbackTime);render();if(playbackTime>=tMax){togglePlay();return}}
  lastFrame=now;requestAnimationFrame(tick);
}

/* ---------- events ---------- */
$('#openBtn').addEventListener('click',()=>showOpen(true));
$('#pickFiles').addEventListener('click',()=>$('#files').click());
$('#emptyClose').addEventListener('click',()=>showOpen(false));
$('#files').addEventListener('change',e=>{const files=[...e.target.files];e.target.value='';addFiles(files)});
$('#collapseBtn').addEventListener('click',()=>setPanel(!panelOpen));

$('#scope').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;scope=b.dataset.v;setPressed($('#scope'),scope);if(model){computeDensity();Stringline.refresh();render()}});
$('#speed').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;speed=Number(b.dataset.v);setPressed($('#speed'),speed)});
$('#search').addEventListener('input',()=>render());
$('#trainList').addEventListener('click',e=>{const li=e.target.closest('li[data-train]');if(!li)return;if(isNarrow())setPanel(false);focusTrip(li.dataset.train)});
$('#fit').addEventListener('click',fit);
$('#zoomIn').addEventListener('click',()=>zoomAt(map.clientWidth/2,map.clientHeight/2,1/1.6));
$('#zoomOut').addEventListener('click',()=>zoomAt(map.clientWidth/2,map.clientHeight/2,1.6));
$('#time').addEventListener('input',()=>{playbackTime=currentTime();render()});
$('#play').addEventListener('click',togglePlay);
$('#tcClose').addEventListener('click',()=>select(null));
$('#tcFollow').addEventListener('click',()=>{follow=!follow;syncFollow();render()});

const info=$('#info'),infoBtn=$('#infoBtn');
function setInfo(open){info.hidden=!open;infoBtn.setAttribute('aria-expanded',String(open))}
infoBtn.addEventListener('click',e=>{e.stopPropagation();setInfo(info.hidden)});
document.addEventListener('pointerdown',e=>{if(!info.hidden&&!info.contains(e.target)&&!infoBtn.contains(e.target))setInfo(false)});

/* map interaction */
const tip=$('#tip');
/* One hovered train is shared by the map and the stringline. */
function setHover(symbol){if(hovered===symbol)return;hovered=symbol;if(model&&view)render()}
function showTip(e){
  const g=e.target.closest&&e.target.closest('[data-train]');if(!g||!model){tip.hidden=true;setHover(null);return}
  const train=model.trainBySymbol.get(g.dataset.train);setHover(train.symbol);
  tip.innerHTML='<b></b><span></span>';tip.firstChild.textContent=train.symbol;tip.lastChild.textContent=statusText(position(train,currentTime()));
  tip.hidden=false;tip.style.left=Math.min(e.clientX+14,innerWidth-tip.offsetWidth-8)+'px';tip.style.top=(e.clientY+14)+'px';
}
map.addEventListener('wheel',e=>{if(!view)return;e.preventDefault();const r=map.getBoundingClientRect(),dy=e.deltaMode===1?e.deltaY*16:e.deltaY;zoomAt(e.clientX-r.left,e.clientY-r.top,Math.exp(clamp(dy,-300,300)*.0025))},{passive:false});
map.addEventListener('dblclick',e=>{if(!view)return;const r=map.getBoundingClientRect();zoomAt(e.clientX-r.left,e.clientY-r.top,e.shiftKey?2:.5)});
map.addEventListener('pointerdown',e=>{
  if(!view||e.button!==0)return;const g=e.target.closest&&e.target.closest('[data-train]');
  drag={x:e.clientX,y:e.clientY,view:{...view},moved:false,train:g?g.dataset.train:null};map.setPointerCapture(e.pointerId);tip.hidden=true;
});
map.addEventListener('pointermove',e=>{
  if(!drag){showTip(e);return}
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<4)return;
  if(!drag.moved){drag.moved=true;map.classList.add('dragging');if(follow){follow=false;syncFollow()}}
  const u=upp();view.x=drag.view.x-dx*u;view.y=drag.view.y-dy*u;updateView();
});
map.addEventListener('pointerup',()=>{if(drag&&!drag.moved&&(drag.train||selected))select(drag.train);drag=null;map.classList.remove('dragging')});
map.addEventListener('pointercancel',()=>{drag=null;map.classList.remove('dragging')});
map.addEventListener('pointerleave',()=>{tip.hidden=true;setHover(null)});

new ResizeObserver(()=>{
  if(!view)return;const W=map.clientWidth,H=map.clientHeight;if(!W||!H)return;
  const u=view.w/(lastW||W),cx=view.x+view.w/2,cy=view.y+view.h/2;lastW=W;view.w=W*u;view.h=H*u;view.x=cx-view.w/2;view.y=cy-view.h/2;updateView();render();
}).observe(map);

/* drag & drop a model folder anywhere */
let dragDepth=0;
addEventListener('dragenter',e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('Files')){dragDepth++;document.body.classList.add('dropping')}});
addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;document.body.classList.remove('dropping')}});
addEventListener('dragover',e=>e.preventDefault());
addEventListener('drop',async e=>{e.preventDefault();dragDepth=0;document.body.classList.remove('dropping');if(e.dataTransfer)addFiles(await filesFromDrop(e.dataTransfer))});

/* keyboard */
addEventListener('keydown',e=>{
  if(e.target.closest&&e.target.closest('select,input:not([type=range])')){if(e.key==='Escape')e.target.blur();return}
  if(e.key==='Escape'){if(!info.hidden)setInfo(false);else if(selected)select(null);return}
  if(!model||e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key===' '){e.preventDefault();togglePlay()}
  else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();setTime(currentTime()+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?600:60))}
  else if(e.key==='f'||e.key==='F')fit();
  else if(e.key==='s'||e.key==='S')Stringline.toggle();
  else if(e.key==='+'||e.key==='=')$('#zoomIn').click();
  else if(e.key==='-'||e.key==='_')$('#zoomOut').click();
});

readColors();matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{readColors();render()});
