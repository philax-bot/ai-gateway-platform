import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Runs inside check-web's isolated fixture services and automation-owned Chrome.
export async function checkModelDiscovery({cp,web,seeded,cdp,evaluate,waitFor,setInput,pressKey,setViewport,screenshot,login,check}){
  const response=await fetch(cp+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({directoryId:'web-ops',password:seeded.adminPassword})});
  assert.ok(response.ok);const cookie=response.headers.get('set-cookie').split(';')[0];
  async function api(path,body){const r=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),v=await r.json();assert.ok(r.ok,`${path}: ${JSON.stringify(v)}`);return v;}
  async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},p=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:p.previewToken})).result;}
  async function click(text,scope='body'){
    const clicked=await evaluate(`(()=>{const roots=[...document.querySelectorAll(${JSON.stringify(scope)})],root=${JSON.stringify(scope)}==='dialog[open]'?roots.at(-1):roots[0];const b=[...root.querySelectorAll('button,summary')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.focus();b.click();return true;})()`);
    check(clicked,`visible action: ${text}`);
  }
  async function nav(text){
    const mobile=await evaluate(`getComputedStyle(document.querySelector('.personal-menu-button')).display!=='none'`);
    if(mobile){await evaluate(`document.querySelector('.personal-menu-button').focus();document.querySelector('.personal-menu-button').click()`);await waitFor(`!!document.querySelector('dialog[open] .personal-mobile-nav')`);}
    else if(!['开始使用','可用模型','在线使用','在线 Agent','我的额度'].includes(text))await click('更多⌄','.personal-header');
    await click(text,mobile?'dialog[open]':'.personal-header');
    await waitFor(`document.querySelector('h1')?.textContent===${JSON.stringify(text)}`);
  }
  async function field(label,value,scope='dialog[open]'){
    const selector=await evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(scope)}),l=[...root.querySelectorAll('label')].find(l=>l.firstChild?.textContent.replace(' *','').trim()===${JSON.stringify(label)});const control=l?.control??l?.querySelector('input,select,textarea');if(!control)return null;if(!control.id)control.id='discovery-field-'+Math.random().toString(36).slice(2);return '#'+CSS.escape(control.id);})()`);
    check(!!selector,`field exists: ${label}`);
    const tag=await evaluate(`document.querySelector(${JSON.stringify(selector)})?.tagName`);
    if(tag==='SELECT')await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    else check(await setInput(selector,value,tag==='TEXTAREA'?'HTMLTextAreaElement':'HTMLInputElement'),`field accepts: ${label}`);
    return selector;
  }
  const initial=await api('/api/v1/platform/state'),base=initial.definitions[0],service=initial.services[0],pool=initial.pools[0];
  const first=await command('save.definition',{...base,name:'本地·通用助手',vendor:'本地验收',capabilities:['text','tools','streaming'],maxOutputTokens:4096,description:'适合日常问答、文案整理与代码辅助。本地验收模型，不代表真实模型能力。'});
  const second=await command('save.definition',{name:'本地·分析助手',modelId:'analysis-model',vendor:'本地验收',capabilities:['text','vision'],contextTokens:131072,maxOutputTokens:8192,description:'适合长文梳理、材料分析与图文理解。本地验收模型，不执行真实推理。',active:true});
  const legacy=await command('save.definition',{name:'本地·待完善资料模型',modelId:'legacy-model',contextTokens:32768,active:true});
  await command('save.definition',{name:'未授权内部模型',modelId:'private-discovery-model',contextTokens:32768,active:true});
  const savedService=await command('save.service',{...service,mappings:[...service.mappings,...[second,legacy].map(d=>({...service.mappings[0],definitionId:d.id,upstreamModel:'test-model'}))]});
  await api(`/api/v1/platform/services/${service.id}/verify`,{});
  await command('save.pool',{...pool,entries:[...pool.entries,...[second,legacy].map(d=>({serviceId:service.id,definitionId:d.id,open:true}))]});
  const range={poolId:pool.id,mode:'follow',definitionIds:[]};
  const plan=await command('save.plan',{name:'模型发现验收方案',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:30});
  await command('distribution.execute',{operation:'open_plan',planId:plan.id,memberIds:[seeded.employeeId]});
  const project=await command('save.project',{name:'模型发现·项目用途',managerId:initial.actor.id,range:{poolId:pool.id,mode:'specific',definitionIds:[second.id]},initialAmount:1,validity:'permanent'});
  await command('project.members',{projectId:project.id,memberIds:[seeded.employeeId]});

  // Change a real public metadata field through the operator's existing editor.
  await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await waitFor(`!!document.querySelector('#v4-sidebar')`);
  await click('模型目录','#v4-sidebar');await waitFor(`document.querySelector('h1')?.textContent==='模型目录'`);
  await evaluate(`(()=>{const row=[...document.querySelectorAll('[data-page="catalog"] tbody tr')].find(r=>r.textContent.includes('本地·通用助手'));const b=[...row.querySelectorAll('button')].find(b=>b.textContent==='编辑模型定义');b.focus();b.click();})()`);
  await waitFor(`!!document.querySelector('dialog[open]')`);
  check(await evaluate(`!!document.querySelector('dialog[open] .multi-select-trigger')&&!document.querySelector('select[multiple]')`),'operator capabilities use contracted MultiSelect');
  await field('厂商','本地验收·已维护');
  await screenshot('operator-model-editor-1440.png');await setViewport(390,844);await screenshot('operator-model-editor-390.png');await setViewport(1440,1000);
  await click('继续','dialog[open]');await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some(h=>h.textContent==='保存模型定义')`);
  await click('确认执行','dialog[open]');await waitFor(`!document.querySelector('dialog[open]')`);
  check((await api('/api/v1/platform/state')).definitions.find(d=>d.id===first.id).vendor==='本地验收·已维护','operator metadata persists through preview and confirmation');
  await evaluate(`document.querySelector('button[aria-label="退出登录"]').click()`);await login('web-employee',seeded.employeePassword);
  for(const mode of ['beacon','azure','sidebar','next','classic']){
    await cdp.send('Page.navigate',{url:`${web}/?ui=${mode}`});await waitFor(`!!document.querySelector('.personal-header')`);
    for(const width of [1440,390]){
      await setViewport(width,width===390?844:1000);await nav('可用模型');await waitFor(`document.querySelectorAll('.model-card').length===3`);
      check(await evaluate(`!document.querySelector('#v4-sidebar,#v3-sidebar,.rail,.v4-tabbar,.v3-tabbar')`),`${mode} ${width}: personal space has no duplicate sidebar or page tabs`);
      check(await evaluate(`document.documentElement.scrollWidth===document.documentElement.clientWidth`),`${mode} ${width}: no page overflow`);
      check(await evaluate(`document.querySelector('[data-page="available"]').innerText.includes('本地验收·已维护')&&!document.querySelector('[data-page="available"]').innerText.includes('未授权内部模型')`),`${mode} ${width}: metadata is visible and ungranted models remain hidden`);
      if(mode==='beacon')await screenshot(`available-models-${width}.png`);else await screenshot(`${mode}-available-${width}.png`);
      if(width===390){
        await cdp.send('Page.bringToFront');
        await evaluate(`document.querySelector('.personal-menu-button').focus()`);await pressKey('Enter');
        await waitFor(`!!document.querySelector('dialog[open] .personal-mobile-nav')`);
        check(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`),`${mode}: mobile menu receives focus`);
        await evaluate(`(()=>{const buttons=document.querySelector('dialog[open]').querySelectorAll('button');buttons[buttons.length-1].focus();})()`);await pressKey('Tab');
        check(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`),`${mode}: Tab remains in mobile menu`);
        if(mode==='beacon')await screenshot('personal-menu-390.png');
        await pressKey('Escape');await waitFor(`!document.querySelector('dialog[open]')`);
        check(await evaluate(`document.activeElement===document.querySelector('.personal-menu-button')`),`${mode}: Escape returns focus to menu button`);
      }
    }
  }
  await setViewport(1440,1000);await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await waitFor(`!!document.querySelector('.personal-header')`);await nav('可用模型');
  await evaluate(`document.querySelector('.personal-more summary').focus()`);await pressKey('Enter');await waitFor(`document.querySelector('.personal-more').open`);
  check(await evaluate(`document.querySelector('.personal-more nav').getClientRects().length>0`),'desktop More opens from keyboard');
  await pressKey('Escape');
  check(await evaluate(`!document.querySelector('.personal-more').open&&document.activeElement===document.querySelector('.personal-more summary')`),'desktop More Escape closes and returns focus');
  await nav('我的申请');await nav('可用模型');
  await field('搜索模型','analysis-model','[data-page="available"]');await waitFor(`document.querySelectorAll('.model-card').length===1`);
  check(await evaluate(`document.querySelector('.model-card').textContent.includes('本地·分析助手')`),'search filters by model identifier');
  await field('接入能力','tools','[data-page="available"]');await waitFor(`document.querySelectorAll('.model-card').length===0`);
  check(await evaluate(`document.querySelector('[data-page="available"]').innerText.includes('没有符合条件的模型')`),'search and capability filters compose and show recoverable empty state');
  await click('清除筛选','[data-page="available"]');await waitFor(`document.querySelectorAll('.model-card').length===3`);
  await field('接入能力','vision','[data-page="available"]');await waitFor(`document.querySelectorAll('.model-card').length===1`);
  await click('查看详情','.model-card');await waitFor(`!!document.querySelector('dialog[open]')`);
  check(await evaluate(`document.querySelector('dialog[open]').innerText.includes('131,072')&&document.querySelector('dialog[open]').innerText.includes('8,192')`),'detail displays context and separate maximum output reference');
  await screenshot('available-model-detail-1440.png');await setViewport(390,844);await screenshot('available-model-detail-390.png');await pressKey('Escape');await setViewport(1440,1000);
  await click('使用此模型','.model-card');await waitFor(`document.querySelector('h1')?.textContent==='在线使用'`);
  const selected=()=>evaluate(`(()=>{const s=[...document.querySelectorAll('[data-page="online"] select')].find(s=>[...s.options].some(o=>o.value==='analysis-model'));return s?.value;})()`);
  await waitFor(`!![...document.querySelectorAll('[data-page="online"] select')].find(s=>s.value==='analysis-model')`);
  check(await selected()==='analysis-model','card selects the requested model on first online visit');
  await setInput('[data-page="online"] textarea','保留这份输入草稿','HTMLTextAreaElement');
  await nav('可用模型');await click('清除筛选','[data-page="available"]');
  await evaluate(`(()=>{const c=[...document.querySelectorAll('.model-card')].find(c=>c.textContent.includes('test-model'));[...c.querySelectorAll('button')].find(b=>b.textContent==='使用此模型').click();})()`);
  await waitFor(`!![...document.querySelectorAll('[data-page="online"] select')].find(s=>s.value==='test-model')`);
  check(await evaluate(`document.querySelector('[data-page="online"] textarea').value==='保留这份输入草稿'`),'selecting another model preserves mounted online draft');
  await field('模型','analysis-model','[data-page="online"]');await nav('可用模型');
  await evaluate(`(()=>{const c=[...document.querySelectorAll('.model-card')].find(c=>c.textContent.includes('test-model'));[...c.querySelectorAll('button')].find(b=>b.textContent==='使用此模型').click();})()`);
  await waitFor(`!![...document.querySelectorAll('[data-page="online"] select')].find(s=>s.value==='test-model')`);
  check(true,'repeated card selection overrides a manual model choice in an already mounted online page');
  await nav('可用模型');await field('使用用途',project.id,'[data-page="available"]');await waitFor(`document.querySelectorAll('.model-card').length===1`);
  check(await evaluate(`document.querySelector('.model-card').innerText.includes('无有效额度')&&!document.querySelector('.model-card .primary')`),'project no-quota model remains visible without a use action');
  await click('查看额度','.model-card');await waitFor(`document.querySelector('h1')?.textContent==='我的额度'`);
  check(await evaluate(`document.querySelector('[data-page="quota"] select').value===${JSON.stringify(project.id)}`),'quota action retains the selected project purpose');
  await nav('可用模型');await field('使用用途','personal','[data-page="available"]');await waitFor(`document.querySelectorAll('.model-card').length===3`);
  check(await evaluate(`document.querySelector('[data-page="available"]').innerText.includes('厂商未维护')&&document.querySelector('[data-page="available"]').innerText.includes('接入能力未维护')`),'legacy metadata is explicitly unknown');
  await command('save.service',{...savedService,active:false});await click('刷新模型','[data-page="available"]');await waitFor(`document.querySelectorAll('.model-card').length===3&&![...document.querySelectorAll('.model-card button')].some(b=>b.textContent==='使用此模型')`);
  check(await evaluate(`[...document.querySelectorAll('.model-card')].every(c=>c.innerText.includes('模型暂不可用'))`),'source outage retains authorized cards with a clear blocked reason');
  await command('save.service',{...savedService,active:true});await api(`/api/v1/platform/services/${service.id}/verify`,{});await click('刷新模型','[data-page="available"]');await waitFor(`!!document.querySelector('.model-card .primary')`);
  // Deterministic browser failure fixtures, restored immediately after each check.
  await evaluate(`window.__discoveryFetch=window.fetch;window.fetch=(url,...args)=>String(url).endsWith('/platform/state')?Promise.reject(new Error('fixture refresh failure')):window.__discoveryFetch(url,...args)`);
  await click('刷新模型','[data-page="available"]');await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('模型数据未能刷新')`);
  check(await evaluate(`document.querySelectorAll('.model-card').length===3`),'refresh failure retains prior cards');await evaluate(`window.fetch=window.__discoveryFetch;delete window.__discoveryFetch`);
  await click('刷新模型','[data-page="available"]');await waitFor(`!document.querySelector('[data-page="available"] [role="alert"]')&&!document.querySelector('.notice[role="status"]')?.textContent.includes('连接已中断')`);
  check(true,'successful refresh clears both local and workspace connection errors');
  await evaluate(`window.__discoveryWrite=Object.getOwnPropertyDescriptor(navigator.clipboard,'writeText');Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:()=>Promise.reject(new Error('fixture denied'))})`);
  await click('复制','.model-card');await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('复制失败')`);check(true,'clipboard failure has a usable manual-copy recovery');
  await evaluate(`if(window.__discoveryWrite)Object.defineProperty(navigator.clipboard,'writeText',window.__discoveryWrite);else delete navigator.clipboard.writeText;delete window.__discoveryWrite`);
  await evaluate(`window.__discoveryWrite=Object.getOwnPropertyDescriptor(navigator.clipboard,'writeText');Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:value=>{window.__copiedModel=value;return Promise.resolve();}})`);
  await click('复制','.model-card');await waitFor(`document.querySelector('[data-page="available"] [role="status"]')?.textContent.includes('已复制模型标识')`);
  check(await evaluate(`window.__copiedModel==='test-model'`),'clipboard success reports the selected model identifier (isolated clipboard fixture)');
  await evaluate(`if(window.__discoveryWrite)Object.defineProperty(navigator.clipboard,'writeText',window.__discoveryWrite);else delete navigator.clipboard.writeText;delete window.__discoveryWrite;delete window.__copiedModel`);
  for(const width of [320,360,736,1024,1440]){await setViewport(width,width<900?844:1000);check(await evaluate(`document.documentElement.scrollWidth===document.documentElement.clientWidth`),`personal model page has no overflow at ${width}`);}
  await command('save.member',{name:'尚未开通用户',directoryId:'discovery-unopened',organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[],active:true,password:seeded.employeePassword});
  await evaluate(`document.querySelector('button[aria-label="退出登录"]').click()`);await login('discovery-unopened',seeded.employeePassword);await nav('可用模型');
  check(await evaluate(`!document.querySelector('.model-card')&&document.querySelector('[data-page="available"]').innerText.includes('尚未开通当前用途')`),'unopened user sees a clear empty state and quota entry');
  await screenshot('available-models-unopened-1440.png');
  check(cdp.runtimeErrors.length===0,`no browser runtime errors: ${cdp.runtimeErrors.join(' | ')}`);
}
