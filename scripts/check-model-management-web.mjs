import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Uses check-web's isolated services, fixture model and automation-owned Chrome.
export async function checkModelManagement({cp,web,seeded,cdp,evaluate,waitFor,clickExact,setInput,pressKey,setViewport,screenshot,check,login}){
  const loginResponse=await fetch(`${cp}/api/v1/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({directoryId:'web-ops',password:seeded.adminPassword})});
  assert.ok(loginResponse.ok);
  const cookie=loginResponse.headers.get('set-cookie').split(';')[0];
  async function api(path,body){
    const response=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),value=await response.json();
    assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(value)}`);return value;
  }
  async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:preview.previewToken})).result;}
  const initial=await api('/api/v1/platform/state'),service=initial.services[0],pool=initial.pools[0];
  await command('settings.update',{limits:{mode:'custom',rpm:120,tpm:20000,concurrency:20}});
  await command('save.service',{...service,sharedCapacityId:'shared-browser-fixture',limits:{mode:'inherit'},mappings:service.mappings.map(m=>({...m,limits:{mode:'custom',rpm:90}}))});
  const second=await command('save.service',{...service,id:undefined,name:'共享来源 B',sharedCapacityId:'shared-browser-fixture',limits:{mode:'inherit'}});
  await api(`/api/v1/platform/services/${second.id}/verify`,{});
  await command('save.pool',{...pool,entries:[...pool.entries,{...pool.entries[0],serviceId:second.id}],limits:{mode:'custom',concurrency:8}});
  const expected=await api('/api/v1/platform/state');
  const visibleText=()=>evaluate(`document.querySelector('.page [data-page]:not([hidden])')?.innerText??document.querySelector('.page')?.innerText??''`);
  async function nav(label){
    // Exercise the actual drawer when the side menu is off canvas.
    await evaluate(`(()=>{const b=document.querySelector('.v4-menu-button,.v3-menu-button');if(b&&b.getClientRects().length)b.click();})()`);
    const found=await evaluate(`(()=>{const e=[...document.querySelectorAll('nav[aria-label="模型管理"] button,.rail .nav-group button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)return false;e.click();return true;})()`);
    check(found,`model menu opens: ${label}`);
    await waitFor(`document.querySelector('h1')?.textContent===${JSON.stringify(label)}`);
  }
  async function closeModal(){await pressKey('Escape');await waitFor(`!document.querySelector('dialog[open]')`);}
  async function pageClick(label){
    const clicked=await evaluate(`(()=>{const e=[...document.querySelectorAll('.page button,.page summary')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(label)});if(!e)return false;e.focus();e.click();return true;})()`);
    check(clicked,`page action exists: ${label}`);
  }
  const modes=['beacon','azure','sidebar','next','classic'];
  for(const mode of modes){
    await cdp.send('Page.navigate',{url:`${web}/?ui=${mode}`});
    await waitFor(`document.documentElement.dataset.ui===${JSON.stringify(mode==='sidebar'?'next':mode)}&&!!document.querySelector('nav[aria-label="模型管理"],.rail .nav-group')`);
    for(const width of [1440,390]){
      await setViewport(width,width===390?844:1000);
      for(const [label,id] of [['模型服务','models'],['模型池','pools'],['容量与保护','capacity']]){
        await nav(label);
        check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`${mode} ${label} ${width}: no page overflow`);
        if(mode==='beacon')await screenshot(`model-${id}-${width}.png`);
        else if(id==='capacity')await screenshot(`${mode}-capacity-${width}.png`);
        if(label==='模型服务'){
          check((await visibleText()).includes('首次接入引导'),'first-use guide remains available');
          check(await evaluate(`!![...document.querySelectorAll('.page button')].find(e=>e.getClientRects().length&&e.textContent.trim()==='验证连接')`),'verification is directly available without configuration tabs');
        }
        if(label==='模型池')check((await visibleText()).includes('2 个服务 / 1 个模型'),'pool counts multiple services and deduplicates logical models');
        if(label==='容量与保护'){
          const text=await visibleText();
          check(text.includes('RPM 120')&&text.includes('RPM 90')&&text.includes('并发 8'),'capacity displays inherited and custom limits');
          check(text.includes('shared-browser-fixture')&&text.includes('共享来源 B'),'shared capacity group shows its member services');
          check(text.includes('当前不支持按组单独设置上限'),'shared limits are described without inventing group capacity');
        }
      }
    }
    await setViewport(1440,1000);
    await nav('容量与保护');
    await pageClick('编辑服务保护');
    await waitFor(`!!document.querySelector('dialog[open]')`);
    await pressKey('Tab');
    check(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`),`${mode}: keyboard stays inside editor`);
    await closeModal();
    check(await evaluate(`document.activeElement?.textContent==='编辑服务保护'`),`${mode}: Escape returns to the opener`);
  }
  await cdp.send('Page.navigate',{url:`${web}/?ui=beacon`});
  await waitFor(`!!document.querySelector('#v4-sidebar')`);
  await nav('模型池');
  await pageClick('创建模型池');
  await waitFor(`!!document.querySelector('dialog[open]')`);
  // Fields explicitly render type="text".
  const textSelector='dialog[open] input[type="text"]';
  check(await setInput(textSelector,'保留的模型池草稿'),'pool name accepts a draft');
  check(await evaluate(`!!document.querySelector('dialog[open] .multi-select')`),'pool uses the contracted MultiSelect');
  await clickExact('新建模型服务并验证，完成后返回');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent==='接入模型服务'`);
  await pressKey('Escape');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent==='创建模型池'`);
  check(await evaluate(`document.querySelector(${JSON.stringify(textSelector)})?.value==='保留的模型池草稿'`),'nested service cancellation restores the parent pool draft');
  await closeModal();
  await nav('模型服务');
  await pageClick('验证连接');
  await waitFor(`document.body.innerText.includes('最近一次连接验证')`,25000);
  await pageClick('查看逐协议诊断');
  await waitFor(`document.querySelector('dialog[open]')?.innerText.includes('上游请求号')`);
  await closeModal();
  await pageClick('验证记录');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent==='连接验证记录'`);
  await closeModal();
  await nav('容量与保护');
  await pageClick('编辑模型池保护');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent==='调整模型池'`);
  await closeModal();
  await pageClick('调整企业默认保护');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent==='企业默认使用保护'`);
  const limitSelector=await evaluate(`(()=>{const label=[...document.querySelectorAll('dialog[open] label')].find(e=>e.textContent==='每分钟请求数（RPM）');return label?'#'+CSS.escape(label.htmlFor):null;})()`);
  check(!!limitSelector,'default RPM field exists');await setInput(limitSelector,'121');
  await clickExact('继续');
  await waitFor(`!![...document.querySelectorAll('dialog[open] button')].find(e=>e.textContent==='确认保存设置')`);
  await clickExact('确认保存设置');await waitFor(`!document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('[data-page="capacity"]')?.innerText.includes('RPM 121')`);
  check(true,'saving default protection refreshes inherited limits on the capacity page');
  const after=await api('/api/v1/platform/state');
  assert.deepEqual(after.pools,expected.pools);
  assert.deepEqual(after.services.map(({verifiedAt,verificationMessage,protocolCapabilities,...s})=>s),expected.services.map(({verifiedAt,verificationMessage,protocolCapabilities,...s})=>s));
  check(true,'navigation, editor cancellation and protection changes preserve model relations and service configuration');
  await nav('模型目录');
  await pageClick('编辑模型定义');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent==='编辑模型定义'`);
  await closeModal();
  await pageClick(initial.definitions[0].name);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent==='模型详情'`);
  await closeModal();
  // Exercise command-palette navigation with the keyboard.
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`);
  await waitFor(`!!document.querySelector('.palette')`);
  await setInput('.palette input','容量与保护');
  await pressKey('Enter');
  await waitFor(`document.querySelector('h1')?.textContent==='容量与保护'&&!document.querySelector('.palette')`);
  check(true,'command palette opens the independent capacity page');
  const logout=await evaluate(`(()=>{const b=document.querySelector('button[aria-label="退出登录"]');b?.click();return !!b;})()`);check(logout,'logout is available');
  await login('web-employee',seeded.employeePassword);
  check(await evaluate(`!document.querySelector('nav[aria-label="模型管理"]')&&!document.querySelector('button[aria-label="关闭容量与保护"]')`),'employee space does not expose operations model pages');
  check(cdp.runtimeErrors.length===0,`no uncaught browser errors: ${cdp.runtimeErrors.join(' | ')}`);
}
