import {choosePerson} from './lib/person-picker-ui.mjs';
import {createServer} from 'node:http';

// Business writes go through the visible forms, their native validation and confirmation.
// API reads below only verify persisted results; the runner owns all fixtures and ports.
export async function checkProviderOnboarding({cp,gateway,model,web,seeded,cdp,evaluate,waitFor,pressKey,setViewport,screenshot,login,check}){
  const q=JSON.stringify;
  const dialog=`[...document.querySelectorAll('dialog[open]')].at(-1)`;
  const page=`document.querySelector('.page [data-page]:not([hidden])')??document.querySelector('.page')`;
  async function click(label,scope='page',rowText){
    const root=scope==='dialog'?dialog:rowText?`[...(${page}).querySelectorAll('tbody tr')].find(row=>row.textContent.includes(${q(rowText)}))`:page;
    await evaluate(`(()=>{const root=${root};const el=[...root.querySelectorAll('button,a,summary')].find(el=>el.getClientRects().length&&el.textContent.trim()===${q(label)});if(!el||el.disabled)throw Error('Missing or disabled action: '+${q(label)});el.scrollIntoView({block:'center',behavior:'instant'});el.focus();el.click();})()`);
  }
  async function field(label,value){
    await evaluate(`(()=>{const root=${dialog};const l=[...root.querySelectorAll('label')].find(l=>l.textContent.replace(/\\s*\\*$/,'').trim()===${q(label)});if(!l)throw Error('Missing field: '+${q(label)});const el=document.getElementById(l.htmlFor);const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${q(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  }
  async function multi(label,option){
    const id=await evaluate(`(()=>{const root=${dialog};const l=[...root.querySelectorAll('label')].find(l=>l.textContent.replace(/\\s*\\*$/,'').trim()===${q(label)});if(!l)throw Error('Missing multiselect: '+${q(label)});const el=document.getElementById(l.htmlFor);el.focus();el.click();return l.htmlFor;})()`);
    await waitFor(`!!document.getElementById(${q(id)})?.closest('.multi-select').querySelector('[role="listbox"]')`);
    await evaluate(`(()=>{const root=document.getElementById(${q(id)}).closest('.multi-select');const el=[...root.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes(${q(option)}));if(!el)throw Error('Missing option: '+${q(option)});el.click();})()`);
    await pressKey('Escape');
  }
  async function nav(label){
    await evaluate(`(()=>{const menu=document.querySelector('.v4-menu-button,.v3-menu-button');if(menu?.getClientRects().length)menu.click();const el=[...document.querySelectorAll('nav button')].find(el=>el.textContent.trim()===${q(label)});if(!el)throw Error('Missing navigation: '+${q(label)});el.click();})()`);
    await waitFor(`document.querySelector('h1')?.textContent===${q(label)}`);
  }
  async function save(label='继续'){
    await click(label,'dialog');
    await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
    const confirm=await evaluate(`${dialog}.querySelector('.modal-footer button:last-child').textContent`);
    await click(confirm,'dialog');
  }
  async function state(){return evaluate(`fetch(${q(cp+'/api/v1/platform/state')},{credentials:'include'}).then(r=>r.json())`);}
  async function closed(){await waitFor(`!document.querySelector('dialog[open]')`);}
  async function title(value){await waitFor(`${dialog}?.querySelector('h2')?.textContent===${q(value)}`);}
  const value=label=>evaluate(`(()=>{const l=[...(${dialog}).querySelectorAll('label')].find(l=>l.textContent.replace(/\\s*\\*$/,'').trim()===${q(label)});return l?document.getElementById(l.htmlFor)?.value:null;})()`);
  const secret='ui-onboarding-local-fixture-only',authorized=[];
  const upstream=createServer(async(req,res)=>{
    try{
      if(req.headers.authorization!==`Bearer ${secret}`){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":{"message":"local fixture requires managed credential"}}');return;}
      authorized.push(req.url);
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await fetch(model+req.url,{method:req.method,headers:{'content-type':req.headers['content-type']??'application/json'},...(chunks.length?{body:Buffer.concat(chunks)}:{})});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});res.end(await response.text());
    }catch{res.writeHead(502);res.end();}
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const upstreamUrl=`http://127.0.0.1:${upstream.address().port}`;
  try{
  await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});
  await waitFor(`document.documentElement.dataset.ui==='beacon'&&!!document.querySelector('#v4-sidebar')`);
  await nav('供应商');
  await click('创建上游凭据');await title('创建上游凭据');
  await field('凭据名称','其他供应商的凭据');await field('供应商凭据值','unrelated-local-fixture');
  await save('保存上游凭据');await closed();
  await click('创建供应商');await title('创建供应商');
  await field('供应商名称','浏览器接入供应商');await field('默认服务地址',upstreamUrl);
  await save();await closed();
  const provider=(await state()).providers.find(p=>p.name==='浏览器接入供应商');
  check(!!provider,'supplier is created through the UI and persists in PostgreSQL');
  await click('详情 ›','page',provider.name);await waitFor(`(${page}).innerText.includes('接入类型与确认状态')`);
  await click('接入服务');await title('接入模型服务');
  await field('服务名称','浏览器完整接入服务');
  check(await value('服务地址')===upstreamUrl&&await value('供应商')===provider.id,'supplier row preselects the supplier and its default address');
  await field('身份验证方式','managed');
  check(await value('身份验证方式')==='managed','managed credential selection is available for onboarding');
  check(await evaluate(`!(${dialog}).innerText.includes('服务端环境变量名称')&&!(${dialog}).innerText.includes('其他供应商的凭据')`),'environment reference is hidden and unrelated credentials are filtered out');
  await click('新建上游凭据，完成后返回','dialog');await title('创建上游凭据');
  check(await value('所属供应商')===provider.id,'inline credential creation inherits the selected supplier');
  await pressKey('Escape');await title('接入模型服务');
  check(await value('服务名称')==='浏览器完整接入服务','cancelling inline credential creation restores the service draft');
  await click('新建上游凭据，完成后返回','dialog');await title('创建上游凭据');
  await field('凭据名称','闭环托管凭据');await field('供应商凭据值',secret);
  check(await evaluate(`(${dialog}).querySelector('input[autocomplete="new-password"]').type==='password'`),'supplier secret is masked by default');
  await save('保存上游凭据');await title('接入模型服务');
  const credential=(await state()).upstreamCredentials.find(c=>c.name==='闭环托管凭据');
  check(await value('托管上游凭据')===credential.id&&await value('服务名称')==='浏览器完整接入服务','saved credential is selected automatically while preserving service draft');
  await field('供应商','openai-compatible');
  check(await value('托管上游凭据')==='','switching suppliers clears a credential that belongs to the old supplier');
  await field('供应商',provider.id);await field('托管上游凭据',credential.id);
  await click('保存模型服务','dialog');
  await waitFor(`${dialog}.querySelector('[role="alert"]')?.textContent.includes('至少一个提供的模型')`);
  check(true,'missing model selection is explained without leaving the service form');
  await click('新建模型定义，完成后返回','dialog');await title('创建模型定义');
  await field('显示名称','浏览器闭环模型');await field('对外模型标识','ui-onboarding-model');
  await save();await title('接入模型服务');
  check(await evaluate(`(${dialog}).querySelector('.multi-select-trigger')?.innerText.includes('浏览器闭环模型')`),'new model is automatically selected when returning to the service draft');
  await field('浏览器闭环模型 · 上游标识','test-model');
  for(const [kind,price] of [['输入','2'],['输出','3'],['缓存输入','0.5']])await field(`浏览器闭环模型 · ${kind}基准价（元 / 百万 Token）`,price);
  await click('保存模型服务','dialog');
  check(await evaluate(`(()=>{const root=${dialog};const costs=[...root.querySelectorAll('label')].filter(l=>l.textContent.includes('成本价（元 / 百万 Token）')).map(l=>document.getElementById(l.htmlFor));return costs.length===3&&costs.every(el=>el.required&&el.validity.valueMissing)&&costs.includes(document.activeElement)&&document.querySelectorAll('dialog[open]').length===1;})()`),'empty upstream costs block service saving and focus a required cost field even when billing prices are filled');
  for(const [kind,price] of [['输入','1'],['输出','2'],['缓存输入','0']])await field(`浏览器闭环模型 · ${kind}成本价（元 / 百万 Token）`,price);
  await field('身份验证方式','environment');await field('服务端环境变量名称','sk-incorrect-place');
  await click('保存模型服务','dialog');
  await waitFor(`${dialog}.querySelector('[role="alert"]')?.textContent.includes('环境变量名称必须以 UPSTREAM_')`);
  check(true,'a raw secret cannot accidentally be submitted as an environment reference');
  await field('身份验证方式','managed');
  await screenshot('service-editor-1440.png');
  await save('保存模型服务');
  // A saved top-level service must finish the editor; verification is a separate action.
  await closed();
  check(true,'saving a service closes the editor and all confirmation dialogs');
  await waitFor(`[...document.querySelectorAll('.page .notice[role="status"]')].some(el=>{const r=el.getBoundingClientRect();return el.textContent.includes('保存成功')&&r.top>=0&&r.bottom<=innerHeight;})`);
  check(true,'successful save brings the nonblocking result and verification next step into the viewport');
  let snapshot=await state(),service=snapshot.services.find(s=>s.name==='浏览器完整接入服务');
  check(service.credentialId===credential.id&&service.credentialRef===null&&service.verification!=='passed','only the selected authentication method persists; saving does not silently validate or generate');
  check(!JSON.stringify(snapshot).includes(secret),'workspace snapshots never reveal the managed credential secret');
  await screenshot('service-saved-1440.png');
  await evaluate(`[...document.querySelectorAll('.notice button')].find(el=>el.textContent==='前往验证连接').click()`);await waitFor(`document.querySelector('h1')?.textContent==='模型服务'`);
  // An authentication failure must preserve the service and allow correction.
  await click('编辑服务与价格','page',service.name);await title('编辑模型服务');
  await field('身份验证方式','none');await save('保存模型服务');await closed();
  await click('验证连接','page',service.name);
  await waitFor(`(${page}).innerText.includes('模型连接尚未确认可用')`,25000);
  check((await state()).services.find(s=>s.id===service.id).verification==='failed','failed connection verification retains a saved editable service');
  await click('修改本次服务配置');await title('编辑模型服务');
  await field('身份验证方式','managed');await field('托管上游凭据',credential.id);
  await save('保存模型服务');await closed();await click('验证连接','page',service.name);
  await waitFor(`fetch(${q(cp+'/api/v1/platform/state')},{credentials:'include'}).then(r=>r.json()).then(s=>s.services.find(v=>v.id===${q(service.id)}).verification==='passed')`,25000);
  check(authorized.length>=3,'connection verification authenticates to the local upstream with the managed credential');
  await click('验证记录','page',service.name);await title('连接验证记录');
  check(await evaluate(`(${dialog}).querySelectorAll('tbody tr').length>=2`),'verification history contains both failed and successful runs');
  await pressKey('Escape');await closed();
  await nav('模型池');await click('创建模型池');await title('创建模型池');
  await field('模型池名称','浏览器闭环模型池');await multi('纳入的模型服务',service.name);
  await evaluate(`(()=>{const s=[...(${dialog}).querySelectorAll('summary')].find(s=>s.textContent.includes('模型开放状态'));if(!s.parentElement.open)s.click();})()`);
  await field(`${service.name} · 浏览器闭环模型`,'yes');await save();await closed();
  const pool=(await state()).pools.find(p=>p.name==='浏览器闭环模型池');
  check(pool.entries.some(e=>e.serviceId===service.id&&e.open),'verified service is added to a new pool and explicitly opened through the UI');
  await nav('开通方案');await click('新建方案');await title('创建个人开通方案');
  await field('方案名称','浏览器闭环开通方案');await field('模型池',pool.id);await field('每次发放金额（CNY）','20');
  await save('保存开通方案');await closed();await nav('为人员开通');
  await choosePerson({evaluate,waitFor},'选择开通人员',{directoryId:'web-employee'});
  await click('下一步：选择方案（1 人）');
  await evaluate(`[...document.querySelectorAll('.plan-choice')].find(el=>el.textContent.includes('浏览器闭环开通方案')).querySelector('input').click()`);
  await click('预览名单与金额');await waitFor(`!!document.querySelector('dialog[open]')`);await click('确认执行','dialog');await closed();
  await waitFor(`(${page}).innerText.includes('下一步：让同事登录后选择')`);
  check((await state()).entitlements.some(e=>e.memberId===seeded.employeeId&&e.planSnapshot.name==='浏览器闭环开通方案'),'onboarding grants the new pool entitlement to the selected employee');
  await screenshot('employee-onboarding-receipt-1440.png');
  // Nested pool -> service creation must retain its existing verify-and-return path.
  await nav('模型池');await click('创建模型池');await field('模型池名称','应保留的父表单草稿');
  await click('新建模型服务并验证，完成后返回','dialog');await title('接入模型服务');
  await field('服务名称','嵌套补充服务');await field('服务地址',model);await field('身份验证方式','none');
  await multi('提供的模型','浏览器闭环模型');await field('浏览器闭环模型 · 上游标识','test-model');
  for(const kind of ['输入','输出','缓存输入'])await field(`浏览器闭环模型 · ${kind}成本价（元 / 百万 Token）`,'0');
  await save('保存模型服务');await title('模型服务已保存，下一步验证连接');
  await click('验证连接并返回上一步','dialog');await title('创建模型池');
  check(await value('模型池名称')==='应保留的父表单草稿'&&await evaluate(`(${dialog}).querySelector('.multi-select-trigger').innerText.includes('嵌套补充服务')`),'nested service verification restores and fills the parent pool without losing its draft');
  await pressKey('Escape');await closed();
  for(const mode of ['beacon','azure','sidebar','next','classic']){
    await cdp.send('Page.navigate',{url:web+'/?ui='+mode});await waitFor(`!!document.querySelector('h1')`);
    for(const width of [1440,390]){
      await setViewport(width,width===390?844:1000);await nav('供应商');
      check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`${mode} ${width}: supplier page has no horizontal overflow`);
      if(mode==='beacon')await screenshot(`providers-${width}.png`);
      await click('详情 ›','page',provider.name);await waitFor(`(${page}).innerText.includes('接入类型与确认状态')`);
      check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`${mode} ${width}: supplier detail has no horizontal overflow`);
      if(mode==='beacon')await screenshot(`provider-detail-${width}.png`);
      await click('编辑服务','page',service.name);await title('编辑模型服务');
      check(await value('托管上游凭据')===credential.id,`${mode} ${width}: existing service restores its authentication selection`);
      check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`${mode} ${width}: service editor has no horizontal overflow`);
      if(mode==='beacon')await screenshot(`service-editor-${width}.png`);
      await evaluate(`${dialog}.querySelector('.modal-footer button:last-child').focus()`);await pressKey('Tab');
      check(await evaluate(`(${dialog}).contains(document.activeElement)`),`${mode} ${width}: Tab remains in the editor`);
      await pressKey('Escape');await closed();
      check(await evaluate(`document.activeElement?.textContent==='编辑服务'`),`${mode} ${width}: Escape restores focus to the service opener`);
    }
  }
  await setViewport(1440,1000);
  await evaluate(`(document.querySelector('button[aria-label="退出登录"]')??[...document.querySelectorAll('button')].find(el=>el.textContent==='退出登录')).click()`);
  await login('web-employee',seeded.employeePassword);
  await evaluate(`[...document.querySelectorAll('.personal-header nav button')].find(el=>el.textContent.includes('在线使用')).click()`);
  await waitFor(`!!document.querySelector('textarea[placeholder]')`);
  await evaluate(`(()=>{const root=${page},el=[...root.querySelectorAll('select')].find(el=>[...el.options].some(o=>o.value==='ui-onboarding-model'));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'ui-onboarding-model');el.dispatchEvent(new Event('change',{bubbles:true}));const input=root.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'provider onboarding browser end to end');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(`[...(${page}).querySelectorAll('button')].some(el=>el.textContent==='发送'&&!el.disabled)`);
  await click('发送');await waitFor(`(${page}).querySelector('.console-bubble.is-assistant p')?.textContent.trim().length>3&&![...(${page}).querySelectorAll('button')].some(el=>el.textContent==='取消请求')`,25000);
  check(authorized.some(path=>path.includes('chat/completions')),'employee online use sends an actual authenticated request through the newly onboarded service');
  await screenshot('employee-online-1440.png');
  await evaluate(`[...document.querySelectorAll('.personal-header nav button')].find(el=>el.textContent.includes('调用记录')).click()`);
  await waitFor(`[...(${page}).querySelectorAll('tbody tr')].some(row=>row.innerText.includes('浏览器闭环模型')&&row.innerText.includes('已结算'))`);
  const calls=await evaluate(`fetch(${q(cp+'/api/v1/platform/calls/query')},{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json())`);
  const call=calls.items.find(call=>call.modelId==='ui-onboarding-model');
  check(call?.billableState==='confirmed'&&call.actualAmount>0&&call.admission.route.serviceId===service.id,'employee call log persists the new service route and actual positive settled cost');
  await screenshot('employee-calls-1440.png');
  await evaluate(`(()=>{const more=document.querySelector('.personal-more');if(more)more.open=true;[...document.querySelectorAll('.personal-header nav button')].find(el=>el.textContent.includes('密钥')).click();})()`);
  await waitFor(`document.querySelector('h1')?.textContent==='密钥与接入'`);
  await click('签发密钥');await title('签发用途密钥');await field('密钥名称','闭环工具接入密钥');
  await save();await title('请保存完整密钥');
  const issued=await evaluate(`document.getElementById('issued-api-key').value`);
  check(await evaluate(`document.getElementById('issued-api-key').type==='password'`),'new API key is only shown once and stays masked by default');
  await click('我已保存，查看接入指引','dialog');await title('编程工具接入');await pressKey('Escape');await closed();
  const keyResponse=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+issued},body:JSON.stringify({model:'ui-onboarding-model',messages:[{role:'user',content:'UI issued key local fixture'}],max_tokens:8})});
  check(keyResponse.status===200,'API key issued in the UI performs an actual authorized gateway call');await keyResponse.text();
  await click('停用','page','闭环工具接入密钥');await title('调整密钥状态');await field('处理原因','浏览器闭环验证停用');await save();await closed();
  const disabledResponse=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+issued},body:JSON.stringify({model:'ui-onboarding-model',messages:[{role:'user',content:'disabled key must be rejected'}],max_tokens:8})});
  check(disabledResponse.status===401||disabledResponse.status===403,'disabling the same key in the UI immediately blocks new calls');await disabledResponse.text();
  check(cdp.runtimeErrors.length===0,`complete onboarding workflow has no uncaught browser exceptions: ${cdp.runtimeErrors.join(' | ')}`);
  }finally{await new Promise(resolve=>upstream.close(resolve));}
}
