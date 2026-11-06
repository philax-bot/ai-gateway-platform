import {randomUUID} from 'node:crypto';

/** Additive, repeatable business demo. All traffic goes to the repository's local model. */
export async function prepareBusinessDemo({controlPlaneUrl:cp,gatewayUrl,modelUrl,workspaceId,createdAt,round='1',operatorLogin='review-ops',operatorPassword='Review-local-2026!',afterResources=async()=>{}}){
  if(!/^\d{1,3}$/.test(round))throw new Error('Demo round must be an integer from 0 to 999');
  for(const value of [cp,gatewayUrl,modelUrl])if(!['localhost','127.0.0.1'].includes(new URL(value).hostname))throw new Error('Business demo requires loopback services');
  const password='Demo-local-2026!',prefix=`business-demo-v1-${workspaceId}`;
  let cookie='';
  async function api(path,body){
    const response=await fetch(`${cp}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(`Demo ${path}: ${result.message??response.status}`),{status:response.status});return result;
  }
  const login=(directoryId,secret=password)=>api('/api/v1/auth/login',{directoryId,password:secret});
  async function command(step,type,payload){
    const input={type,payload,idempotencyKey:`${prefix}-${step}`};
    try{return (await api('/api/v1/platform/commands',input)).result;}catch(error){if(error.status!==409)throw error;}
    const preview=await api('/api/v1/platform/preview',input);return (await api('/api/v1/platform/commands',{...input,previewToken:preview.previewToken})).result;
  }
  await login(operatorLogin,operatorPassword);
  const initial=await api('/api/v1/platform/state');
  if(!initial.actor.roles.includes('operator'))throw new Error('Demo preparation requires an operator');
  const expiresAt=new Date(Date.parse(createdAt)+365*86400000).toISOString();
  const organizations=[];
  for(const [key,name] of [['engineering','演示·研发中心'],['business','演示·业务中心']])organizations.push(await command(`org-${key}`,'save.organization',{name,parentId:'org-demo',active:true}));
  const members={};
  for(const [key,name,organization,roles] of [
    ['ops','演示运营',0,['operator','employee']],['manager','演示项目经理',0,['employee']],
    ['lin','林工（演示）',0,['employee']],['chen','陈工（演示）',1,['employee']],
    ['app','演示应用负责人',1,['employee']],['new','待开通同事（演示）',1,['employee']],
  ])members[key]=await command(`member-${key}`,'save.member',{name,directoryId:`demo-${key}`,organizationId:organizations[organization].id,category:'employee',roles,tags:['内部演示'],active:true,password});
  // Existing enterprise rules can automatically grant every new member. Remove
  // only automatic personal rights of this newly created demo application owner;
  // keep the enterprise rule and all original accounts/batches intact.
  const memberState=await api('/api/v1/platform/state');
  for(const entitlement of memberState.entitlements.filter(entry=>entry.memberId===members.app.id&&entry.source==='automatic'&&entry.status==='active'))await command(`app-no-personal-${entitlement.id}`,'entitlement.revoke',{id:entitlement.id,reason:'内部演示专用应用负责人：验证无个人权益也可使用应用独立额度；保留原批次与历史记录'});
  const definitions=[];
  for(const [key,name] of [['chat','演示·通用助手'],['reason','演示·分析助手']])definitions.push(await command(`model-${key}`,'save.definition',{name,modelId:`demo-${key}`,contextTokens:32768,description:'内部演示：本地确定性模型替身，不执行真实模型推理',active:true}));
  const service=await command('service','save.service',{name:'演示·本地模型服务',baseUrl:`${modelUrl.replace(/\/$/,'')}/v1`,credentialRef:null,active:true,limits:{mode:'inherit'},mappings:definitions.map(definition=>({definitionId:definition.id,upstreamModel:'test-model',inputPrice:100,outputPrice:200,cachedInputPrice:50,limits:{mode:'inherit'}}))});
  await api(`/api/v1/platform/services/${service.id}/verify`,{idempotencyKey:`${prefix}-verify`});
  const pool=await command('pool','save.pool',{name:'演示·本地模型池',entries:definitions.map(definition=>({definitionId:definition.id,serviceId:service.id,open:true})),limits:{mode:'inherit'}});
  const range={poolId:pool.id,mode:'follow',definitionIds:[]};
  const plan=await command('plan','save.plan',{name:'演示·办公体验方案',range,amount:50,cadence:'once',quotaDays:365,entitlementDays:365});
  await command('open','distribution.execute',{operation:'open_plan',planId:plan.id,memberIds:[members.lin.id,members.chen.id]});
  const projects=[];
  for(const [index,name,staff] of [[0,'演示·知识助手试点',['lin','chen']],[1,'演示·业务应用集成',['chen']]]){
    const project=await command(`project-${index}`,'save.project',{name,description:'内部演示数据：预算、调用和核对均使用本地模型替身',managerId:members.manager.id,range});
    await command(`project-members-${index}`,'project.members',{projectId:project.id,memberIds:staff.map(key=>members[key].id)});
    const budget=await command(`budget-${index}`,'project.fund',{projectId:project.id,amount:100,expiresAt});
    for(const key of staff)await command(`allocate-${index}-${key}`,'project.allocate',{projectId:project.id,memberId:members[key].id,sourceBatchId:budget.id,amount:20});
    projects.push(project);
  }
  const applications=[];
  for(const [index,name] of [[0,'演示·工单归纳助手'],[1,'演示·知识检索 API']]){
    const application=await command(`app-${index}`,'save.application',{billingMode:'quota',name,ownerId:members.app.id,organizationId:organizations[1].id,range});
    await command(`app-fund-${index}`,'application.fund',{applicationId:application.id,amount:50,expiresAt});applications.push(application);
  }
  await afterResources();
  const day=new Date().toISOString().slice(0,10),requestIds=[];
  const batches=[
    ['lin','personal',null,'demo-chat',5],['chen','personal',null,'demo-reason',3],
    ['lin','project',projects[0].id,'demo-reason',3],['chen','project',projects[0].id,'demo-chat',2],
    ['chen','project',projects[1].id,'demo-reason',2],['app','application',applications[0].id,'demo-chat',4],['app','application',applications[1].id,'demo-reason',2],
  ];
  const record=async(id,token,model,scenario)=>{
    const response=await fetch(`${gatewayUrl}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,'x-request-id':id,'idempotency-key':id},body:JSON.stringify({model,messages:[{role:'user',content:'内部演示：请归纳这段示例工单，仅使用本地模型替身。'}],max_tokens:64,stream:scenario==='incomplete',...(scenario?{test_scenario:scenario}:{})}),signal:AbortSignal.timeout(30000)});
    await response.text();if(!response.ok&&scenario!=='error')throw new Error(`Demo gateway call failed: HTTP ${response.status}`);
  };
  for(const [index,[memberKey,purpose,source,model,count]] of batches.entries()){
    await login(operatorLogin,operatorPassword);
    const ids=Array.from({length:count+((index===2)?2:(index===5)?1:0)},(_,i)=>`${prefix}-${day}-r${round}-${index}-${i}`);
    const missing=[];
    for(const id of ids){const page=await api('/api/v1/platform/calls/query',{requestId:id,limit:1});if(!page.items.length)missing.push(id);requestIds.push(id);}
    if(!missing.length)continue;
    // A fresh temporary seed key is revoked when its calls finish. No plaintext
    // key is written to the demo manifest or retained for later demonstrations.
    const issued=await command(`key-${day}-${index}-${randomUUID()}`,'key.issue',{name:'演示数据准备临时密钥',purpose,...(purpose==='application'?{applicationId:source}:{memberId:members[memberKey].id,...(source?{projectId:source}:{})})});
    try{for(const id of missing){const number=ids.indexOf(id),scenario=number>=count?(index===2?'incomplete':'error'):undefined;await record(id,issued.secret,model,scenario);}}
    finally{await command(`revoke-${issued.key.id}`,'key.status',{id:issued.key.id,status:'revoked',reason:'本地演示数据准备结束，吊销临时密钥'});}
  }
  await login(operatorLogin,operatorPassword);
  const report=await api('/api/v1/platform/analytics/usage',{modelId:'demo-reason'});
  console.log(`Business demo ready: ${requestIds.length} local call records; dedicated accounts and resources preserved on restart.`);
  return {version:1,round,preparedAt:new Date().toISOString(),modelInference:false,accounts:Object.keys(members).map(key=>({login:`demo-${key}`,name:members[key].name})),organizations:organizations.map(row=>row.id),projects:projects.map(row=>row.id),applications:applications.map(row=>row.id),models:definitions.map(row=>row.modelId),planId:plan.id,requestIds,pendingReview:report.totals.pendingReview};
}
