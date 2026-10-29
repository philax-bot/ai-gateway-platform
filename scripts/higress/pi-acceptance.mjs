import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {completedSse} from './pi-evidence.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
const digest=value=>createHash('sha256').update(value).digest('hex');
const source=`export function settle(balanceMicros, entries) {
  return entries.reduce((balance, entry) => balance - entry.amountMicros, balanceMicros);
}
`;
const specification=`Implement settle(balanceMicros, entries) in ledger.mjs. Return the remaining integer balance.
All amounts, including the initial balance, must be non-negative safe integers. Entry amount must be positive.
Each entry has a non-empty string id and amountMicros. Deduplicate the same id and amount within one call.
Reject conflicting duplicate amounts, invalid numbers, malformed entries, and any overdraft with an Error.
Do not mutate the entries or their objects. Do not add dependencies. This is a pure local fixture, no IO.
Write ledger.test.mjs with at least seven distinct node:test cases covering these requirements.
Run node --test ledger.test.mjs. Finish only after tests pass. Final reply: PI_HIGRESS_CODE_OK.
`;

export async function runPiAcceptance({root,directory,piCli,gw,key,model,reserve,budget,check,report,waitLog,hg,reuse,reuseLong}){
  const originals=[resolve(process.env.USERPROFILE,'.pi/agent/models.json'),resolve(process.env.USERPROFILE,'.pi/agent/settings.json'),resolve(process.env.USERPROFILE,'.cc-switch/cc-switch.db')];
  const hashFile=async file=>{try{return digest(await readFile(file));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  const before=await Promise.all(originals.map(hashFile));
  const agent=resolve(directory,'agent'),work=resolve(directory,'work'),requests=[];
  await mkdir(agent);await mkdir(work);await writeFile(resolve(work,'ledger.mjs'),source);await writeFile(resolve(work,'REQUIREMENTS.md'),specification);
  const existing=JSON.parse(await readFile(originals[0])),selected=existing.providers?.['token-run-test'];
  assert.equal(selected?.api,'openai-completions');const template=selected.models.find(m=>m.id===model);assert.ok(template);
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/(?:TOKEN|KEY|SECRET|PASSWORD|DATABASE|^UPSTREAM_|^HIGRESS_|^GATEWAY_|^NODE_OPTIONS$|^PGOPTIONS$)/i.test(name)));
  Object.assign(env,{PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0'});
  await writeFile(resolve(agent,'settings.json'),JSON.stringify({retry:{enabled:false,maxRetries:0,provider:{maxRetries:0,timeoutMs:180000}},compaction:{enabled:false}}));
  let currentPhase='coding',reservationTail=Promise.resolve(),server,piChild;
  const phaseLimits={coding:Math.min(6,budget.maxRequests-budget.attempts-3),long:1,cancel:1,retry:1};
  assert.ok(reuse?budget.maxRequests-budget.attempts>=(reuseLong?2:3):phaseLimits.coding>=4,'coding and remaining acceptance requests must fit the request budget');
  const proxyError=(response,status,code)=>{if(!response.headersSent)response.writeHead(status,{'content-type':'application/json'});if(!response.destroyed)response.end(JSON.stringify({error:{type:code,message:code}}));};
  try{
    server=createServer(async(request,response)=>{
      const abort=new AbortController();response.on('close',()=>{if(!response.writableEnded)abort.abort();});
      let record;
      try{
        if(request.headers.authorization!==`Bearer ${key}`)return proxyError(response,401,'validation_unauthorized');
        if(request.method==='GET'&&request.url==='/v1/models'){
          const upstream=await fetch(gw+request.url,{headers:{authorization:`Bearer ${key}`},signal:abort.signal});response.writeHead(upstream.status,{'content-type':'application/json'});response.end(await upstream.text());return;
        }
        if(request.method!=='POST'||request.url!=='/v1/chat/completions')return proxyError(response,404,'validation_unknown_path');
        let raw='';for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>1048576)throw Error('validation_body_too_large');}
        const body=JSON.parse(raw);assert.equal(body.model,model);
        if(currentPhase==='long')assert.equal(body.thinking?.type,'disabled','the temporary Pi model must explicitly disable DeepSeek default thinking for the bounded review');
        const phase=currentPhase,requestId=`higress-pi-${randomUUID()}`;
        const reserved=reservationTail.then(async()=>{
          assert.ok(requests.filter(r=>r.phase===phase).length<phaseLimits[phase],'validation_phase_request_limit');
          await reserve(body,'Pi '+phase);record={requestId,phase,maxOutputTokens:body.max_completion_tokens??body.max_tokens,thinking:body.thinking?.type??'provider default',stream:body.stream===true,startedAt:new Date().toISOString(),chunks:0,bytes:0};requests.push(record);
        });reservationTail=reserved.catch(()=>{});try{await reserved;}catch{return proxyError(response,429,'validation_budget_or_phase_limit');}
        const began=performance.now();let buffer='',firstDelta,lastDelta,maxDeltaGap=0;
        const observe=chunk=>{
          record.chunks++;record.bytes+=chunk.length;buffer+=chunk.toString();
          const lines=buffer.split('\n');buffer=lines.pop();
          for(const line of lines){if(!line.startsWith('data: '))continue;const text=line.slice(6).trim();if(text==='[DONE]'){record.done=true;continue;}
            let value;try{value=JSON.parse(text);}catch{continue;}if(value.usage)record.usage=value.usage;
            for(const choice of value.choices??[]){if(choice.finish_reason)record.finishReason=choice.finish_reason;const delta=choice.delta??{};
              if(delta.content||delta.reasoning_content||delta.tool_calls?.length){const now=performance.now();if(firstDelta===undefined)firstDelta=now;if(lastDelta!==undefined)maxDeltaGap=Math.max(maxDeltaGap,now-lastDelta);lastDelta=now;}
            }
          }
        };
        const upstream=await fetch(gw+request.url,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','x-request-id':requestId,'idempotency-key':requestId,...(typeof request.headers['x-retry-of-request-id']==='string'?{'x-retry-of-request-id':request.headers['x-retry-of-request-id']}:{})},body:raw,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(180000)]),redirect:'error'});
        record.httpStatus=upstream.status;record.headersMs=Math.round(performance.now()-began);response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});
        if(upstream.body)for await(const chunk of upstream.body){if(response.destroyed)break;observe(Buffer.from(chunk));response.write(chunk);}
        record.durationMs=Math.round(performance.now()-began);record.generationSpanMs=firstDelta===undefined?0:Math.round(lastDelta-firstDelta);record.firstDeltaMs=firstDelta===undefined?null:Math.round(firstDelta-began);record.maxDeltaGapMs=Math.round(maxDeltaGap);response.end();
      }catch(error){if(record)record.transportError=error.name;proxyError(response,502,'validation_proxy_error');}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
    async function configure(maxTokens){await writeFile(resolve(agent,'models.json'),JSON.stringify({providers:{'higress-acceptance':{api:selected.api,baseUrl:base+'/v1',apiKey:key,models:[{...template,maxTokens,thinkingLevelMap:{...template.thinkingLevelMap,off:'none'},samplingParamsByThinkingLevel:{...template.samplingParamsByThinkingLevel,off:{...template.samplingParamsByThinkingLevel?.off,thinking:{type:'disabled'}}}}]}}}),{mode:0o600});}
    async function runPi({phase,tools,maxTokens,prompt,system}){
      currentPhase=phase;await configure(maxTokens);
      const args=['--provider','higress-acceptance','--model',model,'--thinking','off','--mode','json','--print','--no-session','--offline','--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-context-files','--no-themes',...(tools?['--tools',tools]:['--no-tools']),'--system-prompt',system,prompt];
      piChild=spawn(process.execPath,[piCli,...args],{cwd:work,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='',errors='';piChild.stdout.on('data',v=>text=(text+v).slice(-3000000));piChild.stderr.on('data',v=>errors=(errors+v).slice(-4000));
      const timer=setTimeout(()=>piChild.kill(),180000);const code=await new Promise((r,j)=>{piChild.once('exit',r);piChild.once('error',j);});clearTimeout(timer);
      const events=text.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}),messages=events.filter(e=>e.type==='message_end').map(e=>e.message),last=messages.filter(m=>m?.role==='assistant').at(-1);
      const answer=last?.content?.filter(v=>v.type==='text').map(v=>v.text).join('')??'';
      const result={exitCode:code,durationMs:events.length?Date.now()-Date.parse(requests.find(r=>r.phase===phase)?.startedAt??new Date().toISOString()):0,toolNames:events.filter(e=>e.type==='tool_execution_start').map(e=>e.toolName),toolErrors:events.filter(e=>e.type==='tool_execution_end'&&e.isError).length,modelTurns:messages.filter(m=>m?.role==='assistant').length,automaticRetry:events.some(e=>e.type==='auto_retry_start'),answerHash:digest(answer),answerCharacters:answer.length,stopReason:last?.stopReason};
      if(code!==0)result.stderrHash=digest(errors);return {result,answer};
    }
    console.log('PI coding: isolated ledger repair, real tools and tests');
    if(!reuse){
    const coding=await runPi({phase:'coding',tools:'read,edit,write,powershell',maxTokens:2048,system:'You are repairing an isolated local Node.js exercise. Stay entirely in the current directory. Read REQUIREMENTS.md and ledger.mjs first, using batched tool calls. Implement the contract and write tests. Use powershell only to run node --test ledger.test.mjs. No network, git, package installs, or other directories. Complete in at most six model responses. Do not claim test success without running tests. After tools finish, reply PI_HIGRESS_CODE_OK.',prompt:'Read REQUIREMENTS.md and ledger.mjs, repair the implementation, add the required tests, execute them and finish.'});
    report.pi={version:spawnSync(process.execPath,[piCli,'--version'],{env,cwd:work,encoding:'utf8',windowsHide:true}).stdout.trim(),coding:coding.result};
    check(coding.result.exitCode===0&&coding.answer.includes('PI_HIGRESS_CODE_OK'),'actual Pi CLI completes the coding task through Higress');
    check(coding.result.toolNames.includes('read')&&coding.result.toolNames.some(n=>['edit','write'].includes(n))&&coding.result.toolNames.includes('powershell'),'Pi actually reads, edits and executes local tests');
    check(coding.result.modelTurns>=3&&!coding.result.automaticRetry,'Pi completes multiple model/tool turns without automatic generation retries');
    const independent=spawnSync(process.execPath,['--test','ledger.test.mjs'],{cwd:work,encoding:'utf8',windowsHide:true,timeout:15000});check(independent.status===0,'independent execution confirms the Pi-generated tests pass');
    const {settle}=await import(pathToFileURL(resolve(work,'ledger.mjs')).href);
    const items=Object.freeze([Object.freeze({id:'a',amountMicros:17}),Object.freeze({id:'a',amountMicros:17}),Object.freeze({id:'b',amountMicros:3})]);assert.equal(settle(100,items),80);assert.equal(settle(0,[]),0);
    for(const [balance,entries] of [[10,[{id:'x',amountMicros:11}]],[10,[{id:'x',amountMicros:2},{id:'x',amountMicros:3}]],[10,[{id:'',amountMicros:1}]],[10,[{id:'x',amountMicros:0}]],[10,[{id:'x',amountMicros:-1}]],[10,[{id:'x',amountMicros:1.5}]],[10,[{id:'x',amountMicros:NaN}]],[10,[{id:'x',amountMicros:Number.MAX_SAFE_INTEGER+1}]],[NaN,[]],[-1,[]],[1.5,[]]])assert.throws(()=>settle(balance,entries));
    check(true,'independent contract cases confirm deduplication, conflict rejection, number validation, funds protection and immutability');
    report.pi.independentTests={passed:true,testCount:Number(independent.stdout.match(/# tests (\d+)/)?.[1]??0),contractCases:13};check(report.pi.independentTests.testCount>=7,'Pi supplies at least seven executable test cases');
    const artifact=resolve(root,'.runtime/higress-pi-artifacts',randomUUID());await mkdir(artifact,{recursive:true});for(const name of ['ledger.mjs','ledger.test.mjs','REQUIREMENTS.md'])await copyFile(resolve(work,name),resolve(artifact,name));report.pi.artifactDirectory=artifact;
    }else{
      report.pi={version:reuse.pi.version,coding:reuse.pi.coding,independentTests:reuse.pi.independentTests,artifactDirectory:reuse.pi.artifactDirectory,codingEvidenceReused:true};
      for(const name of ['ledger.mjs','ledger.test.mjs','REQUIREMENTS.md'])await copyFile(resolve(reuse.pi.artifactDirectory,name),resolve(work,name));
      const tests=spawnSync(process.execPath,['--test','ledger.test.mjs'],{cwd:work,encoding:'utf8',windowsHide:true,timeout:15000});check(tests.status===0,'reused Pi coding artifact still passes independent execution');
    }
    console.log('PI long stream: substantive settlement review, no tools or artificial delay');
    if(!reuseLong){
    const long=await runPi({phase:'long',tools:null,maxTokens:8192,system:'You are a software test engineer writing a complete review. Follow the requested format exactly. Use clear English, precise invariants, and concrete failure timing. Do not execute tools. End with PI_HIGRESS_LONG_OK.',prompt:`Review the settlement contract below for an engineering acceptance document. Provide exactly 48 numbered scenarios labeled SCENARIO 01 through SCENARIO 48. Each scenario must have 75 to 90 English words covering its concrete setup, action, expected funds and deduplication outcome, and evidence required. Cover normal settlement, duplicates, conflicting IDs, numeric bounds, immutability, cancellation before and after dispatch, missing final usage, late usage, outbox interruption, crashes, configuration and price snapshots, multi-user isolation and operator recovery. Keep the cases distinct, substantive and useful. Finish all 48 scenarios and the final marker within the output budget. Contract:\n${specification}\nCurrent repaired implementation:\n${await readFile(resolve(work,'ledger.mjs'),'utf8')}`});
    const longWire=requests.find(r=>r.phase==='long');report.pi.long={...long.result,scenarioMentions:(long.answer.match(/SCENARIO\s+\d+/g)??[]).length,finalMarkerMatched:long.answer.includes('PI_HIGRESS_LONG_OK')};
    await writeFile(resolve(report.pi.artifactDirectory,'review.md'),long.answer);
    check(long.result.exitCode===0&&report.pi.long.finalMarkerMatched&&long.result.stopReason==='stop'&&long.answer.length>10000,'Pi completes the substantive review without truncation');
    check(longWire?.done&&longWire.usage&&longWire.finishReason==='stop','real Pi long SSE includes DONE and final authoritative usage');
    report.pi.long.overThirtySeconds=(longWire.generationSpanMs??0)>30000;
    check(report.pi.long.overThirtySeconds,'real model generation spans more than 30 seconds without artificial delay');
    const longLog=await waitLog(longWire.requestId);check(longLog.billableState==='confirmed'&&longLog.usageFinal,'real long task settles its final usage');
    }else{
      const wire=reuseLong.pi.requests.find(r=>r.phase==='long');report.pi.long={...reuseLong.pi.long,scenarioMentions:reuseLong.pi.long.scenarios,exactScenarioCountVerified:false,overThirtySeconds:true,reused:true,wire};
      delete report.pi.long.scenarios;
      check(wire.done&&wire.finishReason==='stop'&&wire.generationSpanMs>30000&&report.pi.long.finalMarkerMatched,'retained actual Pi evidence confirms a complete real stream longer than 30 seconds');
      check(reuseLong.higressDiagnostics.gateway.includes(wire.requestId),'retained Higress access log confirms the actual completed long request');
    }
    currentPhase='cancel';console.log('PI acceptance: cancel a generating stream, then make a distinct explicit request');
    const abort=new AbortController(),cancel=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,thinking:{type:'disabled'},stream:true,max_tokens:1024,messages:[{role:'user',content:'Write a complete engineering guide to settlement recovery, with 40 detailed test cases.'}]}),signal:abort.signal});
    check(cancel.ok,'real cancellation request opens through Higress');const reader=cancel.body.getReader();let observed='';for(let n=0;n<200;n++){const part=await reader.read();if(part.done)break;observed+=Buffer.from(part.value).toString();if(/"(?:content|reasoning_content)":"[^"\\]/.test(observed))break;}
    check(/"(?:content|reasoning_content)":"[^"\\]/.test(observed),'cancellation happens after actual model output begins');abort.abort();try{await reader.cancel();}catch{}
    const cancelled=requests.find(r=>r.phase==='cancel'),cancelLog=await waitLog(cancelled.requestId);report.pi.cancellation={requestId:cancelled.requestId,billableState:cancelLog.billableState,usageFinal:cancelLog.usageFinal};
    check(cancelLog.billableState==='pending_review'&&!cancelLog.usageFinal,'cancelled unknown usage retains its original hold for review');
    currentPhase='retry';const retry=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','x-retry-of-request-id':cancelled.requestId},body:JSON.stringify({model,thinking:{type:'disabled'},stream:true,max_tokens:128,messages:[{role:'user',content:'Reply with exactly HIGRESS_RETRY_OK.'}]})}),retryText=await retry.text(),retried=requests.find(r=>r.phase==='retry'),retryLog=await waitLog(retried.requestId);
    const retryBody=completedSse(retryText);report.pi.retry={requestId:retried.requestId,httpStatus:retry.status,contentHash:digest(retryBody.content),markerMatched:retryBody.content.trim()==='HIGRESS_RETRY_OK',done:retryBody.done,finishReason:retryBody.finishReason,billableState:retryLog.billableState,usageFinal:retryLog.usageFinal,retryOfRequestId:retryLog.retryOfRequestId};
    check(retry.ok&&report.pi.retry.markerMatched&&retryBody.done&&retried.requestId!==cancelled.requestId&&retryLog.billableState==='confirmed'&&retryLog.retryOfRequestId===cancelled.requestId,'explicit post-cancellation request succeeds and settles independently');
    check((await waitLog(cancelled.requestId)).billableState==='pending_review','new generation does not release or overwrite the earlier unknown-usage hold');
    await pause(300);const access=await hg.run(['exec',hg.name+'-gateway','tail','-c','200000','/var/log/higress/gateway.log']);
    check(requests.every(r=>access.out.includes(r.requestId)),'every Pi and cancellation request is observed in actual Higress access logs');
    report.pi.explicitRetryRequestId=retried.requestId;
  }finally{
    if(piChild&&piChild.exitCode===null&&piChild.signalCode===null)piChild.kill();
    server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));
    report.pi??={};report.pi.requests=requests;report.pi.originalConfigurationsUnchanged=(await Promise.all(originals.map(hashFile))).every((value,index)=>value===before[index]);
    check(report.pi.originalConfigurationsUnchanged,'original Pi models/settings and CC Switch database remain unchanged');
    report.pi.aggregateBudget=budget.snapshot();
  }
}
