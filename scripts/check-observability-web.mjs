import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Real isolated control-plane + gateway + local model, memory or PostgreSQL. */
export async function checkObservabilityWeb({cp,gateway,web,seeded,cdp,evaluate,waitFor,clickNav,clickExact,setInput,pressKey,setViewport,screenshot,login,check}){
  const monitorNav=async()=>{await waitFor(`!![...document.querySelectorAll('nav button,aside button,header button')].find(b=>b.textContent.trim()==='运行监控')`);const clicked=await evaluate(`(()=>{const b=[...document.querySelectorAll('nav button,aside button,header button')].find(b=>b.textContent.trim()==='运行监控');if(!b)return false;const d=b.closest('details');if(d)d.open=true;b.click();return true})()`);check(clicked,'monitor navigation exists');await waitFor(`document.body.innerText.includes('实时容量与压力')`);};
  const request=(path,body)=>evaluate(`(async()=>{const r=await fetch(${JSON.stringify(cp+path)},{method:${JSON.stringify(body===undefined?'GET':'POST')},credentials:'include',headers:{'content-type':'application/json'},body:${body===undefined?'undefined':JSON.stringify(JSON.stringify(body))}});return {status:r.status,body:await r.json()};})()`);
  const api=async(path,body)=>{const r=await request(path,body);assert.equal(r.status,200,`${path}: ${JSON.stringify(r.body)}`);return r.body;};
  const internal=async(path,body)=>{const r=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer web-check-service-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.equal(r.status,200);return r.headers.get('content-type')?.includes('text/plain')?r.text():r.json();};
  const command=async(type,payload)=>{const c={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:preview.previewToken})).result;};
  await request('/api/v1/auth/logout',{});await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await login('web-ops',seeded.adminPassword);
  const state=await api('/api/v1/platform/state'),service=state.services[0],pool=state.pools[0];
  const key=await command('key.issue',{name:'链路容量隔离验证',purpose:'personal',memberId:seeded.employeeId});
  const id='observability-'+randomUUID(),traceId=randomUUID().replaceAll('-',''),parent='0123456789abcdef';
  const headers={'content-type':'application/json',authorization:'Bearer '+key.secret,'x-request-id':id,'idempotency-key':id,traceparent:`00-${traceId}-${parent}-01`};
  const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:'private-observability-prompt'}],max_tokens:32});
  const good=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers,body});assert.equal(good.status,200);check(good.headers.get('x-trace-id')===traceId,'gateway echoes a valid incoming trace context');await good.text();
  const replay=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers,body});assert.equal(replay.status,409);await replay.text();
  const invalid=await fetch(gateway+'/v1/chat/completions',{method:'POST',body:'invalid-json'});check(invalid.status===400&&!!invalid.headers.get('x-request-id'),'early malformed JSON has a request id');await invalid.text();
  const unauthorized=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer private-invalid-key'},body});assert.equal(unauthorized.status,401);await unauthorized.text();
  await waitFor(`(async()=>{const r=await fetch(${JSON.stringify(cp+'/api/v1/platform/traces/query')},{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify({requestId:id}))}});const p=await r.json();return p.items?.length===2&&p.items.every(t=>t.completedAt)})()`,15000);
  const traces=(await api('/api/v1/platform/traces/query',{requestId:id})).items,success=traces.find(t=>t.status===200);
  check(traces.length===2&&traces.some(t=>t.replayed)&&new Set(traces.map(t=>t.attemptId)).size===2,'replay is a separate access attempt without another generation');
  check(success.identity.subjectId===seeded.employeeId&&success.route.serviceId===service.id&&success.route.poolId===pool.id,'actual user, credential, pool and service join on a completed request');
  check(success.parentSpanId===parent&&success.stages.some(e=>e.stage==='settled'),'trace records parent context and durable settlement delivery');
  await waitFor(`(async()=>{const r=await fetch(${JSON.stringify(cp+'/api/v1/platform/traces/query')},{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({state:'failed',limit:100})});const p=await r.json();return p.items?.some(t=>t.status===400)&&p.items?.some(t=>t.status===401)})()`,15000);
  const failures=(await api('/api/v1/platform/traces/query',{state:'failed',limit:100})).items;
  check(failures.some(t=>t.status===400&&!t.identity)&&failures.some(t=>t.status===401&&!t.identity),'anonymous pre-admission failures are searchable');
  check(!JSON.stringify(traces).includes(key.secret)&&!JSON.stringify(traces).includes('private-observability-prompt'),'trace metadata excludes credentials and request text');
  const logs=await api('/api/v1/platform/calls/query',{requestId:id});check(logs.items.length===1,'same-key replay preserves a single logical call and charge');
  await command('save.service',{...service,name:'改名后的验证服务',limits:{mode:'custom',rpm:50,tpm:100000,concurrency:2},mappings:service.mappings.map(m=>({...m,limits:{mode:'none'}}))});
  await api(`/api/v1/platform/services/${service.id}/verify`,{idempotencyKey:randomUUID()});
  await command('save.pool',{...pool,limits:{mode:'custom',rpm:70,tpm:100000,concurrency:3}});
  const old=(await api('/api/v1/platform/calls/query',{requestId:id})).items[0];check(old.admission.route.audit.serviceName===service.name&&old.admission.route.audit.configVersion===success.route.audit.configVersion,'history retains original route name and config version after a service rename');
  const credential=await internal('/internal/v1/policy/credentials/resolve',{apiKey:key.secret}),holds=[];
  const authorization=()=>{const id='capacity-'+randomUUID();return {requestId:id,idempotencyKey:id,identity:credential.identity,purpose:credential.purpose,modelId:'test-model',mode:'chat',policyVersion:'observability-check',estimatedInputTokens:10,maxOutputTokens:32};};
  try{
    for(let i=0;i<2;i++){const input=authorization(),result=await internal('/internal/v1/policy/authorize',input);assert.equal(result.decision,'allow');holds.push({input,result});}
    const denied=await internal('/internal/v1/policy/authorize',authorization());check(denied.decision==='deny'&&denied.reasonCode==='rate_limited','two active slots fill the service and the third authorization is refused');
    const capacity=await api('/api/v1/platform/monitoring/capacity'),sr=capacity.rows.find(r=>r.kind==='service'&&r.resourceId===service.id),pr=capacity.rows.find(r=>r.kind==='pool'&&r.resourceId===pool.id);
    check(sr.concurrency.used===2&&sr.concurrency.limit===2&&sr.concurrency.percent===100,'service capacity percentage uses the same authoritative concurrency slots as admission');
    check(pr.concurrency.used===2&&Math.abs(pr.concurrency.percent-200/3)<0.00001,'pool occupancy uses its own scope without double counting services');
    check(sr.rpm.percent===100*sr.rpm.used/50&&sr.tpm.percent===100*sr.tpm.used/100000,'RPM and TPM percentages match current-window limiter counters');
    const unbounded=capacity.rows.find(r=>r.kind==='service_model'&&r.modelId==='test-model');check(unbounded.concurrency.used===2&&unbounded.concurrency.limit===null&&unbounded.concurrency.percent===null,'unlimited resources still count active traffic without inventing a percentage');
    const metrics=await internal('/internal/v1/telemetry/metrics');check(metrics.includes('atlas_capacity_concurrency_ratio')&&metrics.includes(' 1\n')&&!metrics.includes(key.secret)&&!metrics.includes(id),'Prometheus exports bounded resource gauges without request ids or secrets');
    check((await fetch(cp+'/internal/v1/telemetry/metrics')).status===401,'metrics endpoint requires service authentication');
    await cdp.send('Page.reload');await waitFor(`!!document.querySelector('#v4-sidebar')`);await monitorNav();
    await waitFor(`document.body.innerText.includes('实时容量与压力')&&document.body.innerText.includes('已满载')`,10000);
    for(const [mode,label] of [['beacon','信标'],['azure','蓝灰'],['sidebar','左栏'],['next','顶栏'],['classic','经典']]){
      await setViewport(1440,1000);
      if(mode!=='beacon'){await cdp.send('Page.navigate',{url:web+'/?ui='+mode});await waitFor(`document.documentElement.dataset.ui===${JSON.stringify(mode==='sidebar'?'next':mode)}&&document.documentElement.dataset.layout===${JSON.stringify(['beacon','azure','sidebar'].includes(mode)?'sidebar':mode)}`);await monitorNav();}
      await waitFor(`document.body.innerText.includes('已满载')`);
      for(const width of [1440,390]){await setViewport(width,width===390?844:1000);await screenshot(`observability-${mode}-${width}.png`);check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),`${label} capacity and trace page has no page overflow at ${width}`);}
    }
    await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await setViewport(1440,1000);await waitFor(`!!document.querySelector('#v4-sidebar')`);await monitorNav();
    await waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='查看时间线')`);
    await clickExact('暂停链路刷新');
    await evaluate(`(()=>{const form=[...document.querySelectorAll('form')].find(f=>f.textContent.includes('Trace ID（精确）'));form.querySelector('input').focus()})()`);await pressKey('Tab');check(await evaluate(`document.activeElement?.tagName==='INPUT'`),'trace filter supports keyboard navigation');
    await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='查看时间线');b.focus()})()`);await pressKey('Enter');await waitFor(`!!document.querySelector('dialog[open]')`);await screenshot('trace-timeline-1440.png');await setViewport(390,844);await screenshot('trace-timeline-390.png');check(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'trace details fit at 390');await pressKey('Escape');await waitFor(`!document.querySelector('dialog[open]')`);
    check(await evaluate(`document.activeElement?.textContent==='查看时间线'`),'Escape returns focus to the trace trigger');
  }finally{
    for(const {input,result}of holds)await internal('/internal/v1/usage/settlements',{requestId:input.requestId,idempotencyKey:input.requestId+':release',reservationId:result.reservation.reservationId,outcome:'rejected_before_upstream',forwarded:false,usageFinal:true,inputTokens:0,outputTokens:0,completedAt:new Date().toISOString()});
  }
  const after=await api('/api/v1/platform/monitoring/capacity');check(after.rows.find(r=>r.kind==='service'&&r.resourceId===service.id).concurrency.used===0,'settlement releases capacity immediately');
  await request('/api/v1/auth/logout',{});await cdp.send('Page.navigate',{url:web+'/?ui=beacon'});await login('web-employee',seeded.employeePassword);
  check((await request('/api/v1/platform/traces/query',{})).status===403,'employees cannot query operator access traces');check((await request('/api/v1/platform/monitoring/capacity')).status===403,'employees cannot query system capacity');
  const own=await request('/api/v1/platform/calls/query',{requestId:id});check(own.status===200&&!JSON.stringify(own.body).includes(success.route.audit.endpoint),'employee call records omit the private upstream endpoint');
  check(cdp.runtimeErrors.length===0,'no uncaught browser errors in observability acceptance');
}
