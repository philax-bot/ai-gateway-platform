import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {connectionConfig} from '../lib/backup.mjs';

// Exercise a Key issued through the UI, against this check's local fixture only.
const root=process.cwd(),directory=await realpath(process.argv[2]),label=process.argv[3];
assert.ok(directory.startsWith((await realpath(resolve(root,'.runtime')))+sep+'higress-web-'));
assert.ok(['active','disabled','restored','refresh'].includes(label));
const session=JSON.parse(await readFile(resolve(directory,'session.json'),'utf8'));
assert.match(session.schema,/^agp_hg_[a-f0-9]{32}$/);assert.match(session.gateway,/^http:\/\/127\.0\.0\.1:\d+$/);
const {Pool}=createRequire(resolve(root,'apps/control-plane/package.json'))('pg'),{connectionString}=await connectionConfig(),db=new Pool({connectionString});
try{
  const payload=(await db.query(`select payload from "${session.schema}".platform_workspace where id='org-demo'`)).rows[0].payload;
  assert.ok(payload.services.every(s=>s.baseUrl==='http://model.poc.test:4010/v1'),'fixture-only services required');
  assert.equal((await fetch(session.gateway+'/health').then(r=>r.json())).dataPlane,'higress');
  const funds=async()=>(await db.query(`select id,purpose,source_id,available_amount from "${session.schema}".quota_batches order by id`)).rows;
  const before=await funds(),requestId='browser-app-'+randomUUID(),secret=(await readFile(resolve(directory,'app-key.txt'),'utf8')).trim();
  const response=await fetch(session.gateway+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json','x-request-id':requestId,'idempotency-key':requestId},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'POC_BASIC browser application integration'}],max_tokens:32}),signal:AbortSignal.timeout(15000)});
  await response.text();assert.equal(response.status,label==='disabled'?401:200);
  let call;for(let n=0;n<50;n++){call=(await db.query(`select request_id,purpose,subject_id,billable_state,actual_amount from "${session.schema}".call_logs where request_id=$1`,[requestId])).rows[0];if(call||label==='disabled')break;await new Promise(r=>setTimeout(r,100));}
  const after=await funds();
  if(label==='disabled')assert.deepEqual(after,before);
  else{
    assert.equal(call.subject_id,session.applicationId);assert.equal(call.purpose,'application');assert.equal(call.billable_state,'confirmed');assert.equal(Math.round(Number(call.actual_amount)*1e6),132);
    for(const batch of before){const next=after.find(b=>b.id===batch.id);assert.equal(Math.round((Number(batch.available_amount)-Number(next.available_amount))*1e6),batch.source_id===session.applicationId?132:0);}
  }
  const path=resolve(directory,'application-calls.json');let results=[];try{results=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const result={label,requestId,httpStatus:response.status,call:call??null,before,after};results.push(result);await writeFile(path,JSON.stringify(results,null,2));console.log(JSON.stringify({label,requestId,httpStatus:response.status,amount:call?.actual_amount??0}));
}finally{await db.end();}
