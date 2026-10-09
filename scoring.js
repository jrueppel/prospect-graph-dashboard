// Scoring model. All tunable numbers live here.
const STAGE_PROB = {"Qualification":.05,"Discovery":.10,"Evaluation":.25,"Proposal":.45,"Negotiation":.70,"Closed Won Pending":.95};
const QUAL_WEIGHTS = {champion:2,economic_buyer:2,pain:1.5,budget:1.5,timeline:1,competitor:.5,next_step:1.5};
const DAY = 86400000;

function daysSince(dateStr, now){ return Math.max(0,(now - new Date(dateStr))/DAY); }

function scoreProspect(p, now, maxAmount){
  // Value: sqrt-scaled so a $900k deal isn't 15x a $60k one
  const value = Math.sqrt(p.amount/maxAmount);
  // Information: weighted qualification completeness (do we know enough to trust the forecast?)
  const tw = Object.values(QUAL_WEIGHTS).reduce((a,b)=>a+b,0);
  const info = Object.entries(QUAL_WEIGHTS).reduce((s,[k,w])=>s+(p.qual[k]?w:0),0)/tw;
  // Close confidence: stage probability blended with information completeness
  let confidence = .55*(STAGE_PROB[p.stage]??.1) + .45*info;
  if(p.outcome==='won') confidence = p.signed ? 1 : Math.max(confidence,.75); else if(p.outcome==='lost') confidence = 0;  // decided deals: certainty replaces the estimate
  // Importance 0-100: value matters, but only to the extent we believe it can close
  const importance = Math.round(100*value*(.3+.7*confidence));
  // Activity 0-1: recency decay (21-day half-ish life) + volume of signals in last 30d
  const days = p.signals.length ? Math.min(...p.signals.map(s=>daysSince(s.date,now))) : 999;
  const n30 = p.signals.filter(s=>daysSince(s.date,now)<=30).length;
  const activity = .7*Math.exp(-days/21) + .3*Math.min(1,n30/4);
  return {value,info,confidence,importance,activity,daysSinceLast:days,signals30:n30,
          expected:Math.round(p.amount*confidence)};
}

// Blue -> Green -> Orange
const STOPS = [[0,[59,130,246]],[.5,[34,197,94]],[1,[249,115,22]]];
function activityColor(a){
  a = Math.max(0,Math.min(1,a));
  for(let i=1;i<STOPS.length;i++){
    if(a<=STOPS[i][0]){
      const [a0,c0]=STOPS[i-1],[a1,c1]=STOPS[i],t=(a-a0)/(a1-a0);
      return `rgb(${c0.map((v,j)=>Math.round(v+(c1[j]-v)*t)).join(',')})`;
    }
  }
}

// Decided deals override the activity gradient.
// won + signed (Salesforce Closed Won) = gold; won but unsigned (SE technical win only) = pale gold; lost = rust
const OUTCOME_COLOR = {won:"#e0a800", techwin:"#f3e3a6", lost:"#b7410e"};
function outcomeKey(p){ return p.outcome==="won" && !p.signed ? "techwin" : p.outcome; }
function nodeColor(p, s){ return OUTCOME_COLOR[outcomeKey(p)] || activityColor(s.activity); }
