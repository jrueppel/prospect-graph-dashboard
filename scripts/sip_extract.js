// Run in the browser console (or via the browser tool) on https://phrase-sip.launchpad.phrase-internal.com/se/deals
// while signed in. Read-only: GET /api/se/deals, maps deals assigned to SE_NAME into prospects.json shape,
// then returns it as a JSON string (the Claude browser tool saves large results to a file; unwrap it with
// scripts/unwrap_tool_result.py into data/<user>/prospects.json). The page CSP blocks posting to localhost.
(async () => {
  // Whose deals: defaults to the signed-in SIP user; set window.SE_NAME first to pull someone else's.
  const SE_NAME = window.SE_NAME || (await fetch("/api/me").then(r => r.json())).displayName;
  const SF_STAGE = {"Discovery":"Discovery","Expansion Qualified":"Discovery","Solution Design / Demo (New)":"Evaluation",
    "Solution Design / Demo (Upsell)":"Evaluation","Proposal Evaluation":"Proposal","Negotiation (New)":"Negotiation","Negotiation (Upsell)":"Negotiation"};
  // SIP technicalOutcome -> won (gold) / lost (rust) / deferred. Note: "win" here is the SE technical outcome, not necessarily a signed contract.
  const OUTCOME = {"win":"won","Technical Win":"won","loss":"lost","Technical Loss":"lost","Deferred":"deferred","No Decision":"deferred"};
  const today = new Date(), strip = h => (h||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  const known = v => v && !/^(unknown|)$/i.test(v.trim());
  const MON = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  // Next-step notes start with a date ("10/5 - ...", "Sept 24: ..."): use it as a signal date if not in the future.
  const noteDate = t => {
    let m = t.match(/^\W*(\d{1,2})\/(\d{1,2})\b/), mo, d;
    if (m) { mo=+m[1]; d=+m[2]; }
    else if ((m = t.match(/^\W*([A-Za-z]{3})[a-z]*\.? (\d{1,2})\b/)) && MON[m[1].toLowerCase()]) { mo=MON[m[1].toLowerCase()]; d=+m[2]; }
    else return null;
    const dt = new Date(Date.UTC(today.getFullYear(), mo-1, d));
    return dt > today || isNaN(dt) ? null : dt.toISOString().slice(0,10);
  };
  const all = (await fetch("/api/se/deals").then(r => r.json())).deals;
  const mine = all.filter(d => d.seAssigneeName === SE_NAME && d.isActive && !d.closedAt && !d.rejectedAt);
  const prospects = mine.map(d => {
    const signals = [];
    if (d.stageUpdatedAt) signals.push({date:d.stageUpdatedAt.slice(0,10), source:"sip", summary:`SE stage: ${d.seStage}`});
    const nd = noteDate(d.sfNextSteps || "");
    if (nd) signals.push({date:nd, source:"salesforce", summary:(d.sfNextSteps||"").slice(0,200)});
    const entities = [{type:"person", name:`AE: ${d.ownerName}`}];
    (d.sfCompetitors||"").split(/[;,]/).map(s=>s.trim()).filter(s=>known(s)&&!/^none$/i.test(s))
      .forEach(c => entities.push({type:"competitor", name:c}));
    if (d.sfIndustry) entities.push({type:"industry", name:d.sfIndustry});
    return {
      id:d.sfOpportunityId, name:d.accountName, deal:d.name, amount:d.amount, stage:SF_STAGE[d.sfStageName]||"Discovery",
      stage_label:`${d.sfStageName} / SE: ${d.seStage}`, se_stage:d.seStage, close_date:d.closeDate, owner:d.ownerName, url:d.sfOpportunityUrl,
      rfp:d.rfpStage||null, outcome:OUTCOME[d.technicalOutcome]||null, outcome_note:(d.technicalOutcomeNotes||"").slice(0,300), outcome_date:(d.technicalCloseAt||"").slice(0,10)||null, next_step:(d.sfNextSteps||"").slice(0,300),
      // SIP has no champion / economic buyer / budget fields: left false (unknown) until enriched from Fellow/Gmail.
      qual:{champion:false, economic_buyer:false, budget:false,
        pain: !!(strip(d.customerObjectives)||strip(d.sfWhyChange)),
        timeline: !!(strip(d.compellingEvent)||strip(d.sfWhyNow)),
        competitor: known(d.sfCompetitors),
        next_step: !!(d.sfNextSteps||"").trim()},
      entities, signals };
  });
  return JSON.stringify({generated: today.toISOString().slice(0,10), currency:"€", source:"SIP /api/se/deals", sip_url: location.origin + "/se/deals", prospects});
})()
