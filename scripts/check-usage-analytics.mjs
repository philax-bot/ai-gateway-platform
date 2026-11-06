import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';

const require=createRequire(new URL('../apps/control-plane/package.json',import.meta.url));
const {aggregateUsage}=require('./dist/store/call-analytics.js');
const {queryPostgresUsage}=require('./dist/store/postgres-call-analytics.js');
const {queryMemoryCalls}=require('./dist/store/call-query.js');
const comparable=({collectedAt,...report})=>report;

/** Runs only against the generated PostgreSQL schema owned by check-web. */
export async function checkUsageAnalytics({database,schema,controlPlaneUrl:cp,seeded}){
  assert.match(schema,/^agp_web_[a-f0-9]{32}$/);
  let assertions=0;
  const check=(value,message)=>{assert.ok(value,message);assertions++;};
  async function request(path,body,cookie=''){
    const response=await fetch(`${cp}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(directoryId,password){const result=await request('/api/v1/auth/login',{directoryId,password});check(result.status===200&&result.cookie,'analytics login succeeds');return result.cookie;}
  const operator=await login('web-ops',seeded.adminPassword);
  async function command(type,payload){
    const input={type,payload,idempotencyKey:randomUUID()},preview=await request('/api/v1/platform/preview',input,operator);
    check(preview.status===200,`analytics preview ${type}`);
    const result=await request('/api/v1/platform/commands',{...input,previewToken:preview.body.previewToken},operator);
    check(result.status===200,`analytics command ${type}`);return result.body.result;
  }
  const password='Usage-check-member-2026!';
  const manager=await command('save.member',{name:'聚合项目经理',directoryId:'usage-manager',organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[],active:true,password});
  const state=(await request('/api/v1/platform/state',undefined,operator)).body;
  const range={poolId:state.pools[0].id,mode:'follow',definitionIds:[]};
  const project=await command('save.project',{name:'聚合受管项目',managerId:manager.id,range});
  const otherProject=await command('save.project',{name:'聚合其他项目',managerId:state.actor.id,range});
  const application=await command('save.application',{billingMode:'quota',name:'聚合经理应用',ownerId:manager.id,organizationId:'department-engineering',range});
  const managerCookie=await login('usage-manager',password),employeeCookie=await login('web-employee',seeded.employeePassword);
  const window={from:'2020-10-31T15:00:00.000Z',to:'2020-11-01T17:00:00.000Z'};
  let sequence=0;
  const call=(changes={})=>({requestId:`usage-integration-${++sequence}`,startedAt:'2020-10-31T15:00:00.000Z',completedAt:'2020-10-31T15:59:59.999Z',subjectType:'employee',subjectId:seeded.employeeId,credentialId:'usage-test-key',purpose:'personal',projectId:null,modelId:'test-model',organizationId:'department-engineering',outcome:'completed',inputTokens:10,outputTokens:20,cachedInputTokens:3,actualAmount:0.000001,billableState:'confirmed',reservationId:null,usageFinal:true,forwarded:true,...changes});
  const rows=[
    call({completedAt:window.from}),
    call({completedAt:'2020-10-31T16:00:00.000Z',purpose:'project',projectId:project.id,actualAmount:1.234567}),
    call({purpose:'project',projectId:otherProject.id,actualAmount:2}),
    call({purpose:'personal',actualAmount:99,admission:{kind:'configured',route:null,price:null,reservedAmount:0,attributionOrganizationId:'historical-department'}}),
    call({subjectId:manager.id,actualAmount:0.01}),
    call({subjectType:'application',subjectId:application.id,purpose:'application',actualAmount:0.2}),
    call({subjectType:'application',subjectId:'usage-unowned-app',purpose:'application',actualAmount:9}),
    call({subjectId:'usage-historical-person',organizationId:null,modelId:'historical-model',actualAmount:0.5}),
    call({purpose:'project',projectId:project.id,usageFinal:false,inputTokens:999999,outputTokens:999999,cachedInputTokens:999999,billableState:'pending_review',actualAmount:7,outcome:'partial'}),
    call({billableState:'pending_review',actualAmount:0,usageFinal:false,forwarded:null,outcome:'timeout'}),
    call({completedAt:'2020-11-01T16:00:00.000Z',actualAmount:0,billableState:'not_billable',forwarded:false,outcome:'rejected_before_upstream'}),
    call({outcome:'upstream_error',billableState:'not_billable',actualAmount:0}),
    call({completedAt:window.to,actualAmount:1000}),
    call({completedAt:'2020-10-31T14:59:59.999Z',actualAmount:1000}),
  ];
  const fields={request_id:'requestId',started_at:'startedAt',completed_at:'completedAt',subject_type:'subjectType',subject_id:'subjectId',credential_id:'credentialId',purpose:'purpose',project_id:'projectId',model_id:'modelId',organization_id:'organizationId',admission:'admission',outcome:'outcome',input_tokens:'inputTokens',output_tokens:'outputTokens',cached_input_tokens:'cachedInputTokens',actual_amount:'actualAmount',billable_state:'billableState',reservation_id:'reservationId',usage_final:'usageFinal',forwarded:'forwarded'};
  for(const row of rows)await database.query(`insert into "${schema}".call_logs(${Object.keys(fields).join(',')}) values(${Object.keys(fields).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(fields).map(key=>row[key]));
  const managerScope={employeeId:manager.id,applicationIds:[application.id],projectIds:[project.id]};
  const employeeScope={employeeId:seeded.employeeId,applicationIds:[]};
  const cases=[
    ['all',window,null,'Asia/Shanghai'],['manager',window,managerScope,'Asia/Shanghai'],['employee',window,employeeScope,'Asia/Shanghai'],
    ['organization snapshot',{...window,organizationId:'historical-department'},null,'Asia/Shanghai'],
    ['UTC days',window,null,'UTC'],['DST days',{from:'2020-10-31T00:00:00Z',to:'2020-11-02T00:00:00Z'},null,'America/New_York'],
    ['model',{...window,modelId:'test-model'},null,'Asia/Shanghai'],['organization',{...window,organizationId:'department-engineering'},managerScope,'Asia/Shanghai'],
    ['project purpose',{...window,purpose:'project'},managerScope,'Asia/Shanghai'],['application purpose',{...window,purpose:'application'},managerScope,'Asia/Shanghai'],
    ['empty',{...window,modelId:'does-not-exist'},null,'Asia/Shanghai'],
    ['month start',{to:'2020-11-01T17:00:00.000Z'},null,'Asia/Shanghai'],
  ];
  const client=await database.connect();
  try{
    await client.query('begin isolation level repeatable read read only');await client.query(`set local search_path="${schema}"`);
    for(const [label,query,scope,timezone] of cases){
      const sql=await queryPostgresUsage(client,query,scope,timezone),memory=aggregateUsage(rows,query,scope,timezone);
      assert.deepEqual(comparable(sql),comparable(memory),`SQL/memory parity: ${label}`);assertions++;
    }
    await client.query('commit');
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  for(const [label,cookie,scope] of [['operator',operator,null],['manager',managerCookie,managerScope],['employee',employeeCookie,employeeScope]]){
    const result=await request('/api/v1/platform/analytics/usage',window,cookie);
    check(result.status===200,`analytics HTTP ${label} succeeds`);
    assert.deepEqual(comparable(result.body),comparable(aggregateUsage(rows,window,scope,'Asia/Shanghai')),`HTTP authoritative scope: ${label}`);assertions++;
  }
  const expected=aggregateUsage(rows,window,null,'Asia/Shanghai');
  for(const extra of [{resultGroup:'errors'},{organizationId:'department-engineering',subjectType:'employee',resultGroup:'errors'},{organizationId:'historical-department'},{projectId:project.id,billableState:'pending_review'},{subjectId:application.id,subjectType:'application'}]){
    const query={...window,...extra},result=await request('/api/v1/platform/calls/query',query,operator),memory=queryMemoryCalls(rows,query,null);
    check(result.status===200,'drilldown call query succeeds');
    assert.deepEqual(result.body.summary,memory.summary,'PostgreSQL drilldown summary matches memory');assertions++;
    assert.deepEqual(result.body.items.map(row=>row.requestId),memory.items.map(row=>row.requestId),'PostgreSQL drilldown rows match memory');assertions++;
  }
  const privateCalls=await request('/api/v1/platform/calls/query',{...window,subjectId:seeded.employeeId},managerCookie);
  check(privateCalls.body.items.length===0,'manager record permissions remain unchanged by operator drilldown');
  check(expected.totals.requests===12,'from is inclusive and to is exclusive');
  check(expected.totals.unknownUsage===2&&expected.totals.pendingAmount===7,'unknown tokens and pending money stay separate');
  check(expected.days.some(row=>row.key==='2020-10-31')&&expected.days.some(row=>row.key==='2020-11-01')&&expected.days.some(row=>row.key==='2020-11-02'),'workspace days cross month and midnight');
  const managerReport=(await request('/api/v1/platform/analytics/usage',window,managerCookie)).body;
  check(managerReport.totals.requests===4,'manager sees own call, owned application and two managed-project calls only');
  check(managerReport.people.find(row=>row.key===seeded.employeeId)?.confirmedAmount===1.234567,'colleague personal spend and other projects are excluded');
  check((await request('/api/v1/platform/analytics/usage',window)).status===401,'anonymous analytics is denied');
  for(const query of [{...window,employeeId:seeded.employeeId},{from:'2020-01-01T00:00:00Z',to:window.to},{from:window.to,to:window.from}])check((await request('/api/v1/platform/analytics/usage',query,managerCookie)).status===400,'invalid queries and forged scope are rejected');
  await command('save.project',{id:project.id,name:project.name,managerId:manager.id,status:'paused'});
  const paused=(await request('/api/v1/platform/analytics/usage',window,managerCookie)).body;
  check(paused.totals.requests===2,'paused projects are removed from manager scope');
  await command('save.project',{id:project.id,name:project.name,managerId:manager.id,status:'active'});
  console.log(`PASS ${assertions} usage analytics SQL parity and HTTP permission assertions`);
  return {assertions,window,report:expected};
}
