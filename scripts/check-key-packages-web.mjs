import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Disposable check-web PostgreSQL schema and loopback model fixture only.
export async function checkKeyPackages({cp,gateway,model,web,cdp,evaluate,waitFor,pressKey,setViewport,screenshot,check,database,schema}){
  assert.ok(database);assert.match(schema,/^agp_web_[a-f0-9]{32}$/);
  const q=JSON.stringify,dialog=`[...document.querySelectorAll('dialog[open]')].at(-1)`,page=`document.querySelector('[data-page]:not([hidden])')`;
  async function click(label,scope=page){await evaluate(`(()=>{const b=[...(${scope}).querySelectorAll('button')].find(b=>b.textContent.trim()===${q(label)}&&b.getClientRects().length);if(!b||b.disabled)throw Error('Missing action: '+${q(label)});b.scrollIntoView({block:'center'});b.focus();b.click();})()`);}
  async function field(label,value){await evaluate(`(()=>{const l=[...(${dialog}).querySelectorAll('label')].find(l=>l.textContent.replace(/\\s*\\*$/,'').trim()===${q(label)});const el=document.getElementById(l.htmlFor),proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${q(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);}
  async function request(path,body,status=200){const result=await evaluate(`(async()=>{const r=await fetch(${q(cp+path)},{method:${q(body===undefined?'GET':'POST')},credentials:'include',headers:{'content-type':'application/json'},body:${body===undefined?'undefined':q(JSON.stringify(body))}});return {status:r.status,body:await r.json()};})()`);assert.equal(result.status,status,`${path}: HTTP ${result.status}`);return result.body;}
  async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},p=await request('/api/v1/platform/preview',c);return (await request('/api/v1/platform/commands',{...c,previewToken:p.previewToken})).result;}
  const state=()=>request('/api/v1/platform/state');
  async function nav(){await evaluate(`(()=>{const menu=document.querySelector('.v4-menu-button,.v3-menu-button');if(menu?.getClientRects().length)menu.click();[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()==='密钥与接入').click();})()`);await waitFor(`document.querySelector('h1')?.textContent==='密钥与接入'`);}
  async function choosePackages(names){
    await evaluate(`[...(${dialog}).querySelectorAll('label.plan-choice')].find(l=>l.textContent.trim()==='指定套餐').querySelector('input').click()`);
    await evaluate(`(()=>{const l=[...(${dialog}).querySelectorAll('label')].find(l=>l.textContent.replace(/\\s*\\*$/,'').trim()==='允许使用的套餐');const b=document.getElementById(l.htmlFor);b.focus();b.click();})()`);
    await waitFor(`!!document.querySelector('[role="listbox"]')`);
    for(const name of names)await evaluate(`[...document.querySelectorAll('[role="option"]')].find(o=>o.textContent.startsWith(${q(name+' ·')})).click()`);
    await evaluate(`document.querySelector('[role="listbox"]').focus()`);await pressKey('Escape');
  }
  async function finishKey(name){
    await click('继续',dialog);await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
    const preview=await evaluate(`${dialog}.innerText`);check(preview.includes('套餐范围'),'key preview explicitly confirms the package scope');
    await evaluate(`(${dialog}).querySelector('.modal-footer button:last-child').click()`);
    await waitFor(`!!document.getElementById('issued-api-key')`);
    check(await evaluate(`document.getElementById('issued-api-key').type==='password'`),'issued secret stays masked by default');
    const secret=await evaluate(`document.getElementById('issued-api-key').value`),key=(await state()).keys.find(k=>k.name===name);
    await click('我已保存，查看接入指引',dialog);await waitFor(`${dialog}?.querySelector('h2')?.textContent==='编程工具接入'&&${dialog}.innerText.includes('套餐范围')`);
    check(await evaluate(`${dialog}.innerText.includes('套餐范围')`),'connection guide displays the issued scope');
    await pressKey('Escape');await waitFor(`!document.querySelector('dialog[open]')`);return {key,secret};
  }
  async function chat(issued,publicModel='test-model'){
    const response=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+issued.secret,'content-type':'application/json'},body:JSON.stringify({model:publicModel,messages:[{role:'user',content:'isolated package scope check'}],max_tokens:8})});return {status:response.status,body:await response.json()};
  }
  await setViewport(1440,1080);await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await waitFor(`!!document.querySelector('#v4-sidebar')`);
  const initial=await state(),source=initial.services[0],firstPool=initial.pools[0],actor=initial.actor;
  const extraDefinition=await command('save.definition',{name:'套餐乙专属模型',modelId:'package-second-only',kind:'chat',contextTokens:32768,active:true});
  const secondService=await command('save.service',{...source,id:undefined,name:'套餐乙本地来源',baseUrl:model,mappings:[...source.mappings, {...source.mappings[0],definitionId:extraDefinition.id}].map(m=>({...m,costPrice:{inputPrice:0,outputPrice:0,cachedInputPrice:0}}))});
  await request(`/api/v1/platform/services/${secondService.id}/verify`,{});
  const secondPool=await command('save.pool',{name:'套餐乙模型池',entries:secondService.mappings.map(m=>({serviceId:secondService.id,definitionId:m.definitionId,open:true})),limits:{mode:'none'}});
  async function grant(name,pool){const plan=await command('save.plan',{name,range:{poolId:pool.id,mode:'follow',definitionIds:[]},amount:20,cadence:'once',quotaDays:30,entitlementDays:365});await command('distribution.execute',{planId:plan.id,memberIds:[actor.id]});return (await state()).entitlements.find(e=>e.planId===plan.id&&e.memberId===actor.id);}
  const first=await grant('套餐甲',firstPool),second=await grant('套餐乙',secondPool);
  await cdp.send('Page.reload');await waitFor(`!!document.querySelector('#v4-sidebar')`);await nav();
  await click('签发密钥');await field('密钥名称','只用套餐乙');
  await evaluate(`[...(${dialog}).querySelectorAll('label.plan-choice')].find(l=>l.textContent.trim()==='指定套餐').querySelector('input').click()`);
  await click('继续',dialog);await waitFor(`(${dialog}).querySelector('[role="alert"]')?.textContent.includes('至少选择一个')`);
  check(true,'specific mode refuses an empty package selection before preview');
  await choosePackages(['套餐乙']);
  check(await evaluate(`${dialog}.innerText.includes('套餐乙模型池')&&${dialog}.innerText.includes('余额 20 元')&&${dialog}.innerText.includes('到期')`),'package choices show model pool, balance and expiration');
  await screenshot('key-packages-1440.png');await setViewport(390,844);
  check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'mobile package editor has no page overflow');await screenshot('key-packages-390.png');await setViewport(1440,1080);
  const fixed=await finishKey('只用套餐乙');check(JSON.stringify(fixed.key.entitlementIds)===JSON.stringify([second.id]),'UI persists selected entitlement identity');
  const models=await fetch(gateway+'/v1/models',{headers:{authorization:'Bearer '+fixed.secret}}).then(r=>r.json());
  check(models.data.some(m=>m.id==='package-second-only'),'scoped key discovers models from its selected package');
  const called=await chat(fixed);assert.equal(called.status,200);
  const calls=await request('/api/v1/platform/calls/query',{credentialId:fixed.key.credentialId});
  check(calls.items.some(c=>c.admission?.route?.poolId===secondPool.id&&c.billableState==='confirmed'),'same public model is routed and settled through the selected package pool');
  let snapshot=await state();
  const balance=(s,e)=>s.quotaBatches.filter(b=>b.entitlementId===e.id).reduce((n,b)=>n+b.availableAmount,0);
  check(balance(snapshot,first)===20&&balance(snapshot,second)<20,'settlement deducts only the selected package');
  const detail=await request('/api/v1/platform/keys/'+fixed.key.id);check(detail.sources.length===1&&detail.sources[0].name==='套餐乙','key detail excludes unselected funding sources');
  await database.query(`update "${schema}".quota_batches set available_amount=0 where entitlement_id=$1`,[second.id]);
  const exhausted=await chat(fixed);check(exhausted.status>=400&&exhausted.body.error?.code==='quota_insufficient','exhausted selected package cannot fall back to an unselected funded package');
  snapshot=await state();check(balance(snapshot,first)===20,'refused fallback preserves outside balances');
  await click('签发密钥');await field('密钥名称','两个套餐');await choosePackages(['套餐甲','套餐乙']);const multi=await finishKey('两个套餐');
  check(multi.key.entitlementIds.length===2&&(await chat(multi)).status===200,'multi-selection may use another selected package when one is exhausted');
  await click('签发密钥');await field('密钥名称','全部套餐');const all=await finishKey('全部套餐');check(all.key.entitlementIds===undefined,'all mode preserves the legacy dynamic scope');
  await grant('后续新开通套餐',firstPool);
  check((await request('/api/v1/platform/keys/'+all.key.id)).sources.some(s=>s.name==='后续新开通套餐'),'all-mode key includes later entitlements');
  check((await request('/api/v1/platform/keys/'+fixed.key.id)).sources.length===1,'specific key does not widen when another package is granted');
  const foreign=initial.entitlements.find(e=>e.memberId!==actor.id),bad={type:'key.issue',payload:{name:'非法套餐',purpose:'personal',entitlementIds:[foreign.id]},idempotencyKey:randomUUID()},preview=await request('/api/v1/platform/preview',bad);
  await request('/api/v1/platform/commands',{...bad,previewToken:preview.previewToken},400);check(true,'direct API cannot bind another person’s entitlement');
  for(const mode of ['beacon','azure','sidebar','next','classic']){
    await cdp.send('Page.navigate',{url:web+'/?ui='+mode});await waitFor(`[...document.querySelectorAll('nav button')].some(b=>b.textContent.trim()==='密钥与接入')`);await nav();
    await click('签发密钥');await choosePackages(['套餐甲']);
    check(await evaluate(`${dialog}.querySelector('.multi-select-trigger').innerText.includes('套餐甲')&&document.documentElement.scrollWidth<=innerWidth`),`${mode}: shared MultiSelect package editor works without overflow`);
    await pressKey('Tab');check(await evaluate(`!!document.activeElement.closest('dialog[open]')`),`${mode}: keyboard focus stays inside the editor`);
    await pressKey('Escape');await waitFor(`!document.querySelector('dialog[open]')`);
    check(await evaluate(`document.activeElement.textContent==='签发密钥'`),`${mode}: cancel restores focus to key creation`);
  }
  check(cdp.runtimeErrors.length===0,'key scope flows have no uncaught browser errors');
}
