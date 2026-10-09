const NS = "http://www.w3.org/2000/svg";
const $ = id => document.getElementById(id);
const el = (tag, attrs={}, parent) => { const e=document.createElementNS(NS,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); parent&&parent.appendChild(e); return e; };
let CUR="$";
const OUTCOME_LABEL={won:"Closed won",techwin:"Tech win",lost:"Loss",deferred:"Deferred"};
const money = n => n>=1e6 ? `${CUR}${(n/1e6).toFixed(1)}M` : `${CUR}${Math.round(n/1e3)}k`;
const ENT_COLOR = {person:"#64748b",ae:"#475569",competitor:"#ef4444",partner:"#a78bfa",industry:"#14b8a6"};

// SIP board columns (SE stages). Technical Close is where decided deals live, so it is off by default = "active deals".
const SE_STAGES=["Requested","Value Discovery","Value Demonstration","Value Proof","Awaiting Decision","Technical Close"];
const STAGE_SHORT={"Value Demonstration":"Value Demo","Awaiting Decision":"Awaiting Dec."};
let onStages=new Set(SE_STAGES.filter(s=>s!=="Technical Close")), hasStages=false;
let UID="", NOW=new Date(), MAXAMT=1, tiers={}, statuses={};
let shakes=0, frame=0;
let changelog=[], sumTab=null;
let viewMode=(new URLSearchParams(location.search).get("view")==="closed")?"closed":"pipeline";
let orbit=false, builtFor=[0,0], sizeChangedAt=0;
let LS=1;  // layout scale: more room per node when fewer nodes are shown
let nodes=[], links=[], selected=null, scored=[], allScored=[], meta={};

// Every data request goes to the authenticated API and returns ONLY the signed-in person's own data (the server decides who that is).
// ?demo=1 shows the fictional sample data without signing in.
const params = new URLSearchParams(location.search), DEMO = params.get("demo")==="1";
const api = f => DEMO ? `/api/demo/${f}` : `/api/data/${f}`;
const apiJ = (f, dflt) => fetch(api(f)).then(r=>r.ok?r.json():dflt).catch(()=>dflt);
fetch("/api/me").then(r=>{ if(r.status===401&&!DEMO){ location.href="/login.html"; throw new Error("signed out"); }
  if(r.status===403) throw new Error("no data space for this account yet"); return DEMO?{id:"sample",name:"Demo (fictional data)",mode:"demo"}:r.json(); }).then(me=>{
  UID=me.id; $("whoName").textContent=DEMO?"Demo · fictional data":me.name; $("whoami").classList.toggle("demo",DEMO);
  $("signOut").textContent=DEMO?"Sign in":"Sign out";
  $("signOut").onclick=async e=>{ e.preventDefault(); if(!DEMO) await fetch("/api/logout",{method:"POST"}).catch(()=>{}); location.href="/login.html"; };
  // last-known data: if a live file is missing/empty/corrupt, fall back to the newest snapshot
  const loadJ=(f,snap)=>fetch(api(`${snap?"snapshots/latest/":""}${f}`)).then(r=>{if(!r.ok)throw new Error(f);return r.json();});
  const withFallback=(f,ok=()=>true)=>loadJ(f).then(j=>{if(!ok(j))throw 0;return j;}).catch(()=>loadJ(f,true).then(j=>{window.__fromSnapshot=true;return j;}));
  return Promise.all([withFallback("prospects.json",j=>j.prospects&&j.prospects.length),
    apiJ("overrides.json",{}),      // optional per-user manual facts SIP lacks, e.g. {"<oppId>": {"signed": true}}
    apiJ("summaries.json",{}),      // optional AI-written deal summaries; their signals refresh the activity color
    apiJ("changelog.json",[]),      // dated headline changes written by refresh.py; feeds the "What moved" digest
    apiJ("closed_history.json",[])  // closed-won ARR history (from #winwire); feeds the Closed deals view
  ]);
}).then(([data,ov,sums,cl,ch])=>{ changelog=cl; closedHistory=ch; data.prospects.forEach(p=>{ Object.assign(p,ov[p.id]||{}); p.baseSignals=p.signals; });
  applySummaries(data.prospects,sums);
  // refresh tiers + status are optional (need scripts/server.py); the UI degrades gracefully without them
  return Promise.all([DEMO?{}:fetch("/api/tiers").then(r=>r.ok?r.json():{}).catch(()=>({})), loadStatus()]).then(([t])=>{ tiers=t; init(data); });
});

function applySummaries(prospects,sums){ prospects.forEach(p=>{ p.summary=sums[p.id]||null; p.signals=[...p.baseSignals,...(sums[p.id]?.signals||[])]; }); }
const loadStatus=()=>(DEMO?Promise.resolve({}):fetch(`${api("refresh_status.json")}?t=${Date.now()}`).then(r=>r.ok?r.json():{}).catch(()=>({}))).then(s=>statuses=s);

function init(data){
  CUR=data.currency||"$";
  const now = NOW = new Date(data.generated);
  const maxAmt = MAXAMT = Math.max(...data.prospects.map(p=>p.amount));
  scored = data.prospects.map(p=>({p, s:scoreProspect(p, now, maxAmt)})).sort((a,b)=>b.s.importance-a.s.importance);
  if(!scored.length){$("meta").textContent=data.note||"No opportunities for this user yet.";return;}
  allScored=scored; meta=data;
  { const l=$("sipLink"), h=safeHref(data.sip_url,[".phrase-internal.com"]); if(l&&h){ l.href=h; l.hidden=false; } }
  allScored.forEach(({p})=>{ p.se_stage=p.se_stage||((p.stage_label||"").split("SE: ")[1]||null); });
  hasStages=allScored.some(x=>x.p.se_stage);
  if(params.get("stages")) onStages=new Set(params.get("stages").split("~"));
  // AE filter: dropdown + ?ae= param
  const aes=[...new Set(allScored.map(x=>x.p.owner).filter(Boolean))].sort();
  const aeSel=$("aeSel"); aeSel.add(new Option("All AEs ("+aes.length+")",""));
  aes.forEach(n=>aeSel.add(new Option(`${n} (${allScored.filter(x=>x.p.owner===n).length})`,n)));
  aeSel.value=aes.includes(params.get("ae"))?params.get("ae"):"";
  aeSel.onchange=()=>{ const u=new URL(location); aeSel.value?u.searchParams.set("ae",aeSel.value):u.searchParams.delete("ae"); history.replaceState(null,"",u); build(true); };
  document.querySelectorAll("#viewSwitch .vs").forEach(b=>{
    b.classList.toggle("on",b.dataset.view===viewMode);
    b.onclick=()=>{ viewMode=b.dataset.view; document.querySelectorAll("#viewSwitch .vs").forEach(x=>x.classList.toggle("on",x===b));
      const u=new URL(location); viewMode==="closed"?u.searchParams.set("view","closed"):u.searchParams.delete("view"); history.replaceState(null,"",u); build(true); };
  });
  build(true); tick();
}

// (Re)build list + graph for the selected AE, keeping the simulation loop running
function build(intro){
  const ae=$("aeSel").value;
  sumTab=null;   // tab defaults depend on the view (All AEs: What moved; one AE: Deal summary)
  const closedMode=viewMode==="closed";
  document.body.classList.toggle("closedMode",closedMode);
  const inAE=(closedMode?closedPool():allScored).filter(x=>!ae||x.p.owner===ae);
  scored=closedMode?inAE:inAE.filter(x=>!hasStages||!x.p.se_stage||onStages.has(x.p.se_stage));
  renderStageChips(closedMode?[]:inAE); $("stageChips").style.display=closedMode?"none":"";
  nodes=[]; links=[]; selected=null; measure();
  if(svg) svg.replaceChildren();
  $("right").innerHTML='<div class="sub">Click a prospect to see why it scores the way it does.</div>';
  $("meta").textContent = `${closedMode?"Closed deals · ":""}${ae?`AE: ${ae} · `:""}as of ${meta.generated}` + (meta.note?` · ${meta.note}`:"");
  // Totals for exactly what is on screen (follows the AE and stage filters; in the Closed view: closed-won ARR)
  const sum=(arr,f)=>arr.reduce((t,x)=>t+f(x),0), big=n=>n>=1e6?`${CUR}${(n/1e6).toFixed(2)}M`:`${CUR}${Math.round(n/1e3)}k`;
  if(closedMode){
    const wins=scored.filter(x=>x.p.outcome==="won"), lost=scored.filter(x=>x.p.outcome==="lost"), won=sum(wins,x=>x.p.amount);
    if($("totals")) $("totals").innerHTML=`<div class="big" title="${CUR}${Math.round(won).toLocaleString()}">${big(won)}</div>
      <div class="lbl">closed-won ARR across <b>${wins.length}</b> deal${wins.length===1?"":"s"}${wins.length?` <span>since ${wins.map(x=>closedDate(x.p)).sort()[0].slice(0,7)}</span>`:""}</div>
      <div class="alt">${lost.length} technical loss${lost.length===1?"":"es"} (${big(sum(lost,x=>x.p.amount))}) · all closed deals, ${ae?"this AE":"all AEs"}</div>`;
    renderClosedPane();
  } else {
    const total=sum(scored,x=>x.p.amount), weighted=sum(scored,x=>x.s.expected), all=sum(allScored,x=>x.p.amount);
    if($("totals")) $("totals").innerHTML=`<div class="big" title="${CUR}${Math.round(total).toLocaleString()}">${big(total)}</div>
    <div class="lbl">total across <b>${scored.length}</b> opportunit${scored.length===1?"y":"ies"}${scored.length<allScored.length?`<br><span>of ${big(all)} in all ${allScored.length}</span>`:""}</div>
    <div class="alt">weighted by close confidence: <b>${big(weighted)}</b></div>`;
  }
  { const age=(Date.now()-new Date(meta.generated))/864e5; if(window.__fromSnapshot||age>2) $("meta").innerHTML+=`<br><span style="color:#fcd34d">${window.__fromSnapshot?"Showing last backup. ":""}Data is ${Math.round(age)} days old.</span>`; }

  // Structure: each AE is a hub; every prospect attaches to its AE. Competitors/industries are optional secondary tags.
  const hubMap=new Map(), entMap=new Map(), rnd=()=>({x:W*(.15+.7*Math.random()),y:H*(.15+.7*Math.random()),vx:0,vy:0});
  scored.forEach(({p,s})=>{
    nodes.push({id:p.id,kind:"prospect",p,s,r:8+s.importance*0.3,...rnd()});
    if(p.owner){
      const key="ae:"+p.owner; let h=hubMap.get(key);
      if(!h){ h={id:key,kind:"ae",name:p.owner,amount:0,n:0,r:16,...rnd()}; hubMap.set(key,h); nodes.push(h); }
      h.amount+=p.amount; h.n++; links.push({a:p.id,b:key,kind:"ae"});
    }
    p.entities.filter(e=>!e.name.startsWith("(")&&!e.name.startsWith("AE: ")).forEach(e=>{
      const key=e.type+":"+e.name;
      if(!entMap.has(key)){ const n={id:key,kind:"entity",e,r:5,...rnd()}; entMap.set(key,n); nodes.push(n); }
      links.push({a:p.id,b:key,kind:"tag"});
    });
  });
  hubMap.forEach(h=>h.r=12+Math.sqrt(h.amount/1000)*0.8);
  // Spacing: fewer nodes -> more room each (spread out), and slightly larger nodes
  const shown=nodes.filter(n=>n.kind!=="entity").length;
  LS=Math.max(.8,Math.min(3.2,Math.sqrt(W*H/(shown*12000))));
  const rs=Math.min(1.4,.75+.3*LS); nodes.forEach(n=>n.r*=rs);
  // (placed after boxes exist, see below)
  // Collision boxes include the text label so names never land on other nodes or labels (cy = box centre offset from node centre)
  markTops();
  if(nodes.filter(n=>n.kind==="ae").length>1&&nodes.length>30) nodes.forEach(n=>{ if(n.kind==="prospect") n.r*=.86; });   // crowded orbit view: slightly smaller nodes
  nodes.forEach(n=>{
    if(n.kind==="prospect"){ sizeBox(n,false); }
    else if(n.kind==="ae"){ n.bw=Math.max(2*n.r,tw(n.name,800,14)+6); n.bh=2*n.r+48; n.cy=-24; }
    else { n.bw=Math.max(12,n.e.name.length*5.6); n.bh=24; n.cy=6; }
  });
  // Single-AE view: start from a ring around the hub. Longest names alternate with shortest so neighbours never carry two long labels.
  markTops();
  const hubs=nodes.filter(n=>n.kind==="ae");
  [...hubs].sort((x,y)=>lastName(x.name).localeCompare(lastName(y.name))||x.name.localeCompare(y.name)).forEach((h,i,all)=>{ h.ai=i; h.an=all.length; });
  orbit=hubs.length>1;
  if(orbit){
    // Dynamic ring: each AE's arc grows with their number of deals (sub-linear), so busy AEs get room and small ones tuck in beside neighbours.
    const ord=[...hubs].sort((x,y)=>lastName(x.name).localeCompare(lastName(y.name))||x.name.localeCompare(y.name));
    const cnt=h=>nodes.filter(n=>n.kind==="prospect"&&n.p.owner===h.name).length;
    const N=ord.length, TAU=2*Math.PI, wts=ord.map(h=>1.5+Math.pow(cnt(h),.8)), tot=wts.reduce((s,x)=>s+x,0);
    const share=wts.map(w=>.35/N+.65*w/tot);                                   // 35% equal, 65% proportional to deal count
    // gap between neighbouring hub centres = average of their two arcs; never smaller than the labels need
    let gaps=ord.map((_,i)=>(share[i]+share[(i+1)%N])/2*TAU);
    const minGap=Math.min(TAU/N*.98, 2*Math.asin(Math.min(.98,(Math.max(...ord.map(h=>h.bw))*.78+10)/(2*Math.max(80,Math.min(W,H)/2-70)*.6))));
    const extra=gaps.map(g=>Math.max(0,g-minGap)), ex=extra.reduce((s,x)=>s+x,0);
    gaps=gaps.map((g,i)=>minGap+(ex>0?extra[i]*(TAU-N*minGap)/ex:0));
    let th=-Math.PI/2; ord.forEach((h,i)=>{ h.th=th; th+=gaps[i]; });             // first AE (A) at 12 o'clock, clockwise
    nodes.filter(n=>n.kind==="prospect").forEach(n=>{ n.hub=hubs.find(h=>h.name===n.p.owner); });
    placeOrbit();
  }
  if(hubs.length===1){
    const h=hubs[0]; h.x=W/2; h.y=H/2;
    const ps=nodes.filter(n=>n.kind==="prospect").sort((x,y)=>y.p.name.length-x.p.name.length), order=[];
    for(let lo=0,hi=ps.length-1;lo<=hi;){ order.push(ps[lo++]); if(lo<=hi) order.push(ps[hi--]); }
    order.forEach((n,i)=>{ const ang=-Math.PI/2+2*Math.PI*i/order.length, rr=aeRest({s:n,t:h}); n.x=h.x+Math.cos(ang)*rr*Math.min(1.5,W/H); n.y=h.y+Math.sin(ang)*rr; });
  }
  shakes=0;
  const byId = new Map(nodes.map(n=>[n.id,n]));
  links.forEach(l=>{l.s=byId.get(l.a);l.t=byId.get(l.b);});
  renderList(); buildSvg(); $("showEnt").onchange=updateVisibility; updateVisibility(); alpha=1;
  // Open on the most important live deal so the detail panel is never empty
  const top=scored.find(x=>!(x.p.outcome==="lost"||(x.p.outcome==="won"&&x.p.signed)))||scored[0];
  if(top) select(top.p.id,{quiet:!!intro});
  if(intro) introWaves();
  builtFor=[W,H];
}

function renderStageChips(inAE){
  const box=$("stageChips"); box.innerHTML=""; if(!hasStages) return;
  SE_STAGES.forEach(st=>{
    const ds=inAE.filter(x=>x.p.se_stage===st), b=document.createElement("button");
    b.className="stage"+(onStages.has(st)?" on":""); b.dataset.stage=st;
    b.innerHTML=`${STAGE_SHORT[st]||st} <b>${ds.length}</b>${ds.length?` <span>${money(ds.reduce((t,x)=>t+x.p.amount,0))}</span>`:""}`;
    b.onclick=()=>{ onStages.has(st)?onStages.delete(st):onStages.add(st);
      const u=new URL(location); u.searchParams.set("stages",[...onStages].join("~")); history.replaceState(null,"",u); build(); };
    box.appendChild(b);
  });
}
function renderList(){
  $("list").innerHTML="";
  if(viewMode==="closed"){
    const h=document.querySelector("#left h2"); if(h) h.textContent="Closed deals · newest first";
    scored.forEach(({p,s})=>{ const d=document.createElement("div"); d.className="row"; d.dataset.id=p.id;
      d.innerHTML=`<span class="dot" style="background:${nodeColor(p,s)}"></span><span class="n"><b>${p.name}</b><span class="sub">${p.owner||""} · ${money(p.amount)}${p.arr?" ARR":""} · ${closedDate(p)}</span></span><span class="score">${p.outcome==="won"?"Won":"Loss"}</span>`;
      d.onclick=()=>select(p.id); $("list").appendChild(d); });
    if(!scored.length) $("list").innerHTML='<div class="sub" style="padding:8px">No closed deals for this selection.</div>';
    return;
  }
  { const h=document.querySelector("#left h2"); if(h) h.textContent="Ranked by importance"; }
  const isDecided=x=>x.p.outcome==="lost"||(x.p.outcome==="won"&&x.p.signed);
  const open=scored.filter(x=>!isDecided(x)), closed=scored.filter(isDecided);
  const add=({p,s})=>{
    const d=document.createElement("div"); d.className="row"; d.dataset.id=p.id;
    d.innerHTML=`<span class="dot" style="background:${nodeColor(p,s)}"></span><span class="n"><b>${p.name}</b><span class="sub">${money(p.amount)} · ${p.stage}${outcomeKey(p)==="techwin"?" · tech win, unsigned":""}</span></span><span class="score">${isDecided({p})?OUTCOME_LABEL[outcomeKey(p)]:s.importance}</span>`;
    d.onclick=()=>select(p.id); $("list").appendChild(d);
  };
  open.forEach(add);
  if(closed.length){ const h=document.createElement("h2"); h.textContent=`Decided (${closed.length})`; $("list").appendChild(h); closed.forEach(add); }
}

let svg, gLinks, gNodes, W=800, H=600;
let LEG=null;   // the Recent-activity legend, as a keep-out rectangle in graph coordinates
function measure(){
  const r=$("svg").getBoundingClientRect(); W=r.width||800; H=r.height||600;
  const l=$("legend").getBoundingClientRect(); LEG={x0:l.left-r.left-10,y0:l.top-r.top-10,x1:l.right-r.left+10,y1:l.bottom-r.top+10};
}
const lastName=n=>n.trim().split(/\s+/).pop().toLowerCase();
// All-AEs view: hub i of N sits at angle i/N clockwise from the top, ordered A-Z by last name
const _ctx=document.createElement("canvas").getContext("2d");
function tw(s,weight,px){ _ctx.font=`${weight} ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Arial, sans-serif`; return _ctx.measureText(s).width; }
// Collision box of a prospect node incl. its label (centre offset cy). noLabel = label hidden (shown on hover) -> circle-sized box.
function sizeBox(n,big){
  if(n.noLabel){ n.bw=n.bh=2*n.r+10; n.cy=0; return; }
  const px=big?14:n.isTop?12:11, wt=(big||n.isTop)?800:600;
  n.bw=Math.max(2*n.r+12,tw(n.p.name,wt,px)+6); n.bh=2*n.r+32; n.cy=12;
}
function ringR(){
  const hubs=nodes.filter(n=>n.kind==="ae"), N=Math.max(1,hubs.length), wmax=Math.max(0,...hubs.map(h=>h.bw||0));
  const room=Math.min(W,H)/2-70;                                   // leave space outside the ring for deals + labels
  const ths=hubs.map(h=>h.th).sort((x,y)=>x-y); let gap=2*Math.PI/N;
  for(let i=0;i<ths.length;i++){ const d=(ths[(i+1)%ths.length]-ths[i]+2*Math.PI)%(2*Math.PI)||2*Math.PI; gap=Math.min(gap,d); }
  const need=(wmax+14)/(2*Math.sin(Math.max(.2,gap)/2));           // neighbouring hub labels never touch
  return Math.min(Math.max(need,room*.42),Math.max(room*.62,room*.42));
}
function theta(h){ return h.th; }                                  // set in build(): clockwise A-Z by last name, share of the circle grows with deal count
// In a wide, short area the ring stretches into an ellipse so neighbouring AEs get horizontal room (ratio 1 = a circle)
function ringRX(){ const R=ringR(); return Math.min(R*Math.min(2.4,Math.max(1,W/H)), Math.max(R,W/2-110)); }
// distance from the centre measured in "ring units" (equals ringR() exactly on the ring, circle or ellipse)
function ringNorm(x,y){ const R=ringR(), RX=ringRX(); return Math.hypot((x-W/2)*R/RX,(y-H/2)); }
function anchorOf(h){ const a=theta(h), R=ringR(), RX=ringRX(); return {x:W/2+Math.cos(a)*RX, y:H/2+Math.sin(a)*R}; }
// Each AE's most important live deal (ties/none live: highest importance). It is placed on the straight line out from the hub.
function topTarget(n){
  const h=n.hub, A=anchorOf(h), th=theta(h), ux=Math.cos(th), uy=Math.sin(th), pad=8;
  const hubBoxes=[[A.x-h.r,A.y-h.r,A.x+h.r,A.y+h.r],[A.x-h.bw/2,A.y+h.cy-h.bh/2,A.x+h.bw/2,A.y+h.cy+h.bh/2]];
  for(let d=h.r+n.r+30;d<420;d+=6){
    const x=A.x+ux*d, y=A.y+uy*d, b=[x-n.bw/2,y+n.cy-n.bh/2,x+n.bw/2,y+n.cy+n.bh/2];
    if(!hubBoxes.some(q=>b[2]+pad>q[0]&&b[0]-pad<q[2]&&b[3]+pad>q[1]&&b[1]-pad<q[3])) return {x,y};
  }
  return {x:A.x+ux*120,y:A.y+uy*120};
}
const boxAt=(n,x,y)=>[x-n.bw/2,y+n.cy-n.bh/2,x+n.bw/2,y+n.cy+n.bh/2];
const boxHit=(p,q,pad)=>p[2]+pad>q[0]&&p[0]-pad<q[2]&&p[3]+pad>q[1]&&p[1]-pad<q[3];
function segHits(ax,ay,bx,by,cx,cy,r){ const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy||1, t=Math.max(0,Math.min(1,((cx-ax)*dx+(cy-ay)*dy)/l2)); return Math.hypot(cx-(ax+dx*t),cy-(ay+dy*t))<r; }
// Greedy placement: top deals first (dead ahead of their AE), then the rest round-robin. Each deal takes the closest free spot outward from
// its AE (within +-80 degrees of the outward ray) whose label box clears everything placed so far, the legend and the pane edge, and
// whose line to the AE passes through no node (and no earlier line passes through it).
function placeOrbit(){
  const hubs=nodes.filter(n=>n.kind==="ae"&&n.an>1); if(!hubs.length) return;
  hubs.forEach(h=>{ const p=anchorOf(h); h.x=p.x; h.y=p.y; });
  nodes.forEach(n=>{ if(n.kind==="prospect"&&n.noLabel){ n.noLabel=false; sizeBox(n,false); } });   // re-evaluate on every (re)pack
  const R=ringR(), fixedBoxes=hubs.map(h=>boxAt(h,h.x,h.y)); if(LEG) fixedBoxes.push([LEG.x0,LEG.y0,LEG.x1,LEG.y1]);
  const placed=[];
  const INNER=[{inner:true,deg:60,lines:true,pad:8},{inner:true,deg:100,lines:true,pad:6}];
  const STAGES=[{deg:80,ring:1,lines:true,pad:8},{deg:140,ring:1,lines:true,pad:8},{deg:180,ring:.6,lines:true,pad:8},{deg:180,ring:.4,lines:true,pad:6},
                {deg:180,ring:0,lines:true,pad:4},{deg:180,ring:0,lines:true,pad:4,nolabel:true},
                {deg:180,ring:.4,lines:false,pad:8},{deg:180,ring:0,lines:false,pad:4},{deg:180,ring:0,lines:false,pad:4,nolabel:true},{deg:180,ring:0,lines:false,pad:-4,nolabel:true}];
  // Closest free spot outward from the AE: label box clears everything, legend and pane edge; (when st.lines) my line avoids every node and no line goes through me.
  function findSpot(n,stages){
    const h=n.hub; let best=null;
    for(const st of stages){
      const th=theta(h)+(st.inner?Math.PI:0);                    // inner stages fan out toward the centre of the circle

      if(st.nolabel&&!n.noLabel){ n.noLabel=true; sizeBox(n,false); }
      const degs=[0]; for(let d=8;d<=st.deg;d+=8) degs.push(d,-d);
      for(const deg of (n.isTop&&st===stages[0]?[0]:degs)){
        const ang=th+deg*Math.PI/180, cx=Math.cos(ang), cy=Math.sin(ang);
        for(let d=h.r+n.r+28; d<Math.max(W,H); d+=st.ring===0?6:10){
          const cost=d+Math.abs(deg)*1.4; if(best&&cost>=best.cost) break;
          const x=h.x+cx*d, y=h.y+cy*d;
          const rho=ringNorm(x,y);
          if(st.inner){ if(rho>R-n.r-8||rho<n.r+20) continue; }                                   // inside the circle, clear of the middle
          else if(rho<(st.ring===1?R+h.r+n.r+10:R*st.ring)) continue;                              // outside the ring (relaxed in later stages)
          if(x<n.bw/2+8||x>W-n.bw/2-8||y<n.bh/2-n.cy+8||y>H-n.bh/2-n.cy-8) continue;            // inside the pane
          const b=boxAt(n,x,y);
          if(fixedBoxes.some(q=>boxHit(b,q,st.pad-2))||placed.some(p=>p.n!==n&&boxHit(b,p.box,st.pad))) continue;   // labels/nodes never overlap
          if(st.lines){
            if(placed.some(p=>p.n!==n&&segHits(h.x,h.y,x,y,p.x,p.y,p.n.r+9))||hubs.some(o=>o!==h&&segHits(h.x,h.y,x,y,o.x,o.y,o.r+6))) continue;
            if(placed.some(p=>p.n!==n&&segHits(p.hub.x,p.hub.y,p.x,p.y,x,y,n.r+9))) continue;
          }
          best={x,y,cost}; break;
        }
      }
      if(best) return best;
    }
    return null;
  }
  const commit=(n,sp)=>{ n.home=sp; n.x=sp.x; n.y=sp.y; n.vx=n.vy=0; const e=placed.find(p=>p.n===n), rec={n,x:sp.x,y:sp.y,hub:n.hub,box:boxAt(n,sp.x,sp.y)}; if(e) Object.assign(e,rec); else placed.push(rec); };
  const queues=hubs.map(h=>{
    const kids=nodes.filter(n=>n.kind==="prospect"&&n.hub===h).sort((x,y)=>(y.isTop-x.isTop)||(x.p.name.length-y.p.name.length)||(y.s.importance-x.s.importance));
    // the AE's lowest-importance deals (1-2, only if the AE has 3+) are tried on the inside of the circle first, right beside the AE
    const minor=kids.filter(n=>!n.isTop).sort((x,y)=>x.s.importance-y.s.importance).slice(0,kids.length>=4?2:kids.length>=3?1:0);
    kids.forEach(n=>{ n.inner=minor.includes(n); });
    return [...kids.filter(n=>n.isTop),...minor,...kids.filter(n=>!n.isTop&&!n.inner)];
  });
  const maxLen=Math.max(0,...queues.map(q=>q.length));
  for(let k=0;k<maxLen;k++) queues.forEach(q=>{
    const n=q[k]; if(!n) return;
    const h=n.hub, th=theta(h);
    const sp=findSpot(n,n.inner?[...INNER,...STAGES]:STAGES)||{x:h.x+Math.cos(th)*(h.r+n.r+60),y:h.y+Math.sin(th)*(h.r+n.r+60)};
    if(sp===null) (window.__fb=window.__fb||[]).push(n.p.name);
    commit(n,sp);
  });
  // Repair: any deal whose line passes through another node is re-placed with the line rule enforced.
  for(let it=0;it<4;it++){
    let moved=false;
    for(const p of [...placed]){
      if(p.n.isTop) continue;
      const bad=placed.some(o=>o!==p&&segHits(p.hub.x,p.hub.y,p.x,p.y,o.x,o.y,o.n.r+8))||placed.some(o=>o!==p&&segHits(o.hub.x,o.hub.y,o.x,o.y,p.x,p.y,p.n.r+8));
      if(!bad) continue;
      const keep={x:p.x,y:p.y}, sp=findSpot(p.n,STAGES.filter(s=>s.lines));
      if(sp){ commit(p.n,sp); moved=true; } else { p.n.home=keep; }
    }
    if(!moved) break;
  }
  // Shorten long lines: now that everything is placed, deals that landed far from their AE get another go at a closer free spot.
  const lineLen=p=>Math.hypot(p.x-p.hub.x,p.y-p.hub.y), linesOnly=STAGES.filter(s=>s.lines);
  for(let it=0;it<3;it++){
    let moved=false;
    for(const p of [...placed].filter(q=>!q.n.isTop).sort((x,y)=>lineLen(y)-lineLen(x))){
      const cur=lineLen(p); if(cur<190) break;
      const wasNo=p.n.noLabel, sp=findSpot(p.n,p.n.inner?[...INNER,...linesOnly]:linesOnly);
      if(sp&&Math.hypot(sp.x-p.hub.x,sp.y-p.hub.y)<cur-24){ commit(p.n,sp); moved=true; }
      else if(p.n.noLabel!==wasNo){ p.n.noLabel=wasNo; sizeBox(p.n,false); }     // search must not leave a label hidden by accident
    }
    if(!moved) break;
  }
  placedFor=[W,H];
}
let placedFor=[0,0];
function markTops(){
  const best=new Map();
  nodes.filter(n=>n.kind==="prospect").forEach(n=>{
    const live=!(n.p.outcome==="lost"||(n.p.outcome==="won"&&n.p.signed)); n.isTop=false;
    const c=best.get(n.p.owner);
    if(!c||(live&&!c.live)||(live===c.live&&n.s.importance>c.n.s.importance)) best.set(n.p.owner,{n,live});
  });
  best.forEach(v=>v.n.isTop=true);
}
// Nodes (box incl. label) may never sit behind the legend: push out along the shorter way (up or right)
function avoidLegend(n){
  if(!LEG) return;
  const x0=n.x-n.bw/2, x1=n.x+n.bw/2, y0=n.y+n.cy-n.bh/2, y1=n.y+n.cy+n.bh/2;
  if(x1>LEG.x0&&x0<LEG.x1&&y1>LEG.y0&&y0<LEG.y1){
    const up=y1-LEG.y0, right=LEG.x1-x0;
    if(up<=right) n.y-=up; else n.x+=right;
  }
}
const isPinned=n=>n.fixed||(n.kind==="ae"&&n.an>1)||(n.kind==="prospect"&&n.isTop&&n.hub&&n.hub.an>1);
function clampNode(n){
  const cl=()=>{ n.x=Math.max(n.bw/2+8,Math.min(W-n.bw/2-8,n.x)); n.y=Math.max(n.bh/2-n.cy+8,Math.min(H-n.bh/2-n.cy-8,n.y)); };
  cl(); avoidLegend(n); cl();
}
addEventListener("resize",measure);
function buildSvg(){
  svg=$("svg"); measure();
  gLinks=el("g",{},svg); gNodes=el("g",{},svg);
  links.forEach(l=>l.el=el("line",{stroke:"#33405e","stroke-width":1.2},gLinks));
  nodes.forEach(n=>{
    const g=el("g",{style:"cursor:pointer"},gNodes); n.el=g;
    if(n.kind==="prospect"){
      el("circle",{r:n.r,fill:nodeColor(n.p,n.s),"fill-opacity":.9},g);
      // confidence ring: arc length proportional to close confidence
      const R=n.r+4, C=2*Math.PI*R;
      el("circle",{r:R,fill:"none",stroke:"#2b3550","stroke-width":3},g);
      el("circle",{r:R,fill:"none",stroke:"#e6e9f2","stroke-width":3,"stroke-dasharray":`${C*n.s.confidence} ${C}`,transform:"rotate(-90)","stroke-linecap":"round"},g);
      const t=el("text",{class:"name-label","text-anchor":"middle",y:n.r+20,style:"fill:#dbe2ee"},g); t.textContent=n.p.name; n.labelEl=t;
      g.onclick=()=>select(n.id);
      g.onmouseenter=()=>{ if(n.noLabel) n.labelEl.style.display=""; wobble(n); }; g.onmouseleave=()=>{ if(n.noLabel&&n.id!==selected) n.labelEl.style.display="none"; };
    } else if(n.kind==="ae"){
      el("circle",{r:n.r,fill:"#1e293b",stroke:"#94a3b8","stroke-width":2},g);
      const fs=Math.round(Math.max(12,Math.min(16,n.r*.44)));
      const t=el("text",{class:"name-label","text-anchor":"middle",y:Math.round(fs*.36),style:`font-size:${fs}px;font-weight:800;fill:#ffffff`},g); t.textContent=n.name.split(" ").map(w=>w[0]).join("");
      const l=el("text",{class:"name-label","text-anchor":"middle",style:"font-size:14px;font-weight:800;fill:#ffffff"},g);
      const t1=el("tspan",{x:0,y:-n.r-24},l); t1.textContent=n.name;
      const t2=el("tspan",{x:0,y:-n.r-9,style:"font-size:12px;font-weight:700;fill:#cbd5e1"},l); t2.textContent=money(n.amount);
      g.onclick=()=>highlightEntity(n); g.onmouseenter=()=>wobble(n);
    } else {
      el("circle",{r:n.r,fill:ENT_COLOR[n.e.type]},g);
      const t=el("text",{class:"entity-label","text-anchor":"middle",y:n.r+11},g); t.textContent=n.e.name.replace(/ \(.*/,"");
      g.onclick=()=>highlightEntity(n);
    }
    g.onmousedown=ev=>drag(ev,n);
  });
}

function drag(ev,n){
  n.fixed=true; const mv=e=>{const b=svg.getBoundingClientRect();n.x=e.clientX-b.left;n.y=e.clientY-b.top;n.vx=n.vy=0;alpha=Math.max(alpha,.3)};
  const up=()=>{n.fixed=false;removeEventListener("mousemove",mv);removeEventListener("mouseup",up)};
  addEventListener("mousemove",mv);addEventListener("mouseup",up);
}

// Minimal force simulation: repulsion + springs + centering + collision
let alpha=1;
// Rest length of an AE link: base gap + extra per character of the deal name beyond ~8, so long names sit on the outer ring.
// Capped so the farthest node still fits inside the pane.
function aeRest(l){
  const n=l.s.kind==="prospect"?l.s:l.t, hub=l.s.kind==="ae"?l.s:l.t;
  const base=hub.r+n.r+30*LS, extra=Math.min(Math.max(n.p.name.length-8,0),22)*3.4*LS;
  const room=Math.max(60,Math.min(W,H)/2-n.bh/2-16);
  return Math.min(base+extra,room);
}
function step(){
  if(orbit){
    nodes.forEach(n=>{ if(n.fixed) return; if(n.kind==="ae"&&n.an>1){ const p=anchorOf(n); n.x=p.x; n.y=p.y; } else if(n.home){ n.x=n.home.x; n.y=n.home.y; } });
    alpha=Math.max(.02,alpha*.99); return;
  }
  const vis=n=>n.kind!=="entity"||$("showEnt").checked;
  const act=nodes.filter(vis);
  for(let i=0;i<act.length;i++)for(let j=i+1;j<act.length;j++){
    const a=act[i],b=act[j];
    if((a.home||(a.kind==="ae"&&a.an>1))&&(b.home||(b.kind==="ae"&&b.an>1))) continue;   // orbit view: packed positions are held, not re-shuffled by repulsion
    let dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy||1,d=Math.sqrt(d2);
    const f=(a.kind==="entity"||b.kind==="entity"?3500:a.kind==="ae"&&b.kind==="ae"?40000:9000)*LS*LS/d2*alpha;
    a.vx-=dx/d*f;a.vy-=dy/d*f;b.vx+=dx/d*f;b.vy+=dy/d*f;
    const min=a.r+b.r+22*LS; if(d<min){const o=(min-d)/2*.5;a.vx-=dx/d*o;a.vy-=dy/d*o;b.vx+=dx/d*o;b.vy+=dy/d*o;}
  }
  links.forEach(l=>{ if(!vis(l.t))return; const dx=l.t.x-l.s.x,dy=l.t.y-l.s.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=(d-(l.kind==="ae"?aeRest(l):120*LS))*(l.kind==="ae"?(l.t.an>1||l.s.an>1?.01:.06):.01)*alpha;
    l.s.vx+=dx/d*f;l.s.vy+=dy/d*f;l.t.vx-=dx/d*f;l.t.vy-=dy/d*f; });
  act.forEach(n=>{ // pull important prospects toward center
    if(n.kind==="ae"&&n.an>1){ const t=anchorOf(n); n.vx+=(t.x-n.x)*.2; n.vy+=(t.y-n.y)*.2; }   // hubs are held on their clock position
    else if(n.kind==="prospect"&&n.hub&&n.hub.an>1&&n.home){ n.vx+=(n.home.x-n.x)*.2; n.vy+=(n.home.y-n.y)*.2; }   // hold the packed position
    else if(!(n.kind==="prospect"&&n.hub&&n.hub.an>1)){ const g=n.kind==="prospect"?.002:.004; n.vx+=(W/2-n.x)*g; n.vy+=(H/2-n.y)*g; }
    if(!n.fixed){n.x+=n.vx;n.y+=n.vy;} n.vx*=.82;n.vy*=.82;
    clampNode(n);
  });
  // Resolve box overlaps directly (every frame, not damped by alpha) so the resting state has no text/node collisions
  const clamp=clampNode;
  const PAD=10*Math.min(LS,1.6);
  for(let pass=0;pass<4;pass++) for(let i=0;i<act.length;i++)for(let j=i+1;j<act.length;j++){
    const a=act[i],b=act[j];
    const dx=b.x-a.x||.01, dy=(b.y+b.cy)-(a.y+a.cy)||.01;
    const ox=(a.bw+b.bw)/2+PAD-Math.abs(dx), oy=(a.bh+b.bh)/2+PAD-Math.abs(dy);
    if(ox>0&&oy>0){
      const pinA=isPinned(a), pinB=isPinned(b);
      const fa=pinA?0:pinB?1:.5, fb=pinB?0:pinA?1:.5;
      if(ox<oy){ const s=Math.sign(dx)*ox; a.x-=s*fa; b.x+=s*fb; } else { const s=Math.sign(dy)*oy; a.y-=s*fa; b.y+=s*fb; }
    }
  }
  for(let pass=0;pass<2;pass++){
    for(const l of links){
      if(l.kind!=="ae"||!l.el) continue;
      const hub=l.s.kind==="ae"?l.s:l.t, tip=l.s===hub?l.t:l.s, dx=tip.x-hub.x, dy=tip.y-hub.y, len2=dx*dx+dy*dy||1;
      for(const n of act){
        if(n===hub||n===tip||n.kind!=="prospect") continue;
        const t=Math.max(0,Math.min(1,((n.x-hub.x)*dx+(n.y-hub.y)*dy)/len2)), px=hub.x+dx*t, py=hub.y+dy*t;
        let ox=n.x-px, oy=n.y-py, d=Math.hypot(ox,oy); const clear=n.r+7;
        if(d>=clear) continue;
        if(d<.01){ ox=-dy; oy=dx; d=Math.hypot(ox,oy)||1; }
        if(!isPinned(n)){ const s=(clear-d)/d; n.x+=ox*s; n.y+=oy*s; }                       // move the obstacle aside
        else if(!isPinned(tip)&&t>.15){                                                       // obstacle is pinned: swing the far end of the line around it instead
          const len=Math.sqrt(len2), nx=-dy/len, ny=dx/len, side=(ox*nx+oy*ny)>=0?-1:1, shift=Math.min(70,(clear-d)/t);
          tip.x+=nx*side*shift; tip.y+=ny*side*shift;
        }
      }
    }
    if(pass===0) for(let i=0;i<act.length;i++)for(let j=i+1;j<act.length;j++){   // re-settle label overlaps the line pushes may have caused
      const A=act[i],B=act[j], dx=B.x-A.x||.01, dy=(B.y+B.cy)-(A.y+A.cy)||.01, ox=(A.bw+B.bw)/2+PAD-Math.abs(dx), oy=(A.bh+B.bh)/2+PAD-Math.abs(dy);
      if(ox>0&&oy>0){ const pa=isPinned(A), pb=isPinned(B), fa=pa?0:pb?1:.5, fb=pb?0:pa?1:.5;
        if(ox<oy){ const s=Math.sign(dx)*ox; A.x-=s*fa; B.x+=s*fb; } else { const s=Math.sign(dy)*oy; A.y-=s*fa; B.y+=s*fb; } }
    }
  }
  act.forEach(clamp);
  alpha=Math.max(.02,alpha*.99);
}
function overlapPairs(){
  const act=nodes.filter(n=>n.kind!=="entity"||$("showEnt").checked), out=[];
  for(let i=0;i<act.length;i++)for(let j=i+1;j<act.length;j++){
    const a=act[i],b=act[j], ox=(a.bw+b.bw)/2-Math.abs(b.x-a.x), oy=(a.bh+b.bh)/2-Math.abs((b.y+b.cy)-(a.y+a.cy));
    if(ox>0&&oy>0) out.push([a,b,Math.min(ox,oy)]);
  }
  return out;
}
function unstick(){
  if(nodes.some(n=>n.home)) return;   // orbit view: positions are computed, not settled by physics
  if(nodes.length&&alpha<=.03&&++frame%40===0&&shakes<12){
    const bad=overlapPairs().filter(b=>b[2]>4);   // ignore hairline touches
    if(bad.length){ shakes++; bad.forEach(([a,b])=>{ const m=[a,b].find(n=>n.kind==="prospect"&&!n.fixed); if(m){ m.x+=(Math.random()-.5)*160; m.y+=(Math.random()-.5)*160; } }); alpha=.5; }
  }
}
// Render-only wave: touching a node sends a small pulse outward through its AE cluster. Each node starts moving when the wave reaches it
// (delay grows with distance), is pushed along the line away from the source and eased back, with less energy the farther it is,
// and everything dies away to exactly zero. Layout positions are never touched.
const wobbles=new Map(), lastWave=new Map(), reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
const WAVE={speed:420, amp:6, reach:300, floor:.3, decay:2.9, freq:13};   // px/s, px, px, share kept far away, 1/s, rad/s
// opts.force skips the "already waving" throttle (used by the staggered intro, where waves are meant to overlap and add up)
function wobble(trigger,opts){
  if(reduceMotion||!trigger) return;
  const owner=trigger.kind==="ae"?trigger.name:trigger.p?.owner; if(!owner) return;
  const now=performance.now(), last=lastWave.get(owner); if(!(opts&&opts.force)&&last&&now-last<600) return; lastWave.set(owner,now);
  const hub=nodes.find(n=>n.kind==="ae"&&n.name===owner);
  nodes.filter(n=>n===hub||(n.kind==="prospect"&&n.p.owner===owner)).forEach(n=>{
    let dx=n.x-trigger.x, dy=n.y-trigger.y, d=Math.hypot(dx,dy);
    if(d<1){ dx=hub&&n!==hub?n.x-hub.x:0; dy=hub&&n!==hub?n.y-hub.y:-1; d=Math.hypot(dx,dy)||1; dx/=d; dy/=d; d=0; }   // the source itself: push away from its AE
    else { dx/=d; dy/=d; }
    const energy=WAVE.floor+(1-WAVE.floor)*Math.exp(-d/WAVE.reach);
    if(!wobbles.has(n)) wobbles.set(n,[]);
    wobbles.get(n).push({t0:now+d/WAVE.speed*1000,ux:dx,uy:dy,amp:WAVE.amp*energy*(n.kind==="ae"?.7:1)});
  });
}
function wobbleOffset(n,now){
  const ws=wobbles.get(n); if(!ws) return [0,0];
  let x=0,y=0;
  for(let i=ws.length-1;i>=0;i--){
    const w=ws[i], t=(now-w.t0)/1000; if(t>2.2){ ws.splice(i,1); continue; } if(t<0) continue;
    const k=Math.exp(-t*WAVE.decay)*Math.sin(t*WAVE.freq);      // push out, ease back, a small overshoot, then rest
    x+=w.ux*w.amp*k; y+=w.uy*w.amp*k;
  }
  if(!ws.length) wobbles.delete(n);
  return [x,y];
}
// Intro: the five most important live deals send out their waves one after another, each starting before the last has died away.
function introWaves(){
  const gone=x=>x.p.outcome==="lost"||(x.p.outcome==="won"&&x.p.signed);
  (viewMode==="closed"?scored:scored.filter(x=>!gone(x))).slice(0,5).forEach((x,i)=>{ const n=nodes.find(m=>m.id===x.p.id); if(n) setTimeout(()=>wobble(n,{force:true}),350+i*380); });
}
// If the graph area changes size (window, in-app pane, panel toggles) and then settles, lay out again for the new size.
// Orbit view re-packs in place; the single-AE view is rebuilt; the closed chart is redrawn. Selection is kept.
function relayoutIfResized(){
  const changed=Math.abs(W-builtFor[0])>24||Math.abs(H-builtFor[1])>24, now=performance.now();
  if(!changed){ sizeChangedAt=0; return; }
  if(!sizeChangedAt){ sizeChangedAt=now; return; }
  if(now-sizeChangedAt<250) return;                       // wait until it stops changing
  sizeChangedAt=0; builtFor=[W,H];
  if(!orbit&&nodes.length){ const keep=selected; build(false); if(keep&&scored.some(x=>x.p.id===keep)) select(keep,{quiet:true}); }
  else if(viewMode==="closed") renderClosedPane();
}
function tick(){
  measure(); relayoutIfResized(); if(nodes.some(n=>n.kind==="ae"&&n.an>1)&&(Math.abs(W-placedFor[0])>24||Math.abs(H-placedFor[1])>24)) placeOrbit(); if(nodes.length&&nodes[0].el) step();
  // Settled but still overlapping (stuck arrangement)? Jolt the offending deal nodes and let the layout re-settle, a few times at most.
  unstick();
  const now=performance.now();
  nodes.forEach(n=>{ const o=wobbleOffset(n,now); n.ox=o[0]; n.oy=o[1]; if(n.el) n.el.setAttribute("transform",`translate(${n.x+n.ox},${n.y+n.oy})`); });
  links.forEach(l=>{if(!l.el)return;l.el.setAttribute("x1",l.s.x+l.s.ox);l.el.setAttribute("y1",l.s.y+l.s.oy);l.el.setAttribute("x2",l.t.x+l.t.ox);l.el.setAttribute("y2",l.t.y+l.t.oy);});
  requestAnimationFrame(tick);
}
function updateVisibility(){
  if(selected) setTimeout(paint,0);
  const on=$("showEnt").checked;
  nodes.forEach(n=>{if(n.kind==="entity")n.el.style.display=on?"":"none";});
  links.forEach(l=>{if(l.kind==="tag")l.el.style.display=on?"":"none";}); alpha=.6;
}

// Visual state for the current selection.
//  single-AE view: everything bright, selected deal gets the bold label + glow.
//  All-AEs view:   every AE hub is lit, and so is each AE's most important live deal (node + its link) with an identical look;
//                  all other deals are dimmed. The selected deal only gets a faint ring unless it is one of those top deals.
function paint(){
  const single=!!$("aeSel").value, id=selected, GLOW="drop-shadow(0 0 6px #fff)";
  const gone=n=>n.p.outcome==="lost"||(n.p.outcome==="won"&&n.p.signed);
  const top=new Set(nodes.filter(n=>n.isTop).map(n=>n.id));
  const connected=new Set([id]); links.forEach(l=>{if(l.a===id)connected.add(l.b);});
  if(single&&$("showEnt").checked) links.forEach(l=>{if(l.kind==="tag"&&connected.has(l.b))connected.add(l.a);});
  nodes.forEach(m=>{
    if(m.kind==="ae"){ m.el.style.opacity=1; m.el.style.filter=""; return; }
    if(m.kind==="entity"){ m.el.style.opacity=single&&connected.has(m.id)?1:.45; return; }
    const sel=m.id===id, isTop=top.has(m.id), big=single&&sel;
    m.el.style.opacity=single?(connected.has(m.id)?1:.9):(isTop?1:.32);
    m.el.style.filter=single?(sel?GLOW:""):(sel&&!isTop?"drop-shadow(0 0 3px #fff)":"");
    m.labelEl.style.fontSize=big?"14px":isTop?"12px":"11px";
    m.labelEl.style.fontWeight=(big||isTop)?800:600;
    m.labelEl.style.fill=(big||isTop)?"#ffffff":"#dbe2ee";
    sizeBox(m,big);   // wider labels: let the collision pass make room
    m.labelEl.style.display=(m.noLabel&&!(sel))?"none":"";
  });
  alpha=Math.max(alpha,.25);
  links.forEach(l=>{
    const hot=!single&&l.kind==="ae"&&(top.has(l.s.id)||top.has(l.t.id));
    l.el.style.opacity=single?((connected.has(l.a)&&connected.has(l.b))?1:.45):(hot?1:.12);
    l.el.setAttribute("stroke",hot?"#9fb0c8":"#33405e"); l.el.setAttribute("stroke-width",hot?2.4:1.2);
  });
}
function select(id,opts){
  selected=id;
  document.querySelectorAll(".row").forEach(r=>r.classList.toggle("sel",r.dataset.id===id));
  const n=nodes.find(x=>x.id===id); const {p,s}=n;
  paint(); if(!(opts&&opts.quiet)) wobble(n);
  const pct=x=>Math.round(x*100)+"%";
  const q=Object.keys(QUAL_WEIGHTS).map(k=>`<span class="chip ${p.qual[k]?'ok':'no'}">${p.qual[k]?'✓':'✗'} ${k.replace('_',' ')}</span>`).join("");
  const ents=[p.owner?`<span class="chip">AE: ${p.owner}</span>`:"",...p.entities.filter(e=>!e.name.startsWith("AE: ")).map(e=>`<span class="chip">${e.type}: ${e.name}</span>`)].join("");
  const sigs=[...p.signals].sort((a,b)=>b.date.localeCompare(a.date)).map(x=>`<div class="sig"><small>${x.date} · ${x.source}</small><br>${x.summary}</div>`).join("")||'<div class="sub">No signals recorded.</div>';
  $("right").innerHTML=`<div class="hdr"><h1>${p.name}</h1><button id="refreshBtn" title="Re-research Slack, Gmail and Fellow for this deal" onclick="refreshDeal('${p.id}')">↻ Refresh</button></div><div class="sub">${p.stage_label||p.stage} · close ${p.close_date}</div><div class="sub" id="refmeta"></div>${safeHref(p.url,[".salesforce.com"])?`<div class="sub linkrow"><a href="${esc(safeHref(p.url,[".salesforce.com"]))}" target="_blank" rel="noopener noreferrer">Open in Salesforce ↗</a> <span>to change anything, edit it there or in SIP</span></div>`:""}
  ${p.outcome?`<div class="chip" style="background:${OUTCOME_COLOR[outcomeKey(p)]||'#222b44'};color:#111">${OUTCOME_LABEL[outcomeKey(p)]}${p.outcome_date?' · '+p.outcome_date:''}</div><div class="sub">${p.outcome_note||''}</div>`:''}<h2>Score</h2>
  <div class="metric"><span>Importance</span><b>${s.importance}/100</b></div>
  <div class="metric"><span>Amount</span><b>${money(p.amount)}</b></div>
  <div class="metric"><span>Close confidence</span><b>${pct(s.confidence)}</b></div>
  <div class="metric"><span>Info completeness</span><b>${pct(s.info)}</b></div>
  <div class="metric"><span>Weighted value</span><b>${money(s.expected)}</b></div>
  <div class="metric"><span>Last signal</span><b>${Math.floor(s.daysSinceLast)}d ago (${s.signals30} in 30d)</b></div>
  <h2>What we know</h2>${q}<h2>Linked</h2>${ents}<h2>Recent signals</h2>${sigs}${summaryBox(p)}`;
  refreshUI(p.id);
}
function highlightEntity(n){
  const ids=new Set([n.id]); links.forEach(l=>{if(l.b===n.id)ids.add(l.a);});
  nodes.forEach(m=>m.el.style.opacity=ids.has(m.id)?1:.18); links.forEach(l=>l.el.style.opacity=l.b===n.id?1:.1);
  const title=n.kind==="ae"?n.name:n.e.name, kind=n.kind==="ae"?`Account Executive · ${n.n} deals · ${money(n.amount)}`:n.e.type;
  const deals=links.filter(l=>l.b===n.id).map(l=>l.s).sort((x,y)=>y.s.importance-x.s.importance);
  $("right").innerHTML=`<h1>${title}</h1><div class="sub">${kind}</div><h2>Deals</h2>`+
    deals.map(d=>`<div class="row" onclick="select('${d.id}')"><span class="dot" style="background:${nodeColor(d.p,d.s)}"></span><span class="n"><b>${d.p.name}</b><span class="sub">${money(d.p.amount)} · ${d.p.stage}</span></span><span class="score">${d.s.importance}</span></div>`).join("");
}
addEventListener("keydown",e=>{if(e.key==="Escape"){nodes.forEach(n=>n.el.style.opacity=1);links.forEach(l=>l.el.style.opacity=1);}});

// Deal summary box, docked to the bottom of the right panel (collapsible)
// Links back to the systems of record (the dashboard itself never edits anything). Only https links to expected hosts are ever rendered.
function safeHref(u,suffixes){ try{ const x=new URL(u); return x.protocol==="https:"&&suffixes.some(s=>x.hostname.endsWith(s))?x.href:""; }catch(e){ return ""; } }
const esc=s=>String(s??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const fmtDay=d=>new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"});
function digestHTML(){
  const vis=new Map(scored.map(x=>[x.p.id,x])), byDay=new Map();
  changelog.forEach(c=>{ if(vis.has(c.id)){ if(!byDay.has(c.date)) byDay.set(c.date,[]); byDay.get(c.date).push(c); } });
  const days=[...byDay.keys()].sort().reverse().slice(0,5);
  if(!days.length) return '<div class="sub">Nothing recorded yet. Changes appear after a refresh updates a deal.</div>';
  return days.map(d=>`<h3>${fmtDay(d)} <span class="sub">· ${byDay.get(d).length} moved</span></h3><ul class="moved">${
    byDay.get(d).sort((x,y)=>vis.get(y.id).s.importance-vis.get(x.id).s.importance).map(c=>{ const x=vis.get(c.id);
      return `<li onclick="select('${c.id}')"><b>${esc(x.p.name)}</b> <span class="ae">${esc(x.p.owner||"")}</span> ${esc(c.headline)}${c.new_signals?` <small>${c.new_signals} new signal${c.new_signals>1?"s":""}</small>`:""}</li>`; }).join("")}</ul>`).join("");
}
function setSumTab(t){ sumTab=t; document.querySelectorAll(".sumtab").forEach(b=>b.classList.toggle("on",b.dataset.tab===t));
  $("paneMoved").style.display=t==="moved"?"":"none"; $("paneDeal").style.display=t==="deal"?"":"none"; }
function summaryBox(p){
  const s=p.summary, tab=sumTab||($("aeSel").value?"deal":"moved");
  const deal=s?`<div class="sumline">${esc(s.headline)}</div><div class="sub" style="margin:-2px 0 4px">as of ${esc(s.as_of)}</div>
    <h3>Where it stands</h3><ul>${s.status.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>
    <h3>Open items</h3><ul class="items">${s.open_items.map(i=>`<li><b>${esc(i.owner)}</b>: ${esc(i.text)}${i.due?` <em>${esc(i.due)}</em>`:""}<small>${esc(i.source)}</small></li>`).join("")}</ul>
    <h3>Watch-outs</h3><ul>${s.watch.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>
    <div class="srcs">Sources: ${s.sources.map(esc).join(" · ")}</div>`
    :`<div class="sub">No summary yet. Ask Claude to "summarize ${esc(p.name)}" to build one from Slack, Gmail and Fellow.</div>`;
  return `<div class="sumbox${params.get("summary")==="0"?" closed":""}" id="sumbox"><div class="sumhead">
    <span class="sumtabs"><button class="sumtab${tab==="moved"?" on":""}" data-tab="moved" onclick="setSumTab('moved')">What moved</button><button class="sumtab${tab==="deal"?" on":""}" data-tab="deal" onclick="setSumTab('deal')">${esc(p.name)}</button></span>
    <span class="sub sumtoggle" onclick="document.getElementById('sumbox').classList.toggle('closed')">collapse</span></div>
    <div class="sumbody"><div id="paneMoved" style="display:${tab==="moved"?"":"none"}">${digestHTML()}</div><div id="paneDeal" style="display:${tab==="deal"?"":"none"}">${deal}</div></div></div>`;
}

// ---- refresh button: POST to scripts/server.py, poll status, then reload summaries and redraw ----
const ago=iso=>{ if(!iso) return "never"; const h=(Date.now()-new Date(iso))/36e5; return h<1?"just now":h<48?`${Math.round(h)}h ago`:`${Math.round(h/24)}d ago`; };
const TIER_LABEL={daily:"daily",every3days:"every 3 days",weekly:"weekly"};
function refreshUI(id){
  const p=allScored.find(x=>x.p.id===id)?.p, btn=$("refreshBtn"), meta=$("refmeta"); if(!p||!btn) return;
  const st=statuses[id]||{}, running=st.state==="running";
  btn.disabled=running; btn.textContent=running?"⟳ Refreshing…":"↻ Refresh";
  const t=tiers[id];
  meta.innerHTML=`Summary updated ${ago(p.summary?.refreshed_at||p.summary?.as_of)}${p.summary?.checked_at&&p.summary.checked_at>(p.summary.refreshed_at||"")?` · checked ${ago(p.summary.checked_at)}, nothing new`:""}${t?` · auto-refresh ${TIER_LABEL[t.tier]}`:""}`+
    (st.state==="error"?`<br><span style="color:#fca5a5">Last refresh failed: ${esc(st.error||"")}</span>`:"");
  if(running) pollRefresh(id);
}
async function refreshDeal(id){
  $("refreshBtn").disabled=true;
  const r=await fetch("/api/refresh",{method:"POST",body:JSON.stringify({id})}).catch(()=>null);
  if(!r||!r.ok){ $("refmeta").innerHTML='<span style="color:#fca5a5">Refresh needs the local server: run <code>python3 scripts/server.py</code></span>'; $("refreshBtn").disabled=false; return; }
  statuses[id]={state:"running"}; refreshUI(id);
}
const polling=new Set();
function pollRefresh(id){
  if(polling.has(id)) return; polling.add(id);
  const tickp=async()=>{
    await loadStatus(); const st=statuses[id]||{};
    if(st.state==="running"){ setTimeout(tickp,4000); return; }
    polling.delete(id);
    if(st.state==="done"){
      const sums=await fetch(`${api("summaries.json")}?t=${Date.now()}`).then(r=>r.json());
      applySummaries(allScored.map(x=>x.p),sums);
      changelog=await fetch(`${api("changelog.json")}?t=${Date.now()}`).then(r=>r.ok?r.json():[]).catch(()=>changelog);
      allScored.forEach(x=>x.s=scoreProspect(x.p,NOW,MAXAMT)); allScored.sort((a,b)=>b.s.importance-a.s.importance);
      fetch("/api/tiers").then(r=>r.json()).then(t=>tiers=t).catch(()=>{});
      const keep=selected; build(); if(allScored.some(x=>x.p.id===keep)&&scored.some(x=>x.p.id===keep)) select(keep);
    } else if(selected===id) refreshUI(id);
  };
  setTimeout(tickp,4000);
}

// ?debug=1 -> after the layout settles, record how many node/label boxes still overlap (used for layout checks)
if(params.get("debug")) setTimeout(()=>{
  for(let i=0;i<4000;i++){ step(); unstick(); }
  nodes.forEach(n=>n.el&&n.el.setAttribute("transform",`translate(${n.x},${n.y})`));
  links.forEach(l=>{if(!l.el)return;l.el.setAttribute("x1",l.s.x);l.el.setAttribute("y1",l.s.y);l.el.setAttribute("x2",l.t.x);l.el.setAttribute("y2",l.t.y);});
  const bad=overlapPairs(), act=nodes.filter(n=>n.kind!=="entity"||$("showEnt").checked);
  const nm=n=>n.p?.name||n.name||n.e.name;
  const hubsN=nodes.filter(n=>n.kind==="ae"), cw=hubsN.map(h=>({n:h.name,a:((Math.atan2(h.y-H/2,h.x-W/2)+Math.PI/2)*180/Math.PI+360)%360})).sort((x,y)=>x.a-y.a).map(x=>x.n.split(" ").pop()).join(">");
  const inLeg=act.filter(n=>{const x0=n.x-n.bw/2,x1=n.x+n.bw/2,y0=n.y+n.cy-n.bh/2,y1=n.y+n.cy+n.bh/2; return LEG&&x1>LEG.x0+10&&x0<LEG.x1-10&&y1>LEG.y0+10&&y0<LEG.y1-10;}).length;
  let cross=0; const crossNames=[]; links.forEach(l=>{ if(l.kind!=="ae") return; const hub=l.s.kind==="ae"?l.s:l.t, tip=l.s===hub?l.t:l.s, dx=tip.x-hub.x, dy=tip.y-hub.y, len2=dx*dx+dy*dy||1;
    act.forEach(n=>{ if(n===hub||n===tip||n.kind!=="prospect") return; const t=Math.max(0,Math.min(1,((n.x-hub.x)*dx+(n.y-hub.y)*dy)/len2)); if(Math.hypot(n.x-(hub.x+dx*t),n.y-(hub.y+dy*t))<n.r+2){ cross++; crossNames.push((hub.name.split(" ").pop())+"->"+(tip.p?.name||"?")+" thru "+n.p.name); } }); });
  const lens=links.filter(l=>l.kind==="ae").map(l=>({d:Math.hypot(l.s.x-l.t.x,l.s.y-l.t.y),n:(l.s.p||l.t.p).name})).sort((x,y)=>y.d-x.d);
  const lenInfo=`longest=${lens.slice(0,3).map(x=>x.n.slice(0,12)+":"+Math.round(x.d)).join(",")} avg=${Math.round(lens.reduce((s,x)=>s+x.d,0)/Math.max(1,lens.length))} inner=${nodes.filter(n=>n.inner&&n.home&&Math.hypot(n.x-W/2,n.y-H/2)<ringR()).length}`;
  const arcs=nodes.filter(n=>n.kind==="ae").sort((x,y)=>x.ai-y.ai).map(h=>h.name.split(" ").pop()+":"+Math.round(((h.th*180/Math.PI+90)+360)%360)+"deg/"+nodes.filter(n=>n.p&&n.p.owner===h.name).length).join(" ");
  document.title=`${lenInfo} hiddenLabels=${nodes.filter(n=>n.noLabel).length} fallbacks=${(window.__fb||[]).length}[${(window.__fb||[]).join(",")}] lineCrossings=${cross}[${crossNames.join("; ")}] legendHits=${inLeg} order=${cw} overlaps=${bad.length} worst=${Math.round(Math.max(0,...bad.map(b=>b[2])))} shakes=${shakes} alpha=${alpha.toFixed(2)} frames=${frame} nodes=${act.length} LS=${LS.toFixed(2)} W=${Math.round(W)} H=${Math.round(H)} ${bad.map(b=>nm(b[0])+"|"+nm(b[1])).join(" ; ")}`;
},Number(params.get("debug"))>1?Number(params.get("debug")):14000);
