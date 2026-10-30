import assert from 'node:assert/strict';
import {captureDefaultState} from './business-checks.mjs';

// Read-only closeout, also usable when the browser runner was interrupted.
// Deliberately excludes credentials, key hashes, session hashes and member passwords.
export async function collectWebEvidence({root,db,session,browser,applicationCalls,before}){
  assert.match(session.schema,/^agp_hg_[a-f0-9]{32}$/);
  const table=name=>`"${session.schema}".${name}`;
  const payload=(await db.query(`select payload from ${table('platform_workspace')} where id='org-demo'`)).rows[0].payload;
  const rows=async sql=>(await db.query(sql)).rows;
  const employee=session.accounts.employee.id,owner=session.accounts.owner.id,manager=session.accounts.manager.id;
  const report={success:false,id:session.id,completedAt:new Date().toISOString(),scope:{database:'isolated PostgreSQL',dataPlane:'real Higress',model:'local deterministic fixture',realModelRequests:0},checks:[],browser};
  const check=(condition,label)=>{assert.ok(condition,label);report.checks.push(label);};
  const micro=value=>Math.round(Number(value)*1e6);
  const pick=(value,fields)=>Object.fromEntries(fields.map(k=>[k,value[k]]));
  report.approvals=payload.approvals;
  report.approvalHistory=payload.audit.filter(a=>a.action.startsWith('approval.'));
  report.keys=payload.keys.map(k=>pick(k,['id','name','masked','status','ownerId','purpose','subjectId','projectId','internal']));
  report.entitlements=payload.entitlements.map(e=>pick(e,['id','memberId','status','planId']));
  report.quotaBatches=await rows(`select id,purpose,source_id,project_id,source_batch_id,total_amount,available_amount,closed_amount from ${table('quota_batches')} order by id`);
  report.projectBudgets=await rows(`select id,project_id,total_amount,available_amount,closed_amount from ${table('project_budget_batches')} order by id`);
  report.calls=await rows(`select request_id,purpose,subject_id,project_id,billable_state,actual_amount,input_tokens,output_tokens,cached_input_tokens from ${table('call_logs')} order by started_at`);
  report.ledger=await rows(`select request_id,kind,amount from ${table('usage_ledger_entries')} order by created_at`);
  report.reservations=await rows(`select request_id,finalized from ${table('reservations')} order by created_at`);
  report.applicationCalls=applicationCalls;
  check(payload.services.every(s=>s.baseUrl==='http://model.poc.test:4010/v1'&&s.credentialRef==='UPSTREAM_PROVIDER_FIXTURE'),'all model services use only the owned fixture');
  check(browser.success&&browser.checks.length>=34&&browser.checks.every(c=>c.pass),'browser checks passed');
  for(const [kind,amount] of [['personal_open',.2],['project_member_quota',.1],['application_quota',.25]]){
    const approvals=report.approvals.filter(a=>a.kind===kind);
    check(approvals.length===1&&approvals[0].status==='effective'&&micro(approvals[0].approvedAmount)===micro(amount),kind+' has one effective approval');
    check(report.approvalHistory.filter(a=>a.objectId===approvals[0].id&&a.action==='approval.execute').length===1,kind+' executes once despite duplicate clicks');
  }
  const projectApproval=report.approvals.find(a=>a.kind==='project_member_quota');
  const history=report.approvalHistory.filter(a=>a.objectId===projectApproval.id);
  check(history.filter(a=>a.action==='approval.execution_failed').length===2,'two failed project attempts retained');
  const repair=history.find(a=>a.action==='approval.execution_repaired');
  check(repair?.detail.before.approvedAmount===1&&repair.detail.after.approvedAmount===.1&&projectApproval.amount===.2,'project repair preserves original request and failed approval');
  check(report.entitlements.some(e=>e.memberId===employee&&e.status==='active')&&!report.entitlements.some(e=>[owner,manager].includes(e.memberId)),'manager and application owner have no personal entitlement');
  const onlineKeys=report.keys.filter(k=>k.internal&&k.ownerId===employee);
  check(onlineKeys.length===2&&onlineKeys.every(k=>k.status==='revoked'),'both employee online identities revoked after browser logout');
  const expected=[['personal',employee,null,200000,199868],['project',employee,session.projectId,100000,99868],['application',session.applicationId,null,250000,249604]];
  for(const [purpose,subject,project,total,available] of expected){
    const matches=report.quotaBatches.filter(b=>b.purpose===purpose&&b.source_id===subject&&b.project_id===project);
    check(matches.length===1&&micro(matches[0].total_amount)===total&&micro(matches[0].available_amount)===available&&micro(matches[0].closed_amount)===0,purpose+' has one correctly settled quota batch');
  }
  const budgets=report.projectBudgets.filter(b=>b.project_id===session.projectId);
  check(budgets.length===1&&micro(budgets[0].total_amount)===500000&&micro(budgets[0].available_amount)===400000,'project funded once and allocates exactly 0.10');
  const projectBatch=report.quotaBatches.find(b=>b.purpose==='project'&&b.source_id===employee);
  check(projectBatch.source_batch_id===budgets[0].id,'project quota retains its budget source');
  check(report.calls.length===5&&['personal','project','application'].every((p,i)=>report.calls.filter(c=>c.purpose===p).length===[1,1,3][i]),'five calls have the expected personal/project/application attribution');
  check(report.calls.every(c=>c.subject_id===(c.purpose==='application'?session.applicationId:employee)&&c.project_id===(c.purpose==='project'?session.projectId:null)),'all call subject IDs and project IDs match the approved purposes');
  for(const call of report.calls){
    check(call.billable_state==='confirmed'&&micro(call.actual_amount)===132&&call.input_tokens===13&&call.output_tokens===14&&call.cached_input_tokens===4,call.request_id+' confirms fixture usage and price');
    const entries=report.ledger.filter(e=>e.request_id===call.request_id);
    check(entries.length===1&&entries[0].kind==='settlement'&&micro(entries[0].amount)===132,call.request_id+' settles exactly once');
    check(report.reservations.some(r=>r.request_id===call.request_id&&r.finalized),call.request_id+' reservation finalized');
  }
  check(report.ledger.length===5&&report.reservations.every(r=>r.finalized),'no extra ledger entries or open reservations');
  check(applicationCalls.length===4&&['active','disabled','restored','refresh'].every((label,i)=>applicationCalls[i].label===label),'application Key lifecycle and refresh were exercised in order');
  const disabled=applicationCalls.find(c=>c.label==='disabled');
  assert.deepEqual(disabled.after,disabled.before);
  check(disabled.httpStatus===401&&!report.calls.some(c=>c.request_id===disabled.requestId)&&!report.reservations.some(r=>r.request_id===disabled.requestId),'disabled Key returns 401 with no balance change, call or reservation');
  const after=await captureDefaultState({root,db});
  report.defaultPreservation={before,after};assert.deepEqual(after,before);
  check(true,'default configuration, funds, workspace state and live-model budget unchanged');
  report.totals={confirmedCalls:5,confirmedMicroCny:report.calls.reduce((sum,c)=>sum+micro(c.actual_amount),0),realModelRequests:0};
  report.success=true;return report;
}
