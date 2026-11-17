import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Isolated check-web workspace only. Real local fixture traffic; never external models. */
export async function checkBillingReports({cp,gateway,web,seeded,cdp,evaluate,waitFor,clickNav,clickExact,setInput,pressKey,setViewport,screenshot,login,check}){
  const assertions=[],record=check;check=(value,message)=>{record(value,message);assertions.push(message);};
  await setViewport(1440,1000);
  const request=async(path,body)=>evaluate(`(async()=>{const r=await fetch(${JSON.stringify(cp)}+${JSON.stringify(path)},{method:${JSON.stringify(body===undefined?'GET':'POST')},credentials:'include',headers:{'content-type':'application/json'},body:${body===undefined?'undefined':JSON.stringify(JSON.stringify(body))}});return {status:r.status,body:await r.json()};})()`);
  const api=async(path,body)=>{const result=await request(path,body);assert.equal(result.status,200,`${path}: ${JSON.stringify(result.body)}`);return result.body;};
  const command=async(type,payload)=>{const input={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',input);return (await api('/api/v1/platform/commands',{...input,previewToken:preview.previewToken})).result;};
  await request('/api/v1/auth/logout',{});await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await login('web-ops',seeded.adminPassword);
  const state=await api('/api/v1/platform/state'),definition=state.definitions[0],service=state.services[0];
  await command('save.service',{...service,mappings:service.mappings.map(m=>({...m,costPrice:{inputPrice:1,outputPrice:2,cachedInputPrice:0.1}}))});
  await command('save.definition',{...definition,billingMultiplier:1.5});
  await cdp.send('Page.reload');await waitFor(`!!document.querySelector('#v4-sidebar')`);await clickNav('模型服务');await clickExact('编辑服务与价格');
  await waitFor(`!!document.querySelector('dialog[open]')`);
  const costField=await evaluate(`(()=>{const label=[...document.querySelectorAll('dialog[open] label')].find(l=>l.textContent.includes('· 输入成本价'));const group=label.closest('details');if(group)group.open=true;label.scrollIntoView({block:'center'});return {id:label.control.id,value:label.control.value};})()`);
  check(costField.value==='1','upstream cost is independently editable in the contracted service form');await setInput('#'+costField.id,'');await clickExact('保存模型服务');
  check(await evaluate(`document.getElementById(${JSON.stringify(costField.id)}).validity.valueMissing&&document.activeElement.id===${JSON.stringify(costField.id)}&&document.querySelectorAll('dialog[open]').length===1`),'missing required cost input is rejected and focused before confirmation');
  await setInput('#'+costField.id,'1');await clickExact('保存模型服务');await waitFor(`[...document.querySelectorAll('dialog[open]')].some(d=>d.innerText.includes('上游成本价：原 → 新'))`);
  await screenshot('billing-service-pricing-preview-1440.png');await clickExact('返回修改');await waitFor(`document.querySelectorAll('dialog[open]').length===1`);await clickExact('取消');
  await clickNav('模型目录');
  await evaluate(`(()=>{const button=[...document.querySelectorAll('[data-page="catalog"] button')].find(b=>b.textContent==='编辑模型定义');button.click()})()`);
  await waitFor(`!!document.querySelector('dialog[open]')`);
  const multiplier=await evaluate(`(()=>{const label=[...document.querySelectorAll('dialog[open] label')].find(l=>l.textContent.includes('计费倍率'));return {id:label.control.id,type:label.control.type,value:label.control.value}})()`);
  check(multiplier.type==='number'&&multiplier.value==='1.5','model multiplier uses the standard numeric editor');
  await setInput('#'+multiplier.id,'2');await screenshot('billing-model-editor-1440.png');await setViewport(390,844);await screenshot('billing-model-editor-390.png');
  check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'multiplier editor fits at 390');await setViewport(1440,1000);
  await clickExact('继续');await waitFor(`[...document.querySelectorAll('dialog[open]')].some(d=>d.innerText.includes('×1.5 → ×2'))`);await screenshot('billing-preview-1440.png');await clickExact('确认执行');await waitFor(`!document.querySelector('dialog[open]')`);
  check((await api('/api/v1/platform/state')).definitions.find(d=>d.id===definition.id).billingMultiplier===2,'multiplier persists through the real preview and save');
  const issued=await command('key.issue',{name:'倍率报表隔离验证',purpose:'personal',memberId:seeded.employeeId});
  const invoke=async()=>{
    const requestId='billing-check-'+randomUUID(),response=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+issued.secret,'x-request-id':requestId,'idempotency-key':requestId},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'local billing acceptance'}],max_tokens:32})});
    await response.text();assert.equal(response.status,200);return (await api('/api/v1/platform/calls/query',{requestId})).items[0];
  };
  const charged=await invoke(),usage=charged.inputTokens-charged.cachedInputTokens;
  check(charged.actualAmount===Math.ceil((usage*2+charged.outputTokens*3+charged.cachedInputTokens*0.5)*2)/1e6,'real local gateway settles at the configured model multiplier');
  check(charged.admission.costPrice.outputPrice===2&&charged.admission.price.billing.multiplier===2,'actual log preserves independent cost and billing snapshots');
  await command('save.definition',{...definition,billingMultiplier:0});const free=await invoke();
  check(free.actualAmount===0&&free.billableState==='confirmed','zero multiplier settles as a confirmed free business call');
  await command('save.definition',{...definition,name:'=1+1',billingMultiplier:2});
  await cdp.send('Page.reload');await waitFor(`!!document.querySelector('#v4-sidebar')`);await clickNav('用量驾驶舱');
  await waitFor(`document.querySelector('.usage-cockpit')?.innerText.includes('计费与成本报表')`);
  await evaluate(`(()=>{const e=document.querySelector('.usage-cockpit select[aria-label="常用时间"]');e.value='previousMonth';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('.usage-cockpit')?.innerText.includes('这段时间没有调用')`);
  check(await evaluate(`document.querySelector('.usage-cockpit select[aria-label="常用时间"]').value==='previousMonth'`),'previous calendar month works as an empty-state preset');
  // Keep a narrowing while changing the period, and ensure the server sees both.
  await evaluate(`(()=>{const form=document.querySelector('.usage-cockpit form'),label=[...form.querySelectorAll('label')].find(l=>l.firstChild.textContent==='模型'),select=label.querySelector('select');select.value='test-model';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await evaluate(`(()=>{const e=document.querySelector('.usage-cockpit select[aria-label="常用时间"]');e.value='month';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`!!document.querySelector('.usage-cockpit select[aria-label="报表维度"]')&&!document.querySelector('.usage-cockpit button.primary').disabled`);
  check(await evaluate(`document.querySelector('.usage-cockpit form').innerText.includes('test-model')||[...document.querySelectorAll('.usage-cockpit form select')].some(s=>s.value==='test-model')`),'period shortcut preserves the model filter');
  await screenshot('billing-report-1440.png');await setViewport(390,844);await screenshot('billing-report-390.png');
  check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'cost report fits at 390');
  await evaluate(`(()=>{const b=[...document.querySelectorAll('.usage-cockpit button')].find(b=>b.textContent==='时间与对象筛选');if(b?.getAttribute('aria-expanded')==='false')b.click();})()`);
  await evaluate(`document.querySelector('.usage-cockpit select[aria-label="常用时间"]').focus()`);await pressKey('Tab');
  await pressKey('Tab');
  check(await evaluate(`document.activeElement.classList.contains('date-field-trigger')`),'period picker reaches DateField with Tab');await pressKey('ArrowDown');await waitFor(`!!document.querySelector('.usage-cockpit .date-panel')`);await pressKey('Escape');
  check(await evaluate(`document.activeElement.classList.contains('date-field-trigger')`),'report DateField Escape restores focus');
  await setViewport(1440,1000);
  const exported=await evaluate(`(async()=>{const original=URL.createObjectURL.bind(URL);let done;const ready=new Promise(r=>done=r);const prevent=e=>{if(e.target instanceof HTMLAnchorElement)e.preventDefault();};document.addEventListener('click',prevent,true);URL.createObjectURL=blob=>{blob.arrayBuffer().then(data=>{const bytes=new Uint8Array(data);let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);done(btoa(raw));});return original(blob);};try{[...document.querySelectorAll('.usage-cockpit button')].find(b=>b.textContent==='导出 Excel').click();return await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('export timeout')),20000))]);}finally{URL.createObjectURL=original;document.removeEventListener('click',prevent,true);}})()`);
  const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),ExcelJS=require('exceljs'),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(exported,'base64'));
  await writeFile(resolve(process.env.WEB_CHECK_SCREENSHOT_DIR??'docs/validation/screenshots-2026-11-11-billing','billing-report.xlsx'),Buffer.from(exported,'base64'));
  check(workbook.worksheets.length===9,'actual Excel export contains metadata and eight complete dimensions');
  const totalSheet=workbook.getWorksheet('汇总'),header=totalSheet.getRow(1).values;
  check(header.includes('可比差额（元）')&&header.includes('成本未知记录'),'Excel exports independent cost and comparable difference');
  check(typeof totalSheet.getRow(2).getCell(header.indexOf('已确认计费（元）')).value==='number','Excel money is numeric');
  check(workbook.getWorksheet('报表说明').getCell('B5').value.includes('test-model'),'Excel preserves the applied filter');
  check(workbook.getWorksheet('模型').getCell('A2').value==='=1+1','Excel formula-like model names remain typed text');
  const csv=await evaluate(`(async()=>{const original=URL.createObjectURL.bind(URL);let done;const ready=new Promise(r=>done=r),prevent=e=>{if(e.target instanceof HTMLAnchorElement)e.preventDefault();};document.addEventListener('click',prevent,true);URL.createObjectURL=blob=>{blob.text().then(done);return original(blob);};try{[...document.querySelectorAll('.usage-cockpit button')].find(b=>b.textContent==='导出 CSV').click();return await ready;}finally{URL.createObjectURL=original;document.removeEventListener('click',prevent,true);}})()`);
  check(csv.includes("'=1+1"),'CSV neutralizes formula-like model names');
  const summary=await api('/api/v1/platform/analytics/usage',{});
  check(summary.totals.cost.unknownRequests>0&&summary.totals.cost.comparableRequests>=2,'historical unknown costs coexist with known new costs');
  for(const mode of ['azure','sidebar','next','classic','beacon']){
    await cdp.send('Page.navigate',{url:web+'/?ui='+mode});await waitFor(`!!document.querySelector('h1')&&document.body.innerText.includes('用量驾驶舱')`);
    if(['azure','beacon'].includes(mode))await clickNav('用量驾驶舱');else await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='用量驾驶舱');b?.click();})()`);
    await waitFor(`!!document.querySelector('.usage-cockpit select[aria-label="报表维度"]')`);
    for(const width of [1440,390]){await setViewport(width,width===390?844:1000);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),mode+' cost report has no overflow at '+width);}
  }
  await request('/api/v1/auth/logout',{});await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await login('web-employee',seeded.employeePassword);
  const employee=await api('/api/v1/platform/state'),calls=await api('/api/v1/platform/calls/query',{}),report=await api('/api/v1/platform/analytics/usage',{});
  check(!JSON.stringify({employee,calls,report}).match(/"(?:costPrice|billingMultiplier|billing|cost)":/),'employee HTTP responses contain no cost or multiplier metadata');
  const call=await api('/api/v1/platform/calls/'+charged.requestId);
  check(!JSON.stringify(call).match(/"(?:costPrice|billing)":/),'related-call HTTP response also removes internal pricing');
  check(cdp.runtimeErrors.length===0,'billing reports and Excel export have no uncaught browser errors');
  await writeFile(resolve(process.env.WEB_CHECK_SCREENSHOT_DIR??'docs/validation/screenshots-2026-11-11-billing','billing-acceptance.json'),JSON.stringify({checkedAt:new Date().toISOString(),scope:'isolated PostgreSQL, local model fixture only',assertions,uncaughtErrors:cdp.runtimeErrors,charged:{inputTokens:charged.inputTokens,outputTokens:charged.outputTokens,cachedInputTokens:charged.cachedInputTokens,actualAmount:charged.actualAmount,price:charged.admission.price,costPrice:charged.admission.costPrice},free:{actualAmount:free.actualAmount,costPrice:free.admission.costPrice}},null,2));
}
