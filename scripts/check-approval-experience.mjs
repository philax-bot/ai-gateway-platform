import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Only called inside check-web's owned ports, schema and Chrome profile. */
export async function checkApprovalExperience({cp,web,seeded,cdp,evaluate,waitFor,clickNav,clickExact,setInput,pressKey,setViewport,screenshot,login,check}){
  let cookie='';
  async function api(path,body,expected=200){
    const r=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});
    if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    const result=await r.json();assert.equal(r.status,expected,`${path}: ${JSON.stringify(result)}`);return result;
  }
  const apiLogin=(directoryId,password)=>api('/api/v1/auth/login',{directoryId,password});
  async function command(type,payload,expected=200){const c={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:preview.previewToken},expected)).result;}
  async function browserLogin(directoryId,password){
    await evaluate(`fetch(${JSON.stringify(cp+'/api/v1/auth/logout')},{method:'POST',credentials:'include'}).then(()=>true)`);
    await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await login(directoryId,password);
  }
  const root='[data-page="approvals"]';
  const text=()=>evaluate(`document.querySelector(${JSON.stringify(root)})?.innerText??''`);
  async function field(label,value,select=false){
    check(await evaluate(`(()=>{const field=[...document.querySelectorAll('dialog[open] .form-field')].find(f=>f.querySelector('label')?.textContent.includes(${JSON.stringify(label)}));const el=field?.querySelector(${JSON.stringify(select?'select':'input,textarea')});if(!el)return false;Object.getOwnPropertyDescriptor((el instanceof HTMLSelectElement?HTMLSelectElement:el instanceof HTMLTextAreaElement?HTMLTextAreaElement:HTMLInputElement).prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(${JSON.stringify(select?'change':'input')},{bubbles:true}));return true;})()`),'form field exists: '+label);
  }
  async function openCard(term){
    await waitFor(`[...document.querySelectorAll(${JSON.stringify(root+' .review-item')})].some(el=>el.textContent.includes(${JSON.stringify(term)}))`);
    check(await evaluate(`(()=>{const card=[...document.querySelectorAll(${JSON.stringify(root+' .review-item')})].find(el=>el.textContent.includes(${JSON.stringify(term)}));card?.click();return !!card;})()`),'approval card exists: '+term);
    await waitFor(`!!document.querySelector(${JSON.stringify(root+' [aria-label="当前处理与下一步"]')})&&!document.querySelector(${JSON.stringify(root+' [aria-busy=true]')})`);
  }
  async function pair(name,modal=false){
    for(const width of [1440,390]){
      await setViewport(width,width===390?844:1000);
      if(!modal)await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(root+' .review-workspace>div')});if(el)window.scrollTo(0,Math.max(0,window.scrollY+el.getBoundingClientRect().top-128));})()`);
      check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),name+': no page overflow at '+width);
      await screenshot(`approval-${name}-${width}.png`);
    }
    await setViewport(1440,1000);
  }
  await apiLogin('web-ops',seeded.adminPassword);
  const state=await api('/api/v1/platform/state'),range={poolId:state.pools[0].id,mode:'follow',definitionIds:[]},expiresAt=new Date(Date.now()+7*86400000).toISOString();
  const plan=await command('save.plan',{name:'审批体验 · 文档整理',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:365});
  const manager=await command('save.member',{directoryId:'approval-visual-manager',name:'审批体验经理',organizationId:'org-demo',password:'Approval-visual-2026!'});
  const project=await command('save.project',{initialAmount:1,validity:'permanent',name:'审批体验项目',managerId:manager.id,range});
  await command('project.members',{projectId:project.id,memberIds:[seeded.employeeId]});
  const budget=await command('project.fund',{projectId:project.id,amount:20,expiresAt});

  // Actual request UI, dynamic context and standard date/keyboard behavior.
  await browserLogin('web-employee',seeded.employeePassword);await clickNav('我的额度');await clickExact('申请开通新模型');
  await waitFor(`!!document.querySelector('dialog[open] [aria-label="申请处理路径"]')`);
  check(await evaluate(`document.querySelector('dialog[open]').innerText.includes('企业运营')`),'request previews its reviewer');
  await field('使用场景','审批体验 · 文档整理');await field('申请说明','整理内部文档，需要独立的模型使用范围。');
  await pair('request',true);
  await evaluate(`document.querySelector('dialog[open] .date-field-trigger').focus()`);await pressKey('ArrowDown');
  check(await waitFor(`!!document.querySelector('dialog[open] .date-panel')`),'keyboard opens shared date picker');
  await pressKey('Escape');check(await evaluate(`document.activeElement.classList.contains('date-field-trigger')`),'date Escape returns focus');
  await evaluate(`document.querySelector('dialog[open] .modal-footer button:last-child').focus()`);await pressKey('Tab');
  check(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`),'Tab stays inside request modal');
  await clickExact('提交申请');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
  await clickExact('确认提交申请');await waitFor(`!document.querySelector('dialog[open]')`);
  await apiLogin('web-employee',seeded.employeePassword);
  const request=(await api('/api/v1/platform/state')).approvals.find(a=>a.scenario==='审批体验 · 文档整理');
  check(request?.status==='pending','employee submits a real pending request');
  await clickNav('我的申请');await openCard('文档整理');
  check(await evaluate(`document.querySelector(${JSON.stringify(root+' [aria-label="申请进度"] [aria-current=step] strong')})?.textContent==='等待审批'`),'pending process highlights approval rather than submission');
  check(!(await text()).includes('核对并批准'),'applicant cannot see approve action');await pair('pending');
  await setInput(root+' .review-queue input','不存在的申请');
  check(await waitFor(`!document.querySelector(${JSON.stringify(root+' [aria-label="当前处理与下一步"]')})`),'search never leaves unrelated detail visible');
  await setInput(root+' .review-queue input','');

  // A reduced approval is previewed, executed and linked to its actual receipt.
  await browserLogin('web-ops',seeded.adminPassword);await clickNav('申请与审批');await openCard('文档整理');await clickExact('核对并批准');
  await waitFor(`!!document.querySelector('dialog[open] [aria-label="本次批准对比"]')`);
  await field('金额','5');await field('确认开通方案',plan.id,true);await field('审批意见','按本阶段工作量批准 5 元。');
  check(await evaluate(`document.querySelector('dialog[open] [aria-label="本次批准对比"]').innerText.includes('5.00')`),'amount comparison follows the current form');
  await pair('decision',true);await clickExact('预览批准内容');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
  await clickExact('批准并生效');await waitFor(`!document.querySelector('dialog[open]')`);
  await waitFor(`!!document.querySelector(${JSON.stringify(root+' [aria-label="实际生效结果"]')})`);
  const effective=await api('/api/v1/platform/approvals/'+request.id);
  check(effective.approval.receipt.amount===5&&!!effective.approval.receipt.batchId,'receipt records the actual five-yuan batch');await pair('effective');

  // Returning to a personal approval result must reset a previously selected project purpose.
  await browserLogin('web-employee',seeded.employeePassword);await clickNav('我的额度');
  await evaluate(`(()=>{const el=document.querySelector('[data-page="quota"] .purpose-select select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(project.id)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await clickNav('我的申请');await openCard('文档整理');await clickExact('查看个人模型与额度');
  check(await waitFor(`document.querySelector('[data-page="quota"] .purpose-select select')?.value==='personal'`),'personal result restores the correct quota purpose');
  await browserLogin('web-ops',seeded.adminPassword);await clickNav('申请与审批');

  // Seed an actual execution failure, then exercise the audited close UI.
  await apiLogin('web-employee',seeded.employeePassword);
  const failure=await command('approval.submit',{kind:'personal_open',amount:8,expiresAt,scenario:'审批体验 · 失败恢复',reason:'验证失败后不重复提交。'});
  await apiLogin('web-ops',seeded.adminPassword);
  await command('approval.decide',{id:failure.id,decision:'approve',amount:8,expiresAt,planId:'missing-plan',reason:'验证失效方案'});
  await command('approval.execute',{id:failure.id},404);
  await apiLogin('web-employee',seeded.employeePassword);
  await command('approval.submit',{kind:'personal_open',amount:8,expiresAt,scenario:'重复申请',reason:'应被原失败单阻止'},409);
  await apiLogin('web-ops',seeded.adminPassword);await clickExact('刷新数据');await openCard('失败恢复');
  check((await text()).includes('批准的方案已不存在'),'failure is translated and visible without expanding details');await pair('failed');
  await clickExact('关闭未生效申请');await waitFor(`document.querySelector('dialog[open]')?.innerText.includes('关闭原因')`);
  await field('关闭原因','本次需求取消，保留原审批记录。');await clickExact('预览关闭影响');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
  check(await evaluate(`document.querySelector('dialog[open]:last-of-type .modal-footer .danger-button')?.textContent==='确认关闭申请'`),'closing uses a dangerous action with an explicit impact preview');
  await clickExact('确认关闭申请');await waitFor(`!document.querySelector('dialog[open]')`);
  check((await api('/api/v1/platform/approvals/'+failure.id)).approval.status==='closed','closing is persisted');await pair('closed');

  // A manager approval moves to an operator only after the manager becomes unavailable.
  await apiLogin('web-employee',seeded.employeePassword);
  const member=await command('approval.submit',{kind:'project_member_quota',objectId:project.id,amount:6,expiresAt,scenario:'审批体验 · 项目分配',reason:'需要项目成员额度。'});
  await apiLogin('approval-visual-manager','Approval-visual-2026!');
  await command('approval.decide',{id:member.id,decision:'approve',amount:6,expiresAt:budget.expiresAt,sourceBatchId:budget.id,reason:'经理批准'});
  await apiLogin('web-ops',seeded.adminPassword);await command('save.member',{...manager,active:false});
  await clickExact('刷新数据');await openCard('个人项目额度');
  check((await text()).includes('经理不可用，转运营处理'),'UI explains operator fallback');
  await clickExact('接手并核对');await waitFor(`document.querySelector('dialog[open]')?.innerText.includes('修正依据')`);
  await field('修正依据','原经理已停用，由企业运营接手。');await clickExact('预览修正内容');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);await clickExact('确认执行');await waitFor(`!document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector(${JSON.stringify(root+' [aria-label="当前处理与下一步"] .primary')})?.textContent==='执行生效'`);
  await pair('takeover');await clickExact('执行生效');await waitFor(`!!document.querySelector(${JSON.stringify(root+' [aria-label="实际生效结果"]')})`);
  check((await api('/api/v1/platform/approvals/'+member.id)).approval.receipt.expiresAt===budget.expiresAt,'takeover keeps the exact original source expiry');

  // Project creation previews the final manager and model scope, then links to that exact project.
  await apiLogin('web-employee',seeded.employeePassword);
  const creation=await command('approval.submit',{kind:'project_create',name:'审批体验 · 新建项目',managerId:seeded.employeeId,amount:12,expiresAt,scenario:'审批体验 · 项目创建',reason:'创建项目并发放初始预算。'});
  await apiLogin('web-ops',seeded.adminPassword);await clickExact('刷新数据');await openCard('项目创建');await clickExact('核对并批准');
  await waitFor(`!!document.querySelector('dialog[open] [aria-label="确认的项目模型范围"]')`);
  check(await evaluate(`document.querySelector('dialog[open]').innerText.includes('额度有效期')`),'project creation includes the initial budget expiry');
  await field('审批意见','确认经理、模型范围与初始预算。');await clickExact('预览批准内容');await waitFor(`document.querySelectorAll('dialog[open]').length===2`);
  check(await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).innerText.includes('回归模型池')&&[...document.querySelectorAll('dialog[open]')].at(-1).innerText.includes('跟随模型池')`),'final confirmation preserves the selected model pool and scope');
  await clickExact('批准并生效');await waitFor(`!document.querySelector('dialog[open]')`);await waitFor(`!!document.querySelector(${JSON.stringify(root+' [aria-label="实际生效结果"]')})`);
  const created=(await api('/api/v1/platform/approvals/'+creation.id)).approval;
  const createdState=await api('/api/v1/platform/state'),initialBudget=createdState.projectBudgets.find(batch=>batch.id===created.receipt.batchId);
  check(created.receipt.amount===12&&initialBudget?.projectId===created.receipt.objectId&&initialBudget.totalAmount===12&&initialBudget.expiresAt===created.approvedExpiresAt,'project creation receipt identifies the actual initial budget and expiry');await pair('project-created');
  await clickExact('查看业务结果');check(await waitFor(`document.querySelector('[data-page="projects"]')?.innerText.includes('审批体验 · 新建项目')`),'result action opens the exact created project');

  // Rejection and withdrawal end the path without showing an approved step.
  for(const status of ['rejected','withdrawn']){
    await apiLogin('web-employee',seeded.employeePassword);
    const a=await command('approval.submit',{kind:'personal_open',amount:3,expiresAt,scenario:'审批体验 · '+status,reason:'验证终态。'});
    if(status==='withdrawn')await command('approval.withdraw',{id:a.id});
    else {await apiLogin('web-ops',seeded.adminPassword);await command('approval.decide',{id:a.id,decision:'reject',reason:'无需重复开通。'});}
  }
  await browserLogin('web-ops',seeded.adminPassword);await clickNav('申请与审批');
  await evaluate(`(()=>{[...document.querySelectorAll(${JSON.stringify(root+' .section-tabs button')})].find(b=>b.textContent.includes('权限内全部'))?.click();})()`);
  for(const status of ['rejected','withdrawn']){await openCard(status);check(!await evaluate(`document.querySelector(${JSON.stringify(root+' [aria-label="申请进度"]')}).innerText.includes('审批已批准')`),status+' never looks approved');}

  // All shells retain the same process/contrast patterns and stay inside the viewport.
  for(const mode of ['azure','sidebar','next','classic','beacon']){
    await cdp.send('Page.navigate',{url:web+'/?ui='+mode});await waitFor(`!!document.querySelector('[data-page]')`);
    await evaluate(`(()=>{[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes('申请与审批'))?.click();})()`);
    await waitFor(`!!document.querySelector(${JSON.stringify(root+' .section-tabs')})`);
    await evaluate(`(()=>{[...document.querySelectorAll(${JSON.stringify(root+' .section-tabs button')})].find(b=>b.textContent.includes('权限内全部'))?.click();})()`);
    await waitFor(`!!document.querySelector(${JSON.stringify(root+' [aria-label="申请进度"]')})`);
    for(const width of [1440,390]){await setViewport(width,width===390?844:1000);const overflow=await evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth');if(overflow>0)console.error('Overflow elements:',await evaluate(`JSON.stringify([...document.querySelectorAll('body *')].filter(el=>el.getClientRects().length&&el.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width})))`));check(overflow<=0,`${mode}: approvals have no overflow at ${width} (${overflow})`);}
  }
  check(cdp.runtimeErrors.length===0,'approval flows have no uncaught browser errors');
}
