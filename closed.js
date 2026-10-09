// Closed-deals view: closed-won ARR stats and a smooth, per-quarter-coloured area chart.
// Data: decided deals from the SIP feed (signed wins, technical losses) + data/<user>/closed_history.json
// (closed-won ARR from the #winwire Salesforce Bot posts, which carry the real booked ARR and close date).
let closedHistory=[], closedPeriod="4q";
const QCOL={1:"#38bdf8",2:"#34d399",3:"#fbbf24",4:"#f472b6"};      // one colour per calendar quarter (Q1..Q4), same every year
const DAYMS=864e5;
const isoDay=d=>d.toISOString().slice(0,10);
const qDate=(y,q)=>new Date(Date.UTC(y,(q-1)*3,1));
const moneyC=n=>n>=1e6?`${CUR}${(n/1e6).toFixed(2)}M`:n>=1e4?`${CUR}${Math.round(n/1e3)}k`:n>=1e3?`${CUR}${(n/1e3).toFixed(1)}k`:`${CUR}${Math.round(n)}`;

function closedDate(p){ return (p.outcome==="won"?(p.signed_date||p.close_date):(p.outcome_date||p.close_date))||""; }

// Closed pool as {p,s} items: SIP decided deals, with ARR/date from #winwire where known, plus history-only deals.
function closedPool(){
  const hist=new Map(closedHistory.map(h=>[h.id,h]));
  const isDec=x=>x.p.outcome==="lost"||(x.p.outcome==="won"&&x.p.signed);
  const out=[], seen=new Set();
  allScored.filter(isDec).forEach(x=>{
    const h=hist.get(x.p.id); seen.add(x.p.id);
    if(!h){ out.push(x); return; }
    const p={...x.p,amount:h.amount,close_date:h.date,arr:true};                // keep the rich SIP record, use booked ARR + close date
    out.push({p,s:scoreProspect(p,NOW,MAXAMT)});
  });
  closedHistory.filter(h=>!seen.has(h.id)).forEach(h=>{
    const p={id:h.id,name:h.name,deal:h.name,owner:h.owner||"Unknown AE",amount:h.amount,stage:"Closed",stage_label:`Closed ${h.outcome} (${h.type||"new"})`,
      close_date:h.date,outcome:h.outcome,outcome_date:h.date,outcome_note:"",signed:h.outcome==="won",qual:{},entities:[],signals:[],baseSignals:[],summary:null,history:true,arr:true};
    out.push({p,s:scoreProspect(p,NOW,MAXAMT)});
  });
  return out.sort((a,b)=>closedDate(b.p).localeCompare(closedDate(a.p)));
}

// A period is a run of consecutive calendar quarters.
function rangeFor(period,today){
  const qi=today.getUTCFullYear()*4+Math.floor(today.getUTCMonth()/3);
  const cfg={"2q":[qi-1,2],"4q":[qi-3,4],"8q":[qi-7,8],"ytd":[today.getUTCFullYear()*4,4],"py":[(today.getUTCFullYear()-1)*4,4]}[period]||[qi-3,4];
  const quarters=[]; for(let k=0;k<cfg[1];k++){ const idx=cfg[0]+k, y=Math.floor(idx/4), q=idx%4+1; quarters.push({y,q,start:qDate(y,q),end:qDate(q===4?y+1:y,q===4?1:q+1)}); }
  const label={"2q":"last 2 quarters","4q":"last 4 quarters","8q":"last 8 quarters","ytd":`${today.getUTCFullYear()} (calendar year)`,"py":`${today.getUTCFullYear()-1} (calendar year)`}[period]||"";
  return {quarters,start:quarters[0].start,end:quarters[quarters.length-1].end,label};
}

function renderClosedPane(){
  const pane=$("closedPane"); if(!pane) return;
  const today=new Date(), range=rangeFor(closedPeriod,today), a=isoDay(range.start), b=isoDay(range.end);
  const items=scored.filter(x=>{ const d=closedDate(x.p); return d>=a&&d<b; });
  const wins=items.filter(x=>x.p.outcome==="won"), losses=items.filter(x=>x.p.outcome==="lost");
  const sum=arr=>arr.reduce((t,x)=>t+x.p.amount,0), won=sum(wins), n=wins.length, nl=losses.length;
  pane.innerHTML=`<div class="cp-head"><div class="cp-title">Closed-won ARR <span>cumulative · ${range.label}</span></div>
    <div class="cp-stats"><span class="cp-stat">Won in period <b>${moneyC(won)}</b> · ${n} deal${n===1?"":"s"}</span>
      <span class="cp-stat">Avg deal <b>${n?moneyC(won/n):"–"}</b></span>
      <span class="cp-stat">Technical losses <b>${nl}</b>${nl?` · ${moneyC(sum(losses))}`:""}</span></div>
    <select id="cpPeriod"><option value="4q">Last 4 quarters</option><option value="2q">Last 2 quarters</option><option value="8q">Last 8 quarters</option><option value="ytd">This calendar year</option><option value="py">Last calendar year</option></select></div>
    <div id="cpChart"></div>`;
  $("cpPeriod").value=closedPeriod; $("cpPeriod").onchange=e=>{ closedPeriod=e.target.value; renderClosedPane(); };
  drawArea($("cpChart"),range,wins,losses,today);
}

function drawArea(box,range,wins,losses,today){
  const w=box.clientWidth||700, h=box.clientHeight||200, ml=54, mr=16, mt=8, mb=40, pw=Math.max(50,w-ml-mr), ph=Math.max(40,h-mt-mb);
  const t0=range.start.getTime(), t1=range.end.getTime(), X=t=>ml+(t-t0)/(t1-t0)*pw, tNow=today.getTime(), tEnd=Math.min(t1,tNow);
  const deals=wins.map(x=>({t:new Date(closedDate(x.p)+"T12:00:00Z").getTime(),a:x.p.amount,x}));
  const ramp=12*DAYMS;                                                        // each deal ramps in over the ~12 days up to its close date -> a smooth S-curve, not a staircase
  const S=t=>deals.reduce((s,d)=>{ const u=Math.min(1,Math.max(0,(t-(d.t-ramp))/ramp)); return s+d.a*u*u*(3-2*u); },0);
  const NS=Math.max(2,Math.min(800,Math.ceil((tEnd-t0)/DAYMS)));
  const pts=[]; if(tEnd>t0) for(let i=0;i<=NS;i++){ const t=t0+(tEnd-t0)*i/NS; pts.push([t,S(t)]); }
  const total=pts.length?pts[pts.length-1][1]:0;
  const stepNice=v=>{ const p=Math.pow(10,Math.floor(Math.log10(v||1))), f=v/p; return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p; };
  const ystep=stepNice(Math.max(total*1.08,1000)/5), ymax=ystep*5, Y=v=>mt+ph-(v/ymax)*ph;
  const f=n=>n.toFixed(1);
  let svg=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs>`;
  range.quarters.forEach((q,k)=>{ const c=QCOL[q.q];
    svg+=`<clipPath id="cq${k}"><rect x="${f(X(q.start.getTime()))}" y="0" width="${f(X(q.end.getTime())-X(q.start.getTime()))}" height="${h}"/></clipPath>
      <linearGradient id="gq${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".85"/><stop offset="1" stop-color="${c}" stop-opacity=".12"/></linearGradient>`; });
  svg+=`</defs>`;
  for(let v=0;v<=ymax+1;v+=ystep) svg+=`<line x1="${ml}" x2="${ml+pw}" y1="${f(Y(v))}" y2="${f(Y(v))}" stroke="#263149" stroke-width="1"/><text x="${ml-8}" y="${f(Y(v)+4)}" text-anchor="end">${v===0?"0":moneyC(v)}</text>`;
  if(pts.length>1){
    const line=pts.map(p=>`${f(X(p[0]))},${f(Y(p[1]))}`).join(" L");
    const area=`M${f(X(pts[0][0]))},${f(Y(0))} L${line} L${f(X(pts[pts.length-1][0]))},${f(Y(0))} Z`;
    range.quarters.forEach((q,k)=>{ const c=QCOL[q.q];
      svg+=`<g clip-path="url(#cq${k})"><path d="${area}" fill="url(#gq${k})"/><path d="M${line}" fill="none" stroke="${c}" stroke-width="2.6" stroke-linejoin="round"/></g>`; });
  } else svg+=`<text x="${ml+pw/2}" y="${mt+ph/2}" text-anchor="middle">No closed-won deals in this period</text>`;
  // quarter bands: separators, name, ARR added in the quarter
  range.quarters.forEach((q,k)=>{
    const xs=X(q.start.getTime()), xe=X(q.end.getTime()), c=QCOL[q.q];
    const added=deals.filter(d=>d.t>=q.start.getTime()&&d.t<q.end.getTime()).reduce((s,d)=>s+d.a,0);
    if(k>0) svg+=`<line x1="${f(xs)}" x2="${f(xs)}" y1="${mt}" y2="${mt+ph}" stroke="#334155" stroke-dasharray="3 4"/>`;
    svg+=`<rect x="${f(xs+4)}" y="${mt+ph+22}" width="9" height="9" rx="2" fill="${c}"/><text class="qlab" x="${f(xs+17)}" y="${mt+ph+31}">Q${q.q} ${q.y}</text><text x="${f(xs+17+60)}" y="${mt+ph+31}" fill="#cbd5e1">${added>0?"+"+moneyC(added):"–"}</text>`;
  });
  // month ticks
  for(let d=new Date(range.start);d<range.end;d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1))){
    const x=X(d.getTime()), nm=d.toLocaleDateString("en-US",{month:"short",timeZone:"UTC"});
    svg+=`<line x1="${f(x)}" x2="${f(x)}" y1="${mt+ph}" y2="${mt+ph+4}" stroke="#475569"/>`;
    if(pw/(range.quarters.length*3)>34) svg+=`<text x="${f(x+(X(d.getTime()+30*DAYMS)-x)/2)}" y="${mt+ph+16}" text-anchor="middle">${nm}</text>`;
  }
  if(tNow>=t0&&tNow<t1) svg+=`<line x1="${f(X(tNow))}" x2="${f(X(tNow))}" y1="${mt}" y2="${mt+ph}" stroke="#e2e8f0" stroke-dasharray="2 3" opacity=".7"/><text x="${f(X(tNow)-4)}" y="${mt+10}" text-anchor="end" style="fill:#e2e8f0">today</text>`;
  deals.forEach(d=>{ const x=X(d.t), y=Y(S(d.t)); const p=d.x.p;
    svg+=`<g class="cp-dot" data-id="${esc(p.id)}" style="cursor:pointer"><circle cx="${f(x)}" cy="${f(y)}" r="5" fill="#0f1420" stroke="#e0a800" stroke-width="2.2"/><title>${esc(p.name)} · ${esc(p.owner||"")} · ${moneyC(p.amount)} ARR · ${closedDate(p)}</title></g>`; });
  losses.forEach(x=>{ const d=new Date(closedDate(x.p)+"T12:00:00Z").getTime(), cx=X(d), cy=Y(0);
    svg+=`<g class="cp-dot" data-id="${esc(x.p.id)}" style="cursor:pointer"><path d="M${f(cx)},${f(cy-7)} l6,7 l-6,7 l-6,-7 z" fill="#b7410e" stroke="#0f1420"/><title>Technical loss: ${esc(x.p.name)} · ${esc(x.p.owner||"")} · ${moneyC(x.p.amount)} · ${closedDate(x.p)}</title></g>`; });
  svg+=`</svg>`;
  box.innerHTML=svg;
  box.querySelectorAll(".cp-dot").forEach(g=>g.onclick=()=>{ if(nodes.some(n=>n.id===g.dataset.id)) select(g.dataset.id); });
}
addEventListener("resize",()=>{ if(typeof viewMode!=="undefined"&&viewMode==="closed") renderClosedPane(); });
