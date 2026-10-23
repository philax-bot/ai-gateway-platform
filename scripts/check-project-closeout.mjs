import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
export async function checkProjectCloseout({cp,admin,employeeCookie,managerCookie,employee,manager,request,state,command,start,freePort,runtimeDirectory}){
  let assertions=0;const check=(v,message)=>{assert.ok(v,message);assertions++;},held=new Map();
  const usage={prompt_tokens:13,completion_tokens:14,total_tokens:27};
  // Explicit response gate keeps the request in flight across a real database closeout transaction.
  const model=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');res.setHeader('content-type',body.stream?'text/event-stream':'application/json');
    if(body.stream){res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n');held.set(req.headers['x-request-id'],res);}
    else res.end(JSON.stringify({choices:[{message:{content:'连接通过'}}],usage}));
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  try{
    const initial=await state(admin),service=(await command(admin,'save.service',{name:'关闭事务隔离服务',baseUrl:`http://127.0.0.1:${model.address().port}`,active:true,mappings:[{definitionId:initial.definitions[0].id,upstreamModel:'closeout-model',inputPrice:2,outputPrice:3,cachedInputPrice:0.5}]})).result;
    const verification=await request(`/api/v1/platform/services/${service.id}/verify`,{},admin);check(verification.body.verification==='passed','closeout model stand-in verified through local HTTP');
    const pool=(await command(admin,'save.pool',{name:'关闭事务隔离池',entries:[{definitionId:initial.definitions[0].id,serviceId:service.id,open:true}]})).result;
    const project=(await command(admin,'save.project',{name:'关闭验收项目',managerId:manager.id,range:{poolId:pool.id,mode:'follow',definitionIds:[]}})).result;
    check((await request(`/api/v1/platform/projects/${project.id}/member-candidates`,null,employeeCookie)).status===403,'ordinary member cannot discover candidate directory');
    const candidates=await request(`/api/v1/platform/projects/${project.id}/member-candidates`,null,managerCookie);check(candidates.status===200&&candidates.body.some(m=>m.id===employee.id)&&candidates.body.every(m=>!('directoryId' in m)&&!('roles' in m)),'manager receives minimal active directory candidates');
    await command(managerCookie,'project.members',{projectId:project.id,memberIds:[employee.id]});const expiresAt=new Date(Date.now()+7*86400000).toISOString();
    const budget=(await command(admin,'project.fund',{projectId:project.id,amount:20,expiresAt})).result;
    const allocation=(await command(managerCookie,'project.allocate',{projectId:project.id,sourceBatchId:budget.id,memberId:employee.id,amount:8})).result;
    const key=(await command(employeeCookie,'key.issue',{name:'关闭验收凭据',purpose:'project',projectId:project.id})).result;
    const port=await freePort(),gw=`http://127.0.0.1:${port}`;start('services/gateway-sim/dist/server.js',{PORT:String(port),CONTROL_PLANE_URL:cp,SERVICE_TOKEN:'local-service-token',UPSTREAM_TIMEOUT_MS:'30000',GATEWAY_JOURNAL_DIR:resolve(runtimeDirectory,'project-closeout-gateway')});
    for(let i=0;i<100;i++){try{if((await fetch(`${gw}/health`)).ok)break;}catch{}if(i===99)throw new Error('closeout gateway did not start');await new Promise(r=>setTimeout(r,50));}
    const id=`project-close-${randomUUID()}`,response=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json','x-request-id':id},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'关闭前准入'}],max_tokens:32,stream:true})});
    const reader=response.body.getReader();await reader.read();check(response.status===200&&held.has(id),'request is forwarded and explicitly held before final usage');
    const own=await request(`/api/v1/platform/projects/${project.id}`,null,employeeCookie);check(own.status===200&&own.body.budgets.length===0&&own.body.members.length===1&&own.body.members[0].id===employee.id,'ordinary member sees only own finance');
    const closed=(await command(managerCookie,'project.end',{projectId:project.id,reason:'开发隔离结束验收'})).result;
    check(closed.project.status==='ended'&&closed.budgetAmount===12&&closed.memberAmount<8,'closeout retires unused money while retaining the exact in-flight hold');
    const frozen=await request(`/api/v1/platform/projects/${project.id}`,null,managerCookie);check(frozen.body.budgets.every(b=>b.availableAmount===0&&b.closedAt)&&frozen.body.members.flatMap(m=>m.batches).every(b=>b.availableAmount===0&&b.closedAt),'source budget and member batches are atomically closed');
    held.get(id).end(`data: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`);held.delete(id);while(!(await reader.read()).done){};
    const after=await request(`/api/v1/platform/projects/${project.id}`,null,managerCookie),memberBatch=after.body.members.flatMap(m=>m.batches).find(b=>b.id===allocation.id),spent=after.body.consumedByBatch[allocation.id];
    check(spent>0&&memberBatch.availableAmount===0&&Math.abs(memberBatch.closedAmount+spent-8)<1e-8,'late final usage adjusts closeout money without reopening spendable balance');
    check(Math.abs(after.body.budgets[0].closedAmount+memberBatch.closedAmount+spent-20)<1e-8,'project funding equals closed money plus confirmed spending after settlement');
    const blocked=await fetch(`${gw}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json'},body:JSON.stringify({model:'test-model',messages:[]})});await blocked.text();check(blocked.status!==200,'closed project key cannot authorize new traffic');
    await command(managerCookie,'project.end',{projectId:project.id,reason:'重复结束不重复回收'});const again=await request(`/api/v1/platform/projects/${project.id}`,null,managerCookie);check(again.body.members.flatMap(m=>m.batches).find(b=>b.id===allocation.id).closedAmount===memberBatch.closedAmount,'repeat closeout leaves funds unchanged');
    check(again.body.history.some(h=>h.action==='project.closed')&&again.body.history.some(h=>h.action==='project.allocate'),'project history links funding/allocation and closeout');
  }finally{for(const response of held.values())response.destroy();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
  console.log(`PASS ${assertions} project closeout HTTP assertions (in-flight gate, finance scope, original-source settlement)`);return assertions;
}
