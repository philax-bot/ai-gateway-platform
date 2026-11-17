import {choosePerson} from './lib/person-picker-ui.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Owned check-web workspace only. All plan writes use the visible editor and preview.
export async function checkOnboardingPlans({cp,model,web,seeded,cdp,evaluate,waitFor,pressKey,setViewport,screenshot,check}){
  const q=JSON.stringify,dialog=`[...document.querySelectorAll('dialog[open]')].at(-1)`,page=`document.querySelector('[data-page]:not([hidden])')`;
  async function click(label,scope=page){
    await evaluate(`(()=>{const el=[...(${scope}).querySelectorAll('button,summary')].find(b=>b.getClientRects().length&&b.textContent.trim()===${q(label)});if(!el||el.disabled)throw Error('Missing action: '+${q(label)});el.scrollIntoView({block:'center'});el.focus();el.click();})()`);
  }
  async function nav(label){
    await evaluate(`(()=>{const menu=document.querySelector('.v4-menu-button,.v3-menu-button');if(menu?.getClientRects().length)menu.click();const el=[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()===${q(label)});if(!el)throw Error('Missing navigation: '+${q(label)});el.click();})()`);
    await waitFor(`document.querySelector('h1')?.textContent===${q(label)}`);
  }
  async function field(label,value){
    await evaluate(`(()=>{const l=[...(${dialog}).querySelectorAll('label')].find(l=>l.textContent.replace(/\\s*\\*$/,'').trim()===${q(label)});if(!l)throw Error('Missing field: '+${q(label)});const el=document.getElementById(l.htmlFor),proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${q(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  }
  const value=label=>evaluate(`(()=>{const l=[...(${dialog}).querySelectorAll('label')].find(l=>l.textContent.replace(/\\s*\\*$/,'').trim()===${q(label)});return l?document.getElementById(l.htmlFor)?.value:null;})()`);
  async function save(label='保存开通方案'){
    await click(label,dialog);await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
    await evaluate(`(${dialog}).querySelector('.modal-footer button:last-child').click()`);
    await waitFor(`document.querySelectorAll('dialog[open]').length<2`);
  }
  async function request(path,body){
    const result=await evaluate(`(async()=>{const r=await fetch(${q(cp+path)},{method:${q(body===undefined?'GET':'POST')},credentials:'include',headers:{'content-type':'application/json'},body:${body===undefined?'undefined':q(JSON.stringify(body))}});return {status:r.status,body:await r.json()};})()`);
    assert.equal(result.status,200,`${path}: ${JSON.stringify(result.body)}`);return result.body;
  }
  async function command(type,payload){const input={type,payload,idempotencyKey:randomUUID()},preview=await request('/api/v1/platform/preview',input);return (await request('/api/v1/platform/commands',{...input,previewToken:preview.previewToken})).result;}
  const state=()=>request('/api/v1/platform/state');
  await setViewport(1440,1080);await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await waitFor(`!!document.querySelector('#v4-sidebar')`);
  const initial=await state(),source=initial.services[0],definition=initial.definitions[0];
  const extra=await command('save.service',{...source,id:undefined,name:'方案回填本地来源',baseUrl:model,mappings:source.mappings.map(m=>({...m,costPrice:{inputPrice:0,outputPrice:0,cachedInputPrice:0}}))});
  await request(`/api/v1/platform/services/${extra.id}/verify`,{});
  const emptyPool=await command('save.pool',{name:'待配置来源池',entries:[],limits:{mode:'inherit'}});
  await cdp.send('Page.reload');await waitFor(`!!document.querySelector('#v4-sidebar')`);
  await nav('开通方案');
  check(await evaluate(`${page}.innerText.includes('个人开通方案')&&${page}.innerText.includes('回归模型池')`),'independent plan page shows the associated pool');
  await screenshot('plans-1440.png');
  await nav('为人员开通');
  check(await evaluate(`![...(${page}).querySelectorAll('h2')].some(h=>h.textContent==='个人开通方案')`),'onboarding no longer duplicates the plan management table');
  await choosePerson({evaluate,waitFor},'选择开通人员',{directoryId:'web-employee'});
  await click('下一步：选择方案（1 人）');
  await evaluate(`(${page}).querySelector('.plan-choice input:not(:disabled)').click()`);
  const original=await evaluate(`${page}.querySelector('.plan-choice input:checked').closest('label').querySelector('strong').textContent`);
  await click('新建方案');await waitFor(`${dialog}?.querySelector('h2')?.textContent==='创建个人开通方案'`);
  await click('保存开通方案',dialog);
  check(await evaluate(`document.querySelectorAll('dialog[open]').length===1&&!!(${dialog}).querySelector(':invalid')`),'required fields block an empty plan before preview');
  await field('方案名称','取消的方案');await pressKey('Escape');
  check(await evaluate(`${page}.querySelector('.choice-summary').innerText.includes('已选 1 人')&&${page}.querySelector('.plan-choice input:checked').closest('label').querySelector('strong').textContent===${q(original)}`),'cancelling creation preserves selected people, plan and step');
  await click('新建方案');await field('方案名称','就地新建方案');await field('每次发放金额（CNY）','-1');
  await save();await waitFor(`!!(${dialog})?.querySelector('[role="alert"]')`);
  check(await value('方案名称')==='就地新建方案','server rejection preserves the plan draft for correction');
  await field('每次发放金额（CNY）','27');
  await click('新建模型池，完成后返回',dialog);await waitFor(`${dialog}?.querySelector('h2')?.textContent==='创建模型池'`);
  await field('模型池名称','弹窗回填模型池');
  await evaluate(`(()=>{const l=[...(${dialog}).querySelectorAll('label')].find(l=>l.textContent.replace(/\\s*\\*$/,'').trim()==='纳入的模型服务');const el=document.getElementById(l.htmlFor);el.focus();el.click();})()`);
  await waitFor(`!!document.querySelector('[role="listbox"]')`);
  await evaluate(`[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes('方案回填本地来源')).click()`);
  await evaluate(`document.querySelector('[role="listbox"]')?.focus()`);await pressKey('Escape');
  await waitFor(`${dialog}?.querySelector('h2')?.textContent==='创建模型池'&&[...(${dialog}).querySelectorAll('summary')].some(s=>s.textContent.includes('模型开放状态'))`);
  await evaluate(`(()=>{const s=[...(${dialog}).querySelectorAll('summary')].find(s=>s.textContent.includes('模型开放状态'));s.parentElement.open=true;})()`);
  await field(`方案回填本地来源 · ${definition.name}`,'yes');await save('继续');
  await waitFor(`${dialog}?.querySelector('h2')?.textContent==='创建个人开通方案'`);
  const nestedPool=(await state()).pools.find(p=>p.name==='弹窗回填模型池');
  check(await value('方案名称')==='就地新建方案'&&await value('每次发放金额（CNY）')==='27'&&await value('模型池')===nestedPool.id,'nested pool creation preserves the plan draft and fills the new pool');
  await save();await waitFor(`!document.querySelector('dialog[open]')`);
  check(await evaluate(`${page}.querySelector('.plan-choice input:checked')?.closest('label').innerText.includes('就地新建方案')&&${page}.querySelector('.choice-summary').innerText.includes('已选 1 人')`),'saved plan is auto-selected without losing the selected people');
  check(await evaluate(`${page}.querySelector('.plan-choice input:checked').closest('label').innerText.includes('弹窗回填模型池')`),'plan selection shows the pool as well as the plan name');
  let snapshot=await state();
  check(snapshot.entitlements.length===initial.entitlements.length&&snapshot.distributions.length===initial.distributions.length,'creating a plan grants no entitlements or quota distributions');
  await screenshot('plan-selected-1440.png');
  await click('新建方案');await field('方案名称','暂不可开通方案');await field('模型池',emptyPool.id);await save();await waitFor(`!document.querySelector('dialog[open]')`);
  check(await evaluate(`${page}.querySelector('.plan-choice input:checked')?.disabled&&${page}.querySelector('[role="alert"]').innerText.includes('模型池尚未纳入模型服务')`),'a newly saved unavailable plan stays visible, selected and explains its blocking reason');
  check(await evaluate(`[...(${page}).querySelectorAll('button')].find(b=>b.textContent==='预览名单与金额').disabled`),'an unavailable plan cannot start quota distribution');
  await screenshot('plan-blocked-1440.png');await setViewport(390,844);
  check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'mobile onboarding has no page overflow');await screenshot('plan-blocked-390.png');
  await click('修改方案');await waitFor(`!!document.querySelector('dialog[open]')`);await screenshot('plan-editor-390.png');
  await field('模型池',nestedPool.id);await save();await waitFor(`!document.querySelector('dialog[open]')`);
  check(await evaluate(`![...(${page}).querySelectorAll('button')].find(b=>b.textContent==='预览名单与金额').disabled`),'correcting the pool makes the selected plan usable without resetting the wizard');
  await click('预览名单与金额');await waitFor(`!!document.querySelector('dialog[open]')`);
  check(await evaluate(`${dialog}.innerText.includes('回归员工')&&${dialog}.innerText.includes('暂不可开通方案')`),'distribution still requires a separate people and amount preview');
  await pressKey('Escape');
  for(const mode of ['beacon','azure','sidebar','next','classic']){
    await setViewport(1440,1080);await cdp.send('Page.navigate',{url:web+'/?ui='+mode});
    await waitFor(`[...document.querySelectorAll('nav button')].some(b=>b.textContent.trim()==='开通方案')`);
    await nav('开通方案');check(await evaluate(`${page}.innerText.includes('就地新建方案')`),`${mode}: independent plan navigation works`);
    check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),`${mode}: plan management has no page overflow`);
    if(mode==='beacon'){await screenshot('plans-with-status-1440.png');await setViewport(390,844);check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'mobile plan management has no page overflow');await screenshot('plans-390.png');await setViewport(1440,1080);}
    await nav('为人员开通');await waitFor(`${page}.innerText.includes('选择开通方案')`);
    await evaluate(`[...(${page}).querySelectorAll('button')].find(b=>b.textContent==='新建方案').focus()`);await pressKey('Enter');
    await waitFor(`!!document.querySelector('dialog[open]')`);await pressKey('Escape');
    check(await evaluate(`document.activeElement.textContent==='新建方案'`),`${mode}: keyboard creation and cancel restore focus`);
  }
  snapshot=await state();check(snapshot.entitlements.length===initial.entitlements.length&&snapshot.distributions.length===initial.distributions.length,'cancelled distribution previews leave quota and entitlements unchanged');
  check(cdp.runtimeErrors.length===0,'plan creation, correction and navigation have no uncaught browser errors');
}
