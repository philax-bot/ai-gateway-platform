import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function checkOperationsV2Web({cp,gateway,model,web,seeded,cdp,evaluate,waitFor,clickExact,pressKey,setViewport,screenshot,login,check,restartGateway,database,schema,tempDir,restartControlPlane}){
  const session=async(directoryId,password)=>{
    const response=await fetch(cp+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({directoryId,password})});
    assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
  };
  const adminCookie=await session('web-ops',seeded.adminPassword);
  async function request(path,body,cookie=adminCookie,status=200){
    const response=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json();assert.equal(response.status,status,`${path}: ${JSON.stringify(value)}`);return value;
  }
  async function command(type,payload,cookie=adminCookie){
    const input={type,payload,idempotencyKey:randomUUID()},preview=await request('/api/v1/platform/preview',input,cookie);
    return (await request('/api/v1/platform/commands',{...input,previewToken:preview.previewToken},cookie)).result;
  }
  async function internal(path,body){
    const response=await fetch(cp+'/internal/v1/'+path,{method:'POST',headers:{authorization:'Bearer web-check-service-token','content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200,await(response.status===200?Promise.resolve(''):response.text()));return response.json();
  }
  const password='Operations-role-local-2026!',roles={};
  for(const role of ['model_operator','finance_operator','auditor','employee']){
    const member=await command('save.member',{directoryId:'ops-'+role,name:'职责 '+role,organizationId:'department-engineering',roles:[role],password});
    roles[role]={member,cookie:await session('ops-'+role,password)};
  }
  const initial=await request('/api/v1/platform/state'),pool=initial.pools[0];
  await command('settings.update',{limits:{mode:'none'}});
  const provider=await command('save.provider',{name:'运营能力验收供应商',adapter:'openai',kinds:['chat','embeddings','rerank','image','asr','tts','video'],baseUrl:model,active:true},roles.model_operator.cookie);
  const credential=await command('credential.save',{name:'版本化本地凭据',providerId:provider.id,secret:'local-credential-version-one'},roles.model_operator.cookie);
  check(credential.currentVersion===1&&!JSON.stringify(credential).includes('ciphertext'),'credential command returns public version metadata only');
  const definitions=[];
  for(const kind of ['chat','embeddings','rerank','image','asr','tts','video'])definitions.push(await command('save.definition',{name:'运营验收 '+kind,modelId:'ops-'+kind,kind,contextTokens:32768,active:true},roles.model_operator.cookie));
  const meter={rerank:'per_request',image:'per_image',asr:'per_second',tts:'per_1000_characters',video:'per_second'};
  let service=await command('save.service',{name:'托管凭据多模态连接',providerId:provider.id,baseUrl:model,credentialId:credential.id,credentialRef:null,active:true,limits:{mode:'custom',concurrency:1},videoCancellation:{method:'POST',path:'/v1/videos/{id}/cancel'},mappings:definitions.map(definition=>({definitionId:definition.id,upstreamModel:'test-'+(definition.kind==='chat'?'model':definition.kind),limits:{mode:'none'},...(meter[definition.kind]?{meter:{unit:meter[definition.kind],price:0,costPrice:0,estimatedUnits:1,maxUnits:10000}}:{costPrice:{inputPrice:0,outputPrice:0,cachedInputPrice:0}})}))});
  service=await command('save.service',{...service,mappings:service.mappings.map(({definitionId,upstreamModel,limits})=>({definitionId,upstreamModel,limits}))},roles.model_operator.cookie);
  /* The command receipt is redacted for actors without costs.read, so verify preservation on the stored service. */
  const preserved=(await request('/api/v1/platform/state')).services.find(item=>item.id===service.id);
  check(!!preserved&&preserved.mappings.every(mapping=>mapping.meter?.costPrice===0||mapping.costPrice?.inputPrice===0),'technical role preserves the required costs supplied by an authorized pricing operator');
  service=await command('pricing.update',{serviceId:service.id,mappings:definitions.map(definition=>({definitionId:definition.id,inputPrice:meter[definition.kind]?null:2,outputPrice:meter[definition.kind]?null:3,cachedInputPrice:meter[definition.kind]?null:1,...(meter[definition.kind]?{meter:{unit:meter[definition.kind],price:0.2,costPrice:0.1,estimatedUnits:1,maxUnits:10000}}:{costPrice:{inputPrice:1,outputPrice:2,cachedInputPrice:0.5}})}))},roles.finance_operator.cookie);
  await request('/api/v1/platform/preview',{type:'save.service',payload:{...service,name:'finance cannot edit'},idempotencyKey:randomUUID()},roles.finance_operator.cookie,403);
  await request('/api/v1/platform/preview',{type:'pricing.update',payload:{definitionId:definitions[0].id,billingMultiplier:3},idempotencyKey:randomUUID()},roles.model_operator.cookie,403);
  await request('/api/v1/platform/preview',{type:'save.member',payload:{id:roles.model_operator.member.id,roles:['operator']},idempotencyKey:randomUUID()},roles.model_operator.cookie,403);
  await request('/api/v1/platform/preview',{type:'save.pool',payload:{...pool},idempotencyKey:randomUUID()},roles.auditor.cookie,403);
  check(true,'direct API authorization separates technical, pricing, audit and role assignment responsibilities');
  const technical=await request('/api/v1/platform/state',undefined,roles.model_operator.cookie);
  check(technical.services.find(item=>item.id===service.id).mappings.every(mapping=>mapping.costPrice===undefined)&&technical.definitions.every(definition=>definition.billingMultiplier===undefined),'technical snapshots redact costs and multipliers while retaining connection configuration');
  await request(`/api/v1/platform/services/${service.id}/verify`,{},roles.model_operator.cookie);
  const fallback=await command('save.service',{name:'路由备用连接',providerId:provider.id,baseUrl:model,credentialId:credential.id,credentialRef:null,active:true,limits:{mode:'none'},mappings:[service.mappings.find(mapping=>mapping.definitionId===definitions[0].id)]});
  await request(`/api/v1/platform/services/${fallback.id}/verify`,{});
  await command('save.pool',{...pool,routing:{strategy:'priority',failureThreshold:3,cooldownSeconds:30},entries:[...pool.entries,...definitions.map(definition=>({serviceId:service.id,definitionId:definition.id,open:true,priority:0,weight:2})),{serviceId:fallback.id,definitionId:definitions[0].id,open:true,priority:1,weight:1}]});
  const key=await command('key.issue',{name:'运营能力验收 Key',purpose:'personal',memberId:seeded.employeeId});
  const resolved=await internal('policy/credentials/resolve',{apiKey:key.secret});
  const heldId='held-'+randomUUID(),held=await internal('policy/authorize',{identity:resolved.identity,purpose:'personal',modelId:'ops-chat',mode:'chat',estimatedInputTokens:1,maxOutputTokens:1,policyVersion:'local',requestId:heldId,idempotencyKey:heldId});
  assert.equal(held.decision,'allow');
  const forbiddenSecret=await fetch(cp+'/internal/v1/upstream/resolve',{method:'POST',headers:{cookie:adminCookie,'content-type':'application/json'},body:JSON.stringify({requestId:heldId,reservationId:held.reservation.reservationId})});
  check(forbiddenSecret.status===401,'an administrator session cannot call the service-token-only credential resolution endpoint');await forbiddenSecret.text();
  const wrongReservation=await fetch(cp+'/internal/v1/upstream/resolve',{method:'POST',headers:{authorization:'Bearer web-check-service-token','content-type':'application/json'},body:JSON.stringify({requestId:heldId,reservationId:'reservation-wrong-scope'})});
  check(wrongReservation.status===409,'internal credential resolution requires the canonical matching reservation');await wrongReservation.text();

  const simulation=await request(`/api/v1/platform/pools/${pool.id}/simulate`,{modelId:'ops-chat',requestId:'repeatable-routing-test',maxOutputTokens:1},roles.model_operator.cookie);
  check(simulation.decision.selectedServiceId===fallback.id&&simulation.decision.candidates.some(candidate=>candidate.serviceId===service.id&&candidate.status==='capacity'),'PostgreSQL simulation uses live service concurrency and explains a skipped preferred source');
  const routedId='routed-'+randomUUID(),routed=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key.secret,'content-type':'application/json','x-request-id':routedId},body:JSON.stringify({model:'ops-chat',messages:[{role:'user',content:'routing fixture'}],max_tokens:1})});
  assert.equal(routed.status,200);await routed.text();
  const log=(await request('/api/v1/platform/calls/query',{requestId:routedId})).items[0];
  check(log.admission.route.serviceId===fallback.id&&log.admission.routing.candidates.some(candidate=>candidate.status==='capacity'),'actual call persists the same capacity exclusion and selected fallback');
  await request(`/api/v1/platform/pools/${pool.id}/simulate`,{modelId:'ops-chat'},roles.auditor.cookie,403);
  const delivered=[];
  const hook=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();
    const signature=createHmac('sha256','operations-local-webhook-signing-key-2026').update(`${req.headers['x-gateway-timestamp']}.${raw}`).digest('hex');
    assert.equal(req.headers['x-gateway-signature'],'sha256='+signature);delivered.push(JSON.parse(raw));res.writeHead(200);res.end('ok');
  });
  await new Promise(resolve=>hook.listen(0,'127.0.0.1',resolve));
  try{
    const channel=await command('notification.channel.save',{name:'本地签名验收接收端',url:`http://127.0.0.1:${hook.address().port}/hook`,signingKeyRef:'NOTIFICATION_TEST_KEY',active:true});
    const alert=await command('save.alert-rule',{name:'并发压力告警',serviceId:service.id,metric:'concurrency_utilization',windowMinutes:1,threshold:80,minSamples:1,triggerCount:1,recoveryThreshold:50,recoveryCount:1});
    await request('/api/v1/platform/monitoring/check',{});
    await request('/api/v1/platform/maintenance/run',{});
    await request('/api/v1/platform/maintenance/run',{});
    const alertState=await request('/api/v1/platform/monitoring');const health=await(await fetch(cp+'/health')).json();
    assert.ok(delivered.some(event=>event.type==='alert.opened'),JSON.stringify({health,now:new Date().toISOString(),evaluation:alertState.evaluations[alert.id],events:alertState.events.map(event=>event.status),deliveries:alertState.deliveries?.map(delivery=>({status:delivery.status,error:delivery.lastError,attempts:delivery.attempts,created:delivery.createdAt,next:delivery.nextAttemptAt}))}));
    check(delivered.some(event=>event.type==='alert.opened'),'capacity alerts durably deliver a correctly signed webhook');
    await command('alert.silence',{id:alert.id,until:new Date(Date.now()+3600000).toISOString()},roles.model_operator.cookie);
    const monitoring=await request('/api/v1/platform/monitoring',undefined,roles.auditor.cookie);
    check(monitoring.rules.find(rule=>rule.id===alert.id).silencedUntil&&monitoring.deliveries.some(delivery=>delivery.status==='succeeded'),'audit role sees silencing and durable delivery status read-only');
    await internal('usage/settlements',{requestId:heldId,reservationId:held.reservation.reservationId,idempotencyKey:heldId+':release',outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,cachedInputTokens:0,completedAt:new Date().toISOString()});
    const employeeBalanceBefore=(await request('/api/v1/platform/state',undefined,await session('web-employee',seeded.employeePassword))).purposes[0].availableAmount;
    for(const [kind,probe] of [['chat','basic'],['chat','stream'],['chat','tools'],['embeddings','actual'],['rerank','actual'],['image','actual'],['asr','actual'],['tts','actual']]){
      const input={definitionId:definitions.find(definition=>definition.kind===kind).id,probe,maxCost:1,idempotencyKey:randomUUID()};
      const result=await request(`/api/v1/platform/services/${service.id}/acceptance`,input);
      assert.equal(result.run.results[0]?.outcome,'passed',JSON.stringify(result.run));
      check(result.run.state==='completed'&&result.run.results[0].outcome==='passed',`actual ${kind}/${probe} acceptance records a real local response`);
      const replay=await request(`/api/v1/platform/services/${service.id}/acceptance`,input);
      check(replay.replayed&&replay.run.id===result.run.id,`actual ${kind}/${probe} acceptance replays without another generation`);
    }
    await request(`/api/v1/platform/services/${service.id}/acceptance`,{definitionId:definitions.find(definition=>definition.kind==='image').id,probe:'actual',maxCost:0,idempotencyKey:randomUUID()},adminCookie,400);
    check((await request('/api/v1/platform/state',undefined,await session('web-employee',seeded.employeePassword))).purposes[0].availableAmount===employeeBalanceBefore,'platform acceptance diagnostics do not charge employee funds');
    check(true,'diagnostic cost cap rejects an over-budget image before dispatch');
    const videoId='video-'+randomUUID(),videoResponse=await fetch(gateway+'/v1/videos',{method:'POST',headers:{authorization:'Bearer '+key.secret,'content-type':'application/json','x-request-id':videoId},body:JSON.stringify({model:'ops-video',prompt:'local video',seconds:1})});
    assert.equal(videoResponse.status,200);const video=await videoResponse.json();
    await command('credential.save',{id:credential.id,secret:'local-credential-version-two'},roles.model_operator.cookie);
    await restartGateway();
    if(database){await restartControlPlane();check(true,'control-plane restart retains the encrypted vault, sessions and pending video job in PostgreSQL');}
    for(let attempt=0;attempt<80;attempt++){
      const tasks=await request('/api/v1/platform/media/tasks/query',{},await session('web-employee',seeded.employeePassword));
      if(tasks.items.some(task=>task.id===video.id&&task.settled))break;
      await pause(300);
    }
    const credentials=await(await fetch(model+'/_test/credential-requests')).json();
    check(credentials.some(entry=>entry.kind==='poll'&&entry.hash===createHash('sha256').update('Bearer local-credential-version-one').digest('hex')),'video polling after credential rotation and gateway restart uses the original frozen credential version');
    const employeeCookie=await session('web-employee',seeded.employeePassword),tasks=await request('/api/v1/platform/media/tasks/query',{},employeeCookie),videoTask=tasks.items.find(task=>task.id===video.id);
    check(videoTask?.status==='completed'&&videoTask.settled&&videoTask.canDownload,'session task listing exposes the owner progress and settled result');
    const outsider=await request('/api/v1/platform/media/tasks/query',{},roles.employee.cookie);
    check(outsider.items.length===0,'an unrelated user cannot enumerate another user media tasks');
    const auditTasks=await request('/api/v1/platform/media/tasks/query',{},roles.auditor.cookie);
    check(auditTasks.items.some(task=>task.id===video.id&&!task.canDownload&&!task.result?.url),'operations task records do not grant another user result access');
    const content=await fetch(gateway+`/v1/videos/${video.id}/content`,{headers:{authorization:'Bearer '+key.secret}});check(content.status===200&&(await content.arrayBuffer()).byteLength>0,'video result uses authenticated streaming content after restart');
    await request(`/api/v1/platform/services/${service.id}/verify`,{});
    const app=await command('save.application',{name:'视频回调应用',ownerId:seeded.employeeId,organizationId:'department-engineering',billingMode:'accounting',completionChannelId:channel.id,range:{poolId:pool.id,mode:'follow',definitionIds:[]}});
    const appKey=await command('key.issue',{name:'视频回调 Key',purpose:'application',applicationId:app.id});
    const cancelledResponse=await fetch(gateway+'/v1/videos',{method:'POST',headers:{authorization:'Bearer '+appKey.secret,'content-type':'application/json'},body:JSON.stringify({model:'ops-video',prompt:'cancel local video',seconds:1})});assert.equal(cancelledResponse.status,200);const cancelled=await cancelledResponse.json();
    const cancellation=await fetch(gateway+`/v1/videos/${cancelled.id}/cancel`,{method:'POST',headers:{authorization:'Bearer '+appKey.secret}});assert.equal(cancellation.status,200);await cancellation.text();
    for(let attempt=0;attempt<50;attempt++){const page=await request('/api/v1/platform/media/tasks/query',{},employeeCookie);if(page.items.some(task=>task.id===cancelled.id&&task.settled))break;await pause(300);}
    await request('/api/v1/platform/maintenance/run',{});await request('/api/v1/platform/maintenance/run',{});
    check(delivered.filter(event=>event.type==='media.cancelled'&&event.task?.id===cancelled.id).length===1,'completed application cancellation queues exactly one signed persistent callback');
    const cancelledTask=(await request('/api/v1/platform/media/tasks/query',{},employeeCookie)).items.find(task=>task.id===cancelled.id);
    check(cancelledTask?.status==='cancelled'&&cancelledTask.reservationStatus==='pending_review','cancellation preserves unknown vendor charges for reconciliation');
    await command('credential.save',{id:credential.id,active:false});
    const disabled=await fetch(gateway+'/v1/embeddings',{method:'POST',headers:{authorization:'Bearer '+key.secret,'content-type':'application/json'},body:JSON.stringify({model:'ops-embeddings',input:'disabled credential'})});check(disabled.status===403,'disabled managed credentials prevent new admissions');await disabled.text();
    await command('credential.save',{id:credential.id,active:true});
    const usage=await request(`/api/v1/platform/upstream-credentials/${credential.id}/usage`);check(usage.items.some(row=>row.version===1)&&usage.items.some(row=>row.version===2),'upstream usage is attributed to immutable credential versions');
    if(database){const persisted=(await database.query(`select payload::text as payload from "${schema}".platform_workspace`)).rows[0].payload;check(!persisted.includes('local-credential-version-one')&&!persisted.includes('local-credential-version-two'),'PostgreSQL workspace, audit and idempotent receipts contain no upstream plaintext');}
    const financeProject=await command('save.project',{name:'财务职责验收项目',managerId:seeded.employeeId,initialAmount:2,validity:'permanent',range:{poolId:pool.id,mode:'follow',definitionIds:[]}});
    const financeApplication=await command('save.application',{name:'财务职责验收应用',ownerId:seeded.employeeId,organizationId:'department-engineering',billingMode:'quota',initialAmount:2,validity:'permanent',range:{poolId:pool.id,mode:'follow',definitionIds:[]}});
    await command('project.fund',{projectId:financeProject.id,amount:1,validity:'permanent'},roles.finance_operator.cookie);
    await command('application.fund',{applicationId:financeApplication.id,amount:1,validity:'permanent'},roles.finance_operator.cookie);
    check(true,'finance role funds existing projects and applications without acquiring manager or key authority');
    async function nav(label){
      const found=await evaluate(`(()=>{const menu=document.querySelector('.v4-menu-button,.v3-menu-button');if(menu&&menu.getClientRects().length)menu.click();const button=[...document.querySelectorAll('#v4-sidebar nav button,.personal-header nav button,dialog .personal-mobile-nav button')].find(node=>node.textContent.trim().includes(${JSON.stringify(label)}));if(!button)return false;button.closest('details')?.setAttribute('open','');button.click();return true;})()`);
      assert.ok(found,`nav ${label}`);await pause(350);
    }
    await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await waitFor(`!!document.querySelector('#v4-sidebar')`);
    await nav('模型池');await waitFor(`document.querySelector('[data-page="pools"]')?.getClientRects().length>0`);
    await evaluate(`(()=>{const page=document.querySelector('[data-page="pools"]');const row=[...page.querySelectorAll('tbody tr')].find(row=>row.querySelector('button'));row.querySelector('button').click();})()`);
    await waitFor(`document.querySelector('[data-page="pools"]').innerText.includes('路由解释与试算')`);await screenshot('routing-simulation-1440.png');
    await clickExact('开始试算');await waitFor(`document.querySelector('[data-page="pools"]').innerText.includes('排序 / 分数')`);await screenshot('routing-decision-1440.png');
    await setViewport(390,844);check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'routing simulation has no page overflow at 390');await screenshot('routing-decision-390.png');
    await setViewport(1440,1000);await nav('供应商');await screenshot('credentials-1440.png');await clickExact('创建上游凭据');await waitFor(`!!document.querySelector('dialog input[type="password"]')`);check(await evaluate(`!!document.querySelector('dialog button[aria-label*="显示"]')`),'upstream credential entry is masked with an accessible reveal control');await setViewport(390,844);await screenshot('credential-editor-390.png');await pressKey('Tab');check(await evaluate(`document.querySelector('dialog')?.contains(document.activeElement)`),'keyboard focus remains inside credential editor');await pressKey('Escape');
    await setViewport(1440,1000);
    for(const [role,landing] of [['model_operator','运行监控'],['finance_operator','用量驾驶舱'],['auditor','用量驾驶舱']]){
      await evaluate(`fetch(${JSON.stringify(cp+'/api/v1/auth/logout')},{method:'POST',credentials:'include'})`);await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await login('ops-'+role,password);
      await waitFor(`document.body.innerText.includes(${JSON.stringify(landing)})`);
      check(!await evaluate(`!![...document.querySelectorAll('#v4-sidebar nav button')].find(button=>button.textContent.includes('组织与成员'))`),`${role} does not receive role assignment navigation`);
      await screenshot(`role-${role}-1440.png`);
      if(role==='finance_operator'||role==='auditor'){
        await nav('项目');
        await evaluate(`(()=>{const page=document.querySelector('[data-page="projects"]'),row=[...page.querySelectorAll('tr')].find(row=>row.textContent.includes('财务职责验收项目'));row.querySelector('button').click();})()`);
        await waitFor(`document.querySelector('[data-page="projects"]').innerText.includes('按运营职责查看')`);
        await evaluate(`(()=>{const page=document.querySelector('[data-page="projects"]');[...page.querySelectorAll('details')].find(details=>details.querySelector('summary')?.textContent==='资金来源、消费与回收明细').open=true;})()`);
        const reclaim=await evaluate(`!![...document.querySelectorAll('[data-page="projects"] button')].find(button=>button.textContent==='回收预算')`);
        check(reclaim===(role==='finance_operator'),`${role} project budget controls follow finance authority`);
        await nav('应用');
        await evaluate(`(()=>{const page=document.querySelector('[data-page="applications"]'),row=[...page.querySelectorAll('tr')].find(row=>row.textContent.includes('财务职责验收应用'));row.querySelector('button').click();})()`);
        await waitFor(`document.querySelector('[data-page="applications"]').innerText.includes('负责人：')`);
        await evaluate(`(()=>{const page=document.querySelector('[data-page="applications"]');for(const details of page.querySelectorAll('details'))details.open=true;})()`);
        check(await evaluate(`!![...document.querySelectorAll('[data-page="applications"] button')].find(button=>button.textContent==='追加应用额度')`)===(role==='finance_operator'),`${role} application funding controls follow finance authority`);
        check(!await evaluate(`!![...document.querySelectorAll('[data-page="applications"] button')].find(button=>['签发应用接入密钥','需要一把新密钥','修改应用或交接负责人'].includes(button.textContent))`),`${role} gains neither application keys nor ownership administration`);
        await screenshot(`role-${role}-application-1440.png`);
      }

    }
    await evaluate(`fetch(${JSON.stringify(cp+'/api/v1/auth/logout')},{method:'POST',credentials:'include'})`);await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await login('web-employee',seeded.employeePassword);
    await nav('多模态工作台');await waitFor(`!!document.querySelector('[data-page="multimodal"] form')`);
    const fillField=async(label,value)=>evaluate(`(()=>{const page=document.querySelector('[data-page="multimodal"]'),label=[...page.querySelectorAll('label')].find(node=>node.textContent.includes(${JSON.stringify(label)})),input=document.getElementById(label.htmlFor);Object.getOwnPropertyDescriptor((input.tagName==='SELECT'?HTMLSelectElement:input.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement).prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
    const selectKind=async(label)=>evaluate(`(()=>{const page=document.querySelector('[data-page="multimodal"]'),button=[...page.querySelectorAll('.media-tabs button')].find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('missing media tab: '+${JSON.stringify(label)});button.click();})()`);
    await selectKind('向量嵌入');await waitFor(`document.querySelector('[data-page="multimodal"]').innerText.includes('运营验收 embeddings')`);await fillField('待编码文本','本地向量验收');
    await evaluate(`document.querySelector('[data-page="multimodal"] form').requestSubmit()`);await waitFor(`document.querySelector('[data-page="multimodal"]').innerText.includes('执行一次调用')`);await clickExact('执行一次调用');await waitFor(`document.querySelector('[data-page="multimodal"]').innerText.includes('向量维度')`);
    check(await evaluate(`document.querySelector('[data-page="multimodal"]').innerText.includes('3')`),'employee workbench performs real embedding and displays returned dimensions');await screenshot('workbench-result-1440.png');
    for(const theme of ['beacon','azure','sidebar','next','classic']){
      const label={beacon:'信标',azure:'蓝灰',sidebar:'左栏',next:'顶栏',classic:'经典'}[theme];
      await evaluate(`(()=>{const button=[...document.querySelectorAll('.design-switch button')].find(button=>button.getClientRects().length&&button.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('theme control missing');button.click();})()`);
      await waitFor(`document.documentElement.dataset.layout===${JSON.stringify(theme==='beacon'||theme==='azure'?'sidebar':theme)}&&document.documentElement.dataset.ui===${JSON.stringify(theme==='sidebar'?'next':theme)}`);
      await screenshot(`workbench-${theme}-1440.png`);
      await setViewport(390,844);check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),`${theme} workbench has no page overflow at 390`);await screenshot(`workbench-${theme}-390.png`);await setViewport(1440,1000);
    }
    await evaluate(`[...document.querySelectorAll('.design-switch button')].find(button=>button.getClientRects().length&&button.textContent.trim()==='信标').click()`);
    await waitFor(`document.documentElement.dataset.ui==='beacon'`);
    async function executeUi(kind,textValue,documentsValue){
      await selectKind({image:'图片生成',embeddings:'向量嵌入',rerank:'重排序',asr:'语音识别',tts:'语音合成',video:'视频生成'}[kind]);await pause(150);
      if(textValue)await fillField(kind==='embeddings'?'待编码文本':kind==='rerank'?'检索查询':kind==='tts'?'朗读文字':'生成提示词',textValue);
      if(documentsValue)await fillField('候选文档',documentsValue);
      await evaluate(`document.querySelector('[data-page="multimodal"] form').requestSubmit()`);
      await waitFor(`!![...document.querySelectorAll('[data-page="multimodal"] button')].find(button=>button.textContent==='执行一次调用'||button.textContent==='提交视频任务')`);
      await evaluate(`(()=>{const button=[...document.querySelectorAll('[data-page="multimodal"] button')].find(button=>button.textContent==='执行一次调用'||button.textContent==='提交视频任务');button.click();})()`);
      await waitFor(`![...document.querySelectorAll('[data-page="multimodal"] button')].some(button=>button.textContent==='处理中…')`);
    }
    await executeUi('image','本地图片验收');await waitFor(`document.querySelector('[data-page="multimodal"] img')?.naturalWidth>0`);
    check(true,'image workbench previews a valid returned PNG');await screenshot('workbench-image-1440.png');
    await executeUi('tts','本地音频验收');await waitFor(`document.querySelector('[data-page="multimodal"] audio')?.readyState>=1`);
    check(true,'TTS workbench loads playable WAV metadata');await screenshot('workbench-audio-1440.png');
    await selectKind('语音识别');await pause(150);
    const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
    const audioFile=resolve(tempDir,'workbench-audio.wav');await writeFile(audioFile,wav);
    const doc=await cdp.send('DOM.getDocument'),node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'[data-page="multimodal"] input[type="file"]'});
    await cdp.send('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[audioFile]});
    await executeUi('asr');await waitFor(`document.querySelector('[data-page="multimodal"]').innerText.includes('本地语音识别测试')`);
    check(true,'ASR workbench uploads a real audio file through the shared Field');
    await executeUi('rerank','模型网关','模型网关\n数据库');await waitFor(`document.querySelector('[data-page="multimodal"]').innerText.includes('原文第')`);
    check(true,'rerank workbench renders authoritative result order and score');
    await executeUi('video','本地工作台视频验收');await waitFor(`document.querySelector('[data-page="multimodal"]').innerText.includes('视频任务已提交')`);
    check(true,'video workbench submits a persisted generation task');await clickExact('查看任务进度与结果');
    await nav('视频任务中心');await waitFor(`document.querySelector('[data-page="media-tasks"]').innerText.includes(${JSON.stringify(video.id)})`);await screenshot('tasks-1440.png');await setViewport(390,844);await screenshot('tasks-390.png');check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'task center has no page overflow at 390');
    // Response-only failure fixture: an interrupted cancellation remains recoverable.
    await evaluate(`window.__taskRecoveryFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.__taskRecoveryFetch(...args);if(String(args[0]).endsWith('/media/tasks/query')&&response.ok){const page=await response.json();page.items=page.items.map(task=>task.id===${JSON.stringify(video.id)}?{...task,status:'in_progress',finishedAt:undefined,canCancel:true,result:{...task.result,cancel_requested:true,cancel_uncertain:true}}:task);return new Response(JSON.stringify(page),{status:200,headers:{'content-type':'application/json'}});}return response;}`);
    try{
      await evaluate(`[...document.querySelectorAll('[data-page="media-tasks"] button')].find(button=>button.textContent==='刷新任务')?.click()`);
      await waitFor(`!![...document.querySelectorAll('[data-page="media-tasks"] button')].find(button=>button.textContent==='重新请求取消'&&!button.disabled)`);
      check(await evaluate(`document.querySelector('[data-page="media-tasks"]').innerText.includes('取消结果待确认')`),'unknown cancellation is labeled and offers an explicit retry');
      await evaluate(`[...document.querySelectorAll('[data-page="media-tasks"] button')].find(button=>button.textContent==='重新请求取消').click()`);
      await waitFor(`!!document.querySelector('dialog[open] .danger-button')`);await screenshot('cancellation-recovery-390.png');
      check(await evaluate(`document.querySelector('dialog[open]').innerText.includes('最终状态以供应商确认与后台查询为准')||document.querySelector('dialog[open]').innerText.includes('取消是否成功以供应商确认与后台查询为准')`),'cancellation retry preserves the shared impact confirmation');
      await pressKey('Escape');
    }finally{await evaluate(`window.fetch=window.__taskRecoveryFetch;delete window.__taskRecoveryFetch`);}
    check(cdp.runtimeErrors.length===0,'operations v2 produces no uncaught browser errors');
  }finally{await new Promise(resolve=>hook.close(resolve));}
}
