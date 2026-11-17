import {choosePerson} from './lib/person-picker-ui.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Runs only within check-web's owned services, PostgreSQL schema and Chrome profile. */
export async function checkQuotaP0({cp,web,seeded,cdp,evaluate,waitFor,clickNav,clickExact,pressKey,setViewport,screenshot,login,check}){
  let cookie='';const forever='9999-12-31T23:59:59.999Z',future=days=>new Date(Date.now()+days*86400000).toISOString();
  async function api(path,body,expected=200,internal=false){
    const r=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',cookie,...(internal?{authorization:'Bearer web-check-service-token'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const result=await r.json();assert.equal(r.status,expected,`${path}: ${JSON.stringify(result)}`);return result;
  }
  const apiLogin=(name,password)=>api('/api/v1/auth/login',{directoryId:name,password});
  async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:preview.previewToken})).result;}
  const state=()=>api('/api/v1/platform/state');
  const projectDetail=id=>api('/api/v1/platform/projects/'+id),appDetail=id=>api('/api/v1/platform/applications/'+id);
  async function browserLogin(name,password,theme='beacon'){await evaluate(`fetch(${JSON.stringify(cp+'/api/v1/auth/logout')},{method:'POST',credentials:'include'}).then(()=>true)`);await cdp.send('Page.navigate',{url:web+'/?ui='+theme});await login(name,password);}
  async function field(label,value){if(await evaluate(`[...document.querySelectorAll('.person-picker-trigger')].some(b=>b.getAttribute('aria-label')===${JSON.stringify('选择'+label)})`)){const person=(await state()).members.find(m=>m.id===value);assert.ok(person);await choosePerson({evaluate,waitFor},'选择'+label,person);return;}check(await evaluate(`(()=>{const f=[...document.querySelectorAll('dialog[open] .form-field')].find(f=>f.querySelector('label,span')?.textContent.includes(${JSON.stringify(label)})),el=f?.querySelector('input:not([type=radio]),textarea,select');if(!el)return false;Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));return true;})()`),'field exists: '+label);}
  async function pair(name){for(const width of [1440,390]){await setViewport(width,width===390?844:1000);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`${name}: no overflow at ${width}`);await screenshot(`quota-${name}-${width}.png`);if(width===390&&name.endsWith('create')){await evaluate(`(()=>{const field=[...document.querySelectorAll('dialog[open] .form-field')].find(f=>f.textContent.includes('初始额度'));field?.scrollIntoView({block:'center'});})()`);await screenshot(`quota-${name}-amount-390.png`);}}await setViewport(1440,1000);}
  const radio=value=>evaluate(`document.querySelector('dialog[open] input[type=radio][value="${value}"]').click()`);
  const close=async()=>{await pressKey('Escape');await waitFor(`!document.querySelector('dialog[open]')`);};
  await apiLogin('web-ops',seeded.adminPassword);const initial=await state(),range={poolId:initial.pools[0].id,mode:'follow',definitionIds:[]};
  // Required creation inputs fail without leaving an object behind.
  const invalid={type:'save.project',payload:{name:'不应创建',managerId:seeded.employeeId,range},idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',invalid);
  await api('/api/v1/platform/commands',{...invalid,previewToken:preview.previewToken},400);check(!(await state()).projects.some(p=>p.name==='不应创建'),'missing initial quota does not create a project');
  const p=await command('save.project',{name:'P0 资金闭环项目',managerId:initial.actor.id,range,initialAmount:20,expiresAt:future(10)}),budget=(await projectDetail(p.id)).budgets[0];
  check(budget.totalAmount===20&&(await projectDetail(p.id)).members.every(m=>!m.batches.length),'initial project budget does not auto-allocate');
  await command('project.members',{projectId:p.id,memberIds:[seeded.employeeId]});
  const b=await command('project.allocate',{projectId:p.id,memberId:seeded.employeeId,sourceBatchId:budget.id,amount:8});
  await command('project.extend',{projectId:p.id,batchId:budget.id,validity:'permanent',reason:'持续建设'});
  check((await projectDetail(p.id)).members.flatMap(m=>m.batches).find(x=>x.id===b.id).expiresAt===forever,'budget extension updates its member batches in PostgreSQL');
  await apiLogin('web-employee',seeded.employeePassword);const issued=await command('key.issue',{purpose:'project',projectId:p.id,name:'P0 成员 Key'});
  const credential=await api('/internal/v1/policy/credentials/resolve',{apiKey:issued.secret},200,true),input={requestId:randomUUID(),idempotencyKey:randomUUID(),identity:credential.identity,purpose:'project',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'quota-p0'};
  const authorized=await api('/internal/v1/policy/authorize',input,200,true);check(authorized.decision==='allow','project call reserves actual quota');
  await apiLogin('web-ops',seeded.adminPassword);await command('project.members',{projectId:p.id,removeMemberIds:[seeded.employeeId]});
  let closed=(await projectDetail(p.id)).members.flatMap(m=>m.batches).find(x=>x.id===b.id);check(closed.availableAmount===0&&closed.closedAmount<8,'member removal closes free balance while keeping hold separate');
  await command('project.return',{projectId:p.id,batchId:b.id,amount:closed.closedAmount,reason:'退回移出余额'});
  await api('/internal/v1/usage/settlements',{requestId:input.requestId,idempotencyKey:randomUUID(),reservationId:authorized.reservation.reservationId,outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,completedAt:new Date().toISOString()},200,true);
  closed=(await projectDetail(p.id)).members.flatMap(m=>m.batches).find(x=>x.id===b.id);check(closed.closedAmount===authorized.reservation.reservedAmount,'late release remains on the original closed batch');
  await command('project.return',{projectId:p.id,batchId:b.id,amount:closed.closedAmount,reason:'退回后续释放'});
  check((await projectDetail(p.id)).budgets[0].availableAmount===20,'returned member money conserves original project budget');
  const a=await command('save.application',{name:'P0 额度应用',ownerId:seeded.employeeId,organizationId:'org-demo',range,billingMode:'quota',initialAmount:10,expiresAt:future(10)}),ab=(await appDetail(a.id)).batches[0];
  const reclaim={type:'application.reclaim',payload:{applicationId:a.id,batchId:ab.id,amount:4,reason:'收回多发'},idempotencyKey:randomUUID()};reclaim.previewToken=(await api('/api/v1/platform/preview',reclaim)).previewToken;
  await api('/api/v1/platform/commands',reclaim);check((await api('/api/v1/platform/commands',reclaim)).replayed,'quota recovery replay never subtracts twice');
  check((await appDetail(a.id)).batches[0].closedAmount===4&&(await appDetail(a.id)).availableAmount===6,'recovery preserves grant and separately records reclaimed balance');
  await apiLogin('web-employee',seeded.employeePassword);
  const extension=await command('approval.submit',{kind:'application_extend',objectId:a.id,batchId:ab.id,validity:'permanent',scenario:'长期业务',reason:'延长使用'});
  await apiLogin('web-ops',seeded.adminPassword);await command('approval.decide',{id:extension.id,decision:'approve',reason:'同意长期使用'});await command('approval.execute',{id:extension.id});
  check((await appDetail(a.id)).batches[0].expiresAt===forever&&(await appDetail(a.id)).availableAmount===6,'approved extension changes expiry without issuing new funds');
  // Exercise the actual UI, shared date keyboard path, validation and preview.
  await browserLogin('web-ops',seeded.adminPassword);await clickNav('项目');await clickExact('创建项目');
  await waitFor(`!!document.querySelector('dialog[open] input[type=number]')`);
  check(await evaluate(`(()=>{const f=[...document.querySelectorAll('dialog[open] .form-field')].find(f=>f.textContent.includes('初始额度'));return f.querySelector('input').value===''&&f.querySelector('input').required;})()`),'project initial quota is required and starts empty');
  await evaluate(`document.querySelector('dialog[open] .date-field-trigger').focus()`);await pressKey('ArrowDown');await waitFor(`!!document.querySelector('dialog[open] .date-panel')`);await pressKey('Escape');
  check(await evaluate(`document.activeElement.classList.contains('date-field-trigger')`),'date Escape restores trigger focus');
  await pair('project-create');await field('项目名称','P0 页面创建项目');await field('项目经理',seeded.employeeId);await radio('permanent');
  await clickExact('继续');check(await evaluate(`document.querySelectorAll('dialog[open]').length===1`),'empty initial amount blocks submission');
  await field('初始额度','12');await clickExact('继续');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);await pair('initial-preview');await clickExact('确认执行');await waitFor(`!document.querySelector('dialog[open]')`);
  const created=(await state()).projects.find(p=>p.name==='P0 页面创建项目');check((await projectDetail(created.id)).budgets[0].totalAmount===12,'UI creates project and initial budget together');
  await clickNav('应用');await clickExact('创建应用');await waitFor(`!!document.querySelector('dialog[open] input[value=quota]')`);
  check(await evaluate(`![...document.querySelectorAll('dialog[open] .form-field')].some(f=>f.textContent.includes('初始额度'))`),'accounting creation hides quota fields');
  await radio('quota');check(await evaluate(`document.querySelector('dialog[open] input[value=permanent]').checked`),'quota application defaults to explicit permanent policy');
  await pair('application-create');await close();
  // All themes share the same forms without page overflow.
  for(const theme of ['azure','sidebar','next','classic']){await cdp.send('Page.navigate',{url:web+'/?ui='+theme});await waitFor(`document.documentElement.dataset.ui===${JSON.stringify(theme==='sidebar'?'next':theme)}`);await setViewport(390,844);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`existing ${theme} shell has no mobile overflow`);}
  await browserLogin('web-employee',seeded.employeePassword);await setViewport(1440,1000);await clickNav('应用');await clickExact('申请创建应用');
  await waitFor(`!!document.querySelector('dialog[open] input[value=quota]')`);await radio('quota');await field('应用名称','P0 页面申请应用');await field('申请初始额度','15');await field('使用场景','流程集成');await field('申请说明','审批后同时发放初始额度');await pair('application-request');
  await clickExact('提交申请');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);await clickExact('确认提交申请');await waitFor(`!document.querySelector('dialog[open]')`);
  await apiLogin('web-employee',seeded.employeePassword);const request=(await state()).approvals.find(x=>x.kind==='application_create'&&x.proposedName==='P0 页面申请应用');check(request.status==='pending','employee submits application creation from UI');
  await browserLogin('web-ops',seeded.adminPassword);await clickNav('申请与审批');
  check(await evaluate(`(()=>{const card=[...document.querySelectorAll('[data-page="approvals"] .review-item')].find(b=>b.innerText.includes('P0 页面申请应用'));card?.click();return !!card;})()`),'application creation appears in the unified approval queue');
  await waitFor(`!!document.querySelector('[data-page="approvals"] [aria-label="当前处理与下一步"]')`);await clickExact('核对并批准');await waitFor(`!!document.querySelector('dialog[open]')`);await field('金额','13');await field('审批意见','核定初始额度');await pair('application-approve');await clickExact('预览批准内容');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);await clickExact('批准并生效');await waitFor(`!document.querySelector('dialog[open]')`);
  await apiLogin('web-ops',seeded.adminPassword);const receipt=(await state()).approvals.find(x=>x.id===request.id);check(receipt.status==='effective','application creation approval executes from the actual UI');
  check(receipt.receipt.amount===13&&(await appDetail(receipt.objectId)).availableAmount===13,'application approval records approved initial quota receipt');
  await browserLogin('web-ops',seeded.adminPassword);await clickNav('应用');
  check(await evaluate(`(()=>{const row=[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('P0 额度应用'));const b=[...row.querySelectorAll('button')].find(b=>b.textContent.includes('进入接入'));b.click();return true;})()`),'open funded application detail');
  await waitFor(`document.body.innerText.includes('账目、额度与调用结果')`);await clickExact('账目、额度与调用结果');await pair('application-ledger');await clickExact('回收额度');await field('金额','1');await field('变更原因','回收调整验收');await clickExact('预览额度变更');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);await pair('reclaim-preview');await clickExact('确认执行');await waitFor(`!document.querySelector('dialog[open]')`);
  check((await appDetail(a.id)).availableAmount===5,'UI recovery updates authoritative quota balance');
  await command('key.issue',{purpose:'application',applicationId:a.id,name:'P0 交接旧密钥'});
  await browserLogin('web-ops',seeded.adminPassword);await clickNav('应用');
  await evaluate(`(()=>{const row=[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('P0 额度应用'));[...row.querySelectorAll('button')].find(b=>b.textContent.includes('进入接入')).click();})()`);
  await waitFor(`document.body.innerText.includes('密钥管理与应用设置')`);await clickExact('密钥管理与应用设置');await clickExact('修改应用或交接负责人');await field('应用负责人',initial.actor.id);
  check(await evaluate(`document.querySelector('dialog[open] input[value=revoke]').checked`),'handoff defaults to revoking old credentials');
  await clickExact('继续');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);await pair('handoff-preview');
  check(await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).innerText.includes('P0 交接旧密钥')`),'handoff preview identifies affected credentials');
  await clickExact('确认执行');await waitFor(`!document.querySelector('dialog[open]')`);
  check((await appDetail(a.id)).keys.every(k=>k.status==='revoked')&&(await appDetail(a.id)).availableAmount===5,'handoff revokes keys and preserves quota');
  check(cdp.runtimeErrors.length===0,'quota workflows have no uncaught browser errors');
}
