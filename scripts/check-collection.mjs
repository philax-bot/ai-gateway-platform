import assert from 'node:assert/strict';
/** The caller owns the schema and restores the temporarily renamed statistics table. */
export async function checkCollection({admin,employeeCookie,request,state,command,withCollectionFailure}){
  let assertions=0;const check=(value,message)=>{assert.ok(value,message);assertions++;};
  check((await request('/api/v1/platform/monitoring/check',{},employeeCookie)).status===403,'employees cannot run a collection check');
  check((await request('/api/v1/platform/monitoring/check',{})).status===401,'collection checks require a session');
  const before=await state(admin);
  check((await request('/api/v1/platform/monitoring/check',{},admin)).body.collectionQuality==='collected','operator can check without invoking periodic grants');
  const after=await state(admin);check(after.revision===before.revision,'collection checks preserve signed business revision');
  check(JSON.stringify(after.quotaBatches)===JSON.stringify(before.quotaBatches)&&JSON.stringify(after.projectBudgets)===JSON.stringify(before.projectBudgets),'collection checks leave all balances unchanged');
  if(withCollectionFailure){
    let eventId;
    await withCollectionFailure(async()=>{
      const read=await request('/api/v1/platform/monitoring',null,admin);
      check(read.status===200&&read.body.quality==='collection_failed'&&read.body.rows.length===0,'real missing statistics table yields unknown data, not healthy zeroes');
      check(read.body.failedStages.includes('call_totals'),'failure identifies the safe statistics stage');
      const workspace=await request('/api/v1/platform/state',null,admin);
      check(workspace.status===200&&workspace.body.callDataQuality==='collection_failed'&&workspace.body.pendingReviewCount===null,'statistics failure keeps the workspace reachable with an explicitly unknown review count');
      check(JSON.stringify(workspace.body.quotaBatches)===JSON.stringify(before.quotaBatches),'statistics failure does not hide or rewrite authoritative quota balances');
      const checked=await request('/api/v1/platform/monitoring/check',{},admin);check(checked.status===200&&checked.body.collectionQuality==='collection_failed','explicit full check persists a real collection failure');
      const report=(await request('/api/v1/platform/monitoring',null,admin)).body,event=report.collectionEvents.find(e=>e.status==='active');eventId=event?.id;
      check(!!eventId&&!event.acknowledgedAt,'collection failure opens an independent unacknowledged event');
      check(!JSON.stringify(report).includes('does not exist')&&!JSON.stringify(report).includes('agp_check_'),'responses contain no database errors or schema names');
      check((await request('/api/v1/platform/commands',{type:'alert.ack',payload:{id:eventId},idempotencyKey:crypto.randomUUID()},employeeCookie)).status===403,'employee cannot acknowledge an operations event');
      await command(admin,'alert.ack',{id:eventId});
      const ack=(await request('/api/v1/platform/monitoring',null,admin)).body.collectionEvents.find(e=>e.id===eventId);
      check(!!ack.acknowledgedAt&&ack.status==='active'&&!ack.recoveredAt,'operator acknowledgement persists while the statistics table remains unavailable');
      await request('/api/v1/platform/monitoring/check',{},admin);
      check((await request('/api/v1/platform/monitoring',null,admin)).body.collectionEvents.filter(e=>e.status==='active').length===1,'repeated failed checks merge into one active collection event');
    });
    check((await request('/api/v1/platform/monitoring/check',{},admin)).body.collectionQuality==='collected','restoring the owned table makes the next full check succeed');
    const restored=(await request('/api/v1/platform/monitoring',null,admin)).body;
    check(restored.quality==='collected'&&restored.collectionEvents.some(e=>e.id===eventId&&e.status==='active'),'one successful check restores readings without falsely declaring the event recovered');
    const final=await state(admin);check(JSON.stringify(final.quotaBatches)===JSON.stringify(before.quotaBatches),'fault checks and acknowledgement do not issue or consume money');
  }
  console.log(`PASS ${assertions} collection-monitoring HTTP assertions`);return assertions;
}
