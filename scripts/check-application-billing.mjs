import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Run inside check-web's owned services/schema/profile. Never uses a real upstream. */
export async function checkApplicationBilling({cp,gateway,web,seeded,cdp,evaluate,waitFor,clickNav,clickExact,setInput,pressKey,setViewport,screenshot,login,check}){
  let cookie='';
  async function api(path,body,expected=200){
    const r=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});
    if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    const data=await r.json();assert.equal(r.status,expected,`${path}: ${JSON.stringify(data)}`);return data;
  }
  const apiLogin=(directoryId,password)=>api('/api/v1/auth/login',{directoryId,password});
  async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:preview.previewToken})).result;}
  async function browserLogin(directoryId,password){
    await evaluate(`fetch(${JSON.stringify(cp+'/api/v1/auth/logout')},{method:'POST',credentials:'include'}).then(()=>true)`);
    await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await login(directoryId,password);
  }
  const visibleText=()=>evaluate(`document.querySelector('.v2-page-enter:not([hidden])')?.innerText??document.body.innerText`);
  const detail=id=>api('/api/v1/platform/applications/'+id);
  const screenshotPair=async name=>{for(const width of [1440,390]){await setViewport(width,width===390?844:1000);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`${name}: no overflow at ${width}`);if(width===390&&['negative','quota'].includes(name))await evaluate(`document.querySelector('.v2-page-enter:not([hidden]) details[open]')?.scrollIntoView({block:'start'})`);await screenshot(`application-billing-${name}-${width}.png`);}await setViewport(1440,1000);};
  await apiLogin('web-ops',seeded.adminPassword);
  const initial=await api('/api/v1/platform/state'),range={poolId:initial.pools[0].id,mode:'follow',definitionIds:[]};
  const application=await command('save.application',{name:'验收·默认记账应用',ownerId:seeded.employeeId,organizationId:'org-demo',range});
  check(application.billingMode==='accounting','new application defaults to accounting');
  check((await detail(application.id)).availableAmount===0,'accounting starts at zero without a grant');
  await apiLogin('web-employee',seeded.employeePassword);
  const issued=await command('key.issue',{name:'验收·应用 Key',purpose:'application',applicationId:application.id});
  async function chat(){const id=randomUUID(),r=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+issued.secret,'x-request-id':id,'idempotency-key':id},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'billing local check'}],max_tokens:100})});const body=await r.text();if(r.status!==200)console.error('Application local call:',r.status,body.slice(0,1000));return r.status;}
  check(await chat()===200,'zero-balance application key forwards to local model');
  let value=await detail(application.id);check(value.accountingBalance<0&&value.status==='ready','confirmed local usage persists as a negative ready balance');
  const firstDebt=value.accountingBalance;
  check(await chat()===200,'negative balance still allows application calls');
  value=await detail(application.id);check(value.accountingBalance<firstDebt,'second call further reduces accounting balance');
  const beforeSwitch=value.accountingBalance;
  await apiLogin('web-ops',seeded.adminPassword);
  const bypass={type:'save.application',idempotencyKey:randomUUID(),payload:{...application,billingMode:'quota'}};
  const preview=await api('/api/v1/platform/preview',bypass);await api('/api/v1/platform/commands',{...bypass,previewToken:preview.previewToken},409);
  const fund={type:'application.fund',idempotencyKey:randomUUID(),payload:{applicationId:application.id,amount:5,expiresAt:new Date(Date.now()+86400000).toISOString()}};
  const fundPreview=await api('/api/v1/platform/preview',fund);await api('/api/v1/platform/commands',{...fund,previewToken:fundPreview.previewToken},409);
  check((await detail(application.id)).application.billingMode==='accounting','operator edits and direct funding cannot bypass switching approval');

  await browserLogin('web-ops',seeded.adminPassword);await setViewport(1440,1000);await clickNav('应用');await clickExact('创建应用');
  await waitFor(`!!document.querySelector('dialog[open] input[type=radio][value=accounting]')`);
  check(await evaluate(`document.querySelector('dialog[open] input[value=accounting]').checked`),'create form defaults to accounting');
  await screenshotPair('create');
  await evaluate(`document.querySelector('dialog[open] input[value=accounting]').focus()`);await pressKey('ArrowDown');
  check(await evaluate(`document.querySelector('dialog[open] input[value=quota]').checked`),'keyboard selects quota mode');
  await pressKey('ArrowUp');await pressKey('Tab');check(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`),'create form retains keyboard focus');
  await pressKey('Escape');check(await evaluate(`!document.querySelector('dialog[open]')`),'Escape closes creation dialog');

  await browserLogin('web-employee',seeded.employeePassword);await clickNav('应用');await clickExact('进入接入');
  await waitFor(`document.body.innerText.includes('记账模式')&&document.body.innerText.includes('查看接入配置')`);
  await clickExact('账目、额度与调用结果');await screenshotPair('negative');
  check(!(await visibleText()).includes('申请追加额度'),'accounting has no direct quota request');
  await clickExact('申请切换为额度模式');await waitFor(`document.querySelector('dialog[open]')?.innerText.includes('申请初始额度')`);
  await evaluate(`(()=>{const inputs=[...document.querySelectorAll('dialog[open] input')];const scenario=inputs.find(i=>i.closest('.form-field')?.innerText.includes('使用场景'));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(scenario,'本地模式切换验收');scenario.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await setInput('dialog[open] textarea','确认历史账目保留，新额度独立使用','HTMLTextAreaElement');
  await clickExact('继续');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);await clickExact('确认执行');await waitFor(`!document.querySelector('dialog[open]')`);
  await apiLogin('web-employee',seeded.employeePassword);
  const approval=(await api('/api/v1/platform/state')).approvals.find(a=>a.kind==='application_billing'&&a.objectId===application.id);
  check(approval?.status==='pending','owner submits mode switch from the actual UI');
  await clickExact('查看模式切换申请');await waitFor(`document.body.innerText.includes('应用切换额度模式')`);await screenshotPair('approval');
  check(await chat()===200,'pending switching approval keeps accounting usable');
  const preserved=(await detail(application.id)).accountingBalance;assert.ok(preserved<beforeSwitch);
  await apiLogin('web-ops',seeded.adminPassword);
  await command('approval.decide',{id:approval.id,decision:'approve',amount:5,expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'本地验收批准'});
  check((await detail(application.id)).application.billingMode==='accounting','approval decision alone does not switch the mode');
  await command('approval.execute',{id:approval.id});await command('approval.execute',{id:approval.id});
  value=await detail(application.id);check(value.application.billingMode==='quota'&&value.availableAmount===5&&value.accountingBalance===preserved,'execution switches atomically, preserving debt and granting a separate full quota');
  check(value.batches.filter(b=>!b.accounting).length===1,'repeated execution never grants a second quota batch');
  check(await chat()===200,'original application key remains valid after switching');
  value=await detail(application.id);check(value.availableAmount<5&&value.accountingBalance===preserved,'new calls charge quota only, leaving old debt intact');
  const key=await api('/api/v1/platform/keys/'+issued.key.id);check(key.sources[0].balance===value.availableAmount,'key detail excludes historical accounting debt from current quota');
  await browserLogin('web-employee',seeded.employeePassword);await clickNav('应用');await clickExact('进入接入');await waitFor(`document.body.innerText.includes('额度模式')`);await clickExact('账目、额度与调用结果');
  check((await visibleText()).includes('历史记账余额'),'post-switch UI shows historical debt separately');await screenshotPair('quota');
  check(cdp.runtimeErrors.length===0,'application billing flows have no uncaught browser errors');
}
