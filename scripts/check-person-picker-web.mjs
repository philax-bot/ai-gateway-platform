import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {choosePerson} from './lib/person-picker-ui.mjs';

// Runs only in the disposable check-web workspace, never the daily workspace.
export async function checkPersonPicker({cp,web,seeded,cdp,evaluate,waitFor,pressKey,setViewport,screenshot,check}){
  const q=JSON.stringify,page=`document.querySelector('[data-page]:not([hidden])')`,picker=`document.querySelector('.person-picker-modal[open]')`,top=`(document.querySelector('dialog[open]:focus-within')??[...document.querySelectorAll('dialog[open]')].at(-1))`;
  async function request(path,body,status=200){const result=await evaluate(`(async()=>{const r=await fetch(${q(cp+path)},{method:${q(body===undefined?'GET':'POST')},credentials:'include',headers:{'content-type':'application/json'},body:${body===undefined?'undefined':q(JSON.stringify(body))}});return {status:r.status,body:await r.json()};})()`);assert.equal(result.status,status,`${path}: ${JSON.stringify(result.body)}`);return result.body;}
  const state=()=>request('/api/v1/platform/state');
  async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},p=await request('/api/v1/platform/preview',c);return(await request('/api/v1/platform/commands',{...c,previewToken:p.previewToken})).result;}
  async function click(text,scope=picker){await evaluate(`(()=>{const b=[...(${scope}).querySelectorAll('button')].find(b=>b.textContent.trim()===${q(text)}&&b.getClientRects().length);if(!b||b.disabled)throw Error('Missing enabled action: '+${q(text)});b.focus();b.click();})()`);}
  async function input(selector,value){await evaluate(`(()=>{const el=document.querySelector(${q(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${q(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
  async function nav(text){await evaluate(`(()=>{const menu=document.querySelector('.v4-menu-button,.v3-menu-button');if(menu?.getClientRects().length)menu.click();[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()===${q(text)}).click();})()`);await waitFor(`document.querySelector('h1')?.textContent===${q(text)}`);}
  async function open(label='选择开通人员'){await evaluate(`[...document.querySelectorAll('.person-picker-trigger')].find(b=>b.getAttribute('aria-label')===${q(label)}).focus()`);await pressKey('Enter');await waitFor(`${picker}?.querySelectorAll('.person-picker-row').length>0`);}
  const select=account=>evaluate(`[...document.querySelectorAll('.person-picker-results .person-row')].find(r=>r.querySelector('code')?.textContent===${q(account)}).querySelector('input').click()`);
  const search=async text=>{await input('.person-picker-people input:not([type])',text);await waitFor(`${picker}?.querySelectorAll('.person-picker-row').length>0&&[...document.querySelectorAll('.person-picker-row code')].some(c=>c.textContent.includes(${q(text)}))`);};
  await setViewport(1440,1080);await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await waitFor(`!!document.querySelector('#v4-sidebar')`);
  const initial=await state(),parent=await command('save.organization',{name:'人员回归中心',parentId:'org-demo'}),child=await command('save.organization',{name:'产品研发组',parentId:parent.id});
  const people=(await command('import.members',{rows:Array.from({length:43},(_,i)=>({name:'同名测试员工',directoryId:'picker-'+String(i).padStart(2,'0'),organizationId:i===42?child.id:parent.id,category:'employee',active:true}))})).members;
  const dead=await command('save.member',{name:'不可选员工',directoryId:'picker-disabled',organizationId:parent.id,active:false});
  const queried=await request('/api/v1/platform/people/query',{scope:'onboarding',query:'picker-',pageSize:40});
  check(queried.items.length===40&&queried.total===44,'people search is paginated by the server');
  check(queried.items.every(p=>p.directoryId&&p.organizationPath&&!('passwordHash' in p)&&!('roles' in p)),'candidate identity projection includes account/path and excludes credentials/roles');
  const roots=await request('/api/v1/platform/people/organizations',{scope:'onboarding'});check(roots.items.every(o=>!o.parentId)&&!roots.items.some(o=>o.id===child.id),'organization loading returns only one hierarchy level');
  check((await request('/api/v1/platform/people/query',{scope:'onboarding',organizationId:parent.id,includeChildren:false})).total===43,'organization-only filtering excludes children');
  check((await request('/api/v1/platform/people/query',{scope:'onboarding',organizationId:parent.id,includeChildren:true})).total===44,'organization subtree filtering includes descendants');
  await cdp.send('Page.reload');await waitFor(`!!document.querySelector('#v4-sidebar')`);await nav('为人员开通');await open();
  await search('picker-');await select('picker-00');await click('下一页');await waitFor(`${picker}.innerText.includes('第 2 / 2 页')&&!!document.querySelector('.person-picker-results code')`);await select('picker-42');
  check(await evaluate(`${picker}.querySelector('.person-picker-selected').innerText.includes('picker-00')&&${picker}.querySelector('.person-picker-selected').innerText.includes('picker-42')`),'same-name people remain distinct and selected across pages');
  await search('picker-01');await select('picker-01');await click('取消选择');
  check(await evaluate(`!${page}.querySelector('.person-picker-chip')`),'cancel discards only the picker draft and leaves the parent unchanged');
  await open();
  await evaluate(`[...document.querySelectorAll('.person-org-expand')].find(b=>b.getAttribute('aria-label')==='展开企业工作空间').click()`);
  await waitFor(`[...document.querySelectorAll('.person-org-expand')].some(b=>b.getAttribute('aria-label')==='展开人员回归中心')`);
  await evaluate(`[...document.querySelectorAll('.person-org-expand')].find(b=>b.getAttribute('aria-label')==='展开人员回归中心').click()`);
  await waitFor(`[...document.querySelectorAll('.person-org-name')].some(b=>b.textContent==='产品研发组')`);
  await evaluate(`[...document.querySelectorAll('.person-org-name')].find(b=>b.textContent==='产品研发组').click()`);
  await waitFor(`document.querySelectorAll('.person-picker-row').length===1&&document.querySelector('.person-picker-row code')?.textContent==='picker-42'`);
  check(await evaluate(`${picker}.innerText.includes('企业工作空间 / 人员回归中心 / 产品研发组')`),'lazy organization expansion filters candidates and retains the full path');
  await evaluate(`document.querySelector('.person-picker-row input').focus()`);await pressKey(' ','Space');await click('确认选择');await waitFor(`!${picker}`);
  check(await evaluate(`${page}.innerText.includes('picker-42')`),'confirmation fills the selected account into the parent');
  check((await state()).entitlements.length===initial.entitlements.length,'choosing people creates no entitlement or quota');
  await open();
  await evaluate(`window.personPickerOriginalFetch=window.fetch;window.fetch=(url,options)=>String(url).endsWith('/people/query')&&options?.body?.includes('picker-fault')?Promise.reject(Error('回归网络故障')):window.personPickerOriginalFetch(url,options)`);
  await input('.person-picker-people input:not([type])','picker-fault');await waitFor(`${picker}.querySelector('[role="alert"]')?.textContent.includes('连接已中断')`);
  check(await evaluate(`${picker}.querySelector('.person-picker-selected').innerText.includes('picker-42')`),'query failures keep the selected identities visible');
  await evaluate(`window.fetch=window.personPickerOriginalFetch;delete window.personPickerOriginalFetch`);await click('重试查询');await waitFor(`${picker}.innerText.includes('没有匹配人员')`);await pressKey('Escape');
  await open();await search('picker-00');await select('picker-00');
  await evaluate(`document.querySelector('.person-picker-modal .modal-footer button:last-child').focus()`);await pressKey('Tab');
  check(await evaluate(`document.activeElement===${picker}.querySelector('.modal-head button')`),'Tab wraps within the topmost picker');
  await screenshot('person-picker-1440.png');await setViewport(390,844);
  check(await evaluate(`(()=>{const r=${picker}.getBoundingClientRect();return r.width<=390&&r.height>=840&&document.documentElement.scrollWidth<=innerWidth;})()`),'mobile picker fills the screen without page overflow');
  await screenshot('person-picker-390.png');await click('组织');await waitFor(`getComputedStyle(document.querySelector('.person-picker-organizations')).display!=='none'`);await screenshot('person-picker-organizations-390.png');await click('已选 2');
  check(await evaluate(`getComputedStyle(document.querySelector('.person-picker-selected')).display!=='none'&&document.querySelector('.person-picker-selected').innerText.includes('picker-42')`),'mobile tabs preserve the selection');
  await pressKey('Escape');check(await evaluate(`!document.querySelector('dialog[open]')&&document.activeElement.getAttribute('aria-label')==='选择开通人员'`),'Escape cancels and restores the field focus');
  await setViewport(1440,1080);await open();await search('picker-00');await select('picker-00');
  await command('save.member',{...people[0],active:false});await click('确认选择');await waitFor(`${picker}.querySelector('[role="alert"]')?.textContent.includes('状态或可选范围已变化')`);
  check(await evaluate(`${picker}.querySelector('.person-picker-selected').innerText.includes('人员已停用')`),'confirmation rechecks eligibility and explains stale selected people');await pressKey('Escape');
  // A shared picker inside an editor must not lose the editor draft or close both dialogs.
  await nav('项目');await click('创建项目',page);await waitFor(`!!document.querySelector('dialog[open]')`);
  check(await evaluate(`!document.querySelector('dialog[open] .person-picker-field input[required]').checkValidity()`),'required person fields preserve native form validation');
  await waitFor(`document.activeElement.getAttribute('aria-label')==='选择项目经理'&&document.activeElement.getAttribute('aria-invalid')==='true'`);
  await input('dialog[open] .form-field input','人员选择器项目草稿');await open('选择项目经理');await search('picker-01');await select('picker-01');await pressKey('Escape');
  check(await evaluate(`document.querySelectorAll('dialog[open]').length===1&&document.querySelector('dialog[open] .form-field input').value==='人员选择器项目草稿'&&document.activeElement.getAttribute('aria-label')==='选择项目经理'`),'nested Escape closes only the picker, preserves editor fields and restores focus');
  await choosePerson({evaluate,waitFor},'选择项目经理',people[1]);check(await evaluate(`${top}.querySelector('.person-picker-trigger').innerText.includes('picker-01')`),'single-person manager field uses the same identity picker');await pressKey('Escape');
  const project=await command('save.project',{name:'人员范围回归项目',managerId:initial.actor.id,range:{poolId:initial.pools[0].id,mode:'follow',definitionIds:[]},initialAmount:10,expiresAt:new Date(Date.now()+86400000*30).toISOString()});await command('project.members',{projectId:project.id,memberIds:[people[1].id]});
  check((await request('/api/v1/platform/people/query',{scope:'project-allocation',projectId:project.id})).items.every(p=>[initial.actor.id,people[1].id].includes(p.id)),'allocation candidates stay within current project membership');
  const resolved=await request('/api/v1/platform/people/query',{scope:'project-members',projectId:project.id,ids:[people[1].id,dead.id]});check(resolved.items.every(p=>!p.selectable&&p.unavailableReason),'existing project members and disabled people resolve with explicit disabled reasons');
  await cdp.send('Page.reload');await waitFor(`!!document.querySelector('#v4-sidebar')`);await nav('项目');
  await evaluate(`(()=>{const row=[...document.querySelectorAll('tr')].find(r=>r.innerText.includes('人员范围回归项目'));[...row.querySelectorAll('button')].find(b=>b.textContent==='管理项目').click();})()`);
  await waitFor(`${page}.innerText.includes('添加其他成员')`);await click('添加其他成员',page);await waitFor(`!!document.querySelector('dialog[open] .person-picker-trigger')`);
  await choosePerson({evaluate,waitFor},'选择项目成员',people[2]);await click('添加所选成员',top);await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
  check(await evaluate(`${top}.innerText.includes('picker-02')&&${top}.innerText.includes('人员回归中心')`),'project member preview retains account and organization before committing membership');
  await evaluate(`${top}.querySelector('.modal-footer button:last-child').focus()`);await pressKey('Tab');
  check(await evaluate(`document.activeElement===${top}.querySelector('.modal-head button')`),'confirmation focus wraps correctly even when its parent appears later in document order');
  await click('确认执行',top);await waitFor(`document.querySelectorAll('dialog[open]').length===1&&${top}.innerText.includes('已添加 1 名成员')`);await pressKey('Escape');
  check((await state()).projects.find(p=>p.id===project.id).memberIds.includes(people[2].id),'shared project-member picker commits exactly the selected identity');
  await click('分配给成员',page);await waitFor(`!!document.querySelector('dialog[open] .person-picker-trigger')`);await open('选择项目成员');
  check(await evaluate(`[...document.querySelectorAll('.person-picker-results code')].every(c=>['web-ops','picker-01','picker-02'].includes(c.textContent))`),'allocation editor offers only current project members');
  await search('picker-02');await select('picker-02');await click('确认选择');await waitFor(`!${picker}`);
  await evaluate(`(()=>{const l=[...(${top}).querySelectorAll('label')].find(l=>l.textContent.includes('分配金额'));const el=document.getElementById(l.htmlFor);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'2');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('继续',top);await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
  check(await evaluate(`${top}.innerText.includes('picker-02')&&${top}.innerText.includes('人员回归中心')`),'allocation preview identifies the account and organization receiving the quota');
  await pressKey('Escape');await pressKey('Escape');
  for(const mode of ['beacon','azure','sidebar','next','classic']){await cdp.send('Page.navigate',{url:web+'/?ui='+mode});await waitFor(`[...document.querySelectorAll('nav button')].some(b=>b.textContent.trim()==='为人员开通')`);await nav('为人员开通');await open();check(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&${picker}.scrollWidth<=${picker}.clientWidth`),`${mode}: shared picker has no horizontal overflow`);await screenshot(`person-picker-${mode}-1440.png`);await pressKey('Escape');}
  await request('/api/v1/auth/logout',{});await request('/api/v1/auth/login',{directoryId:'web-employee',password:seeded.employeePassword});
  await request('/api/v1/platform/people/query',{scope:'onboarding'},403);await request('/api/v1/platform/people/query',{scope:'project-members',projectId:project.id},403);
  const peer=await request('/api/v1/platform/people/query',{scope:'manager',ids:[people[1].id,seeded.employeeId]});check(peer.items.length===1&&peer.items[0].id===seeded.employeeId,'ordinary members cannot enumerate another organization through direct ID resolution');
  check(cdp.runtimeErrors.length===0,'picker flows have no uncaught browser errors');
}
