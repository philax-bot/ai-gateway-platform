import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {connectionConfig} from './lib/backup.mjs';

const root=process.cwd(),id=randomUUID(),workspace=`check-${id}`,runtime=resolve(root,'.runtime'),stateFile=resolve(runtime,`review-postgres-${workspace}.json`);
const require=createRequire(resolve(root,'apps/control-plane/package.json')),{Pool}=require('pg'),children=[],ownedIds=new Set();
let database,original,assertions=0;const check=(condition,message)=>{assert.ok(condition,message);assertions++;},pause=ms=>new Promise(r=>setTimeout(r,ms));
if(!process.env.npm_execpath)throw new Error('请使用 pnpm check:review，先构建控制面与网关');
const selected=new Set();async function freePort(){for(;;){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));if(!selected.has(port)){selected.add(port);return port;}}}
const ports={web:await freePort(),control:await freePort(),gateway:await freePort(),model:await freePort()},cp=`http://127.0.0.1:${ports.control}`,gw=`http://127.0.0.1:${ports.gateway}`;
function start(extra={}){
  const child=spawn(process.execPath,[resolve(root,'scripts/review.mjs'),'--postgres','--prebuilt'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,REVIEW_WORKSPACE:workspace,REVIEW_HOSTNAME:'127.0.0.1',REVIEW_WEB_PORT:String(ports.web),REVIEW_CONTROL_PORT:String(ports.control),REVIEW_GATEWAY_PORT:String(ports.gateway),REVIEW_MODEL_PORT:String(ports.model),...extra}});
  let output='';child.stdout.on('data',v=>output=(output+v).slice(-7000));child.stderr.on('data',v=>output=(output+v).slice(-7000));child.on('error',()=>{output+='process unavailable';});child.on('message',message=>{if(message?.type==='review-ready')child.ownedPids=message.pids;});child.output=()=>output;children.push(child);return child;
}
async function ready(child){for(let n=0;n<300;n++){if(child.exitCode!==null||child.signalCode!==null)throw new Error(child.output());if(child.ownedPids&&child.output().includes('人工审查入口：'))return;await pause(200);}throw new Error('持久审查启动超时：'+child.output());}
async function stopped(child){if(child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise(r=>child.once('exit',r));child.send({type:'stop-review'});await Promise.race([ended,pause(20000).then(()=>{throw new Error('持久审查停止超时');})]);assert.equal(child.exitCode,0);}
async function rejected(){const child=start();for(let n=0;n<100;n++){if(child.exitCode!==null){check(child.exitCode!==0,'invalid or conflicting review state exits without starting services');return child.output();}await pause(100);}throw new Error('错误审查状态未及时拒绝');}
async function request(path,body,cookie=''){const response=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
async function command(cookie,type,payload){const input={type,payload,idempotencyKey:randomUUID()},preview=await request('/api/v1/platform/preview',input,cookie);assert.equal(preview.status,200);const result=await request('/api/v1/platform/commands',{...input,previewToken:preview.body.previewToken},cookie);assert.equal(result.status,200);return result.body.result;}
const funds=state=>JSON.stringify(state.quotaBatches.map(b=>({id:b.id,total:b.totalAmount,available:b.availableAmount,expiresAt:b.expiresAt})).sort((a,b)=>a.id.localeCompare(b.id)));
try{
  const {connectionString}=await connectionConfig();database=new Pool({connectionString,connectionTimeoutMillis:5000,max:1});
  console.log('CHECK fresh review uses a generated schema and rejects a concurrent writer');
  let worker=start();await ready(worker);original=JSON.parse(await readFile(stateFile,'utf8'));ownedIds.add(original.id);
  assert.equal(original.workspace,workspace);assert.equal(original.schema,`agp_review_${original.id.replaceAll('-','')}`);
  check(original.ready===true,'initial review seed publishes ready state');
  check((await rejected()).includes('已有进程运行'),'second review writer is rejected before startup');
  const login=await request('/api/v1/auth/login',{directoryId:'review-ops',password:'Review-local-2026!'});check(login.status===200,'generated review administrator can sign in');const admin=login.cookie;
  const baseline=(await request('/api/v1/platform/state',undefined,admin)).body,baselineFunds=funds(baseline);
  await stopped(worker);
  console.log('CHECK interrupted initialization replays the same commands without funding twice');
  await database.query(`update "${original.schema}".review_identity set ready=false where singleton=true`);await writeFile(stateFile,JSON.stringify({...original,ready:false}));
  worker=start();await ready(worker);const recovered=(await request('/api/v1/platform/state',undefined,admin)).body;
  check(funds(recovered)===baselineFunds&&recovered.members.length===baseline.members.length&&recovered.plans.length===baseline.plans.length&&recovered.projects.length===baseline.projects.length,'seed recovery retains original balances and object identities');
  check(JSON.parse(await readFile(stateFile,'utf8')).ready===true,'interrupted seed recovery marks the same workspace ready');
  const label=`审查保留-${id}`;await command(admin,'settings.update',{name:label});const organization=await command(admin,'save.organization',{name:'跨重启审查组织',parentId:'org-demo'});const member=await command(admin,'save.member',{name:'跨重启审查人员',directoryId:`retained-${id}`,organizationId:organization.id});
  const employee=(await request('/api/v1/auth/login',{directoryId:'review-employee',password:'Review-local-2026!'})).cookie;
  const issued=await command(employee,'key.issue',{name:'跨重启验证',purpose:'personal'});
  async function call(){const result=await fetch(gw+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${issued.secret}`},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'persistent review local stand-in'}],max_tokens:32})});await result.text();return result.status;}
  check(await call()===200,'review key completes a real local stand-in request');
  const before=(await request('/api/v1/platform/state',undefined,admin)).body,beforeFunds=funds(before),beforeOperations=Number((await database.query(`select count(*)::int as count from "${original.schema}".schema_migrations`)).rows[0].count);
  await stopped(worker);
  // A terminated prior runner leaves precisely this kind of lock; the recorded PID is now terminal.
  await writeFile(stateFile+'.lock',JSON.stringify({pid:worker.pid,token:randomUUID()}));
  console.log('CHECK restart preserves manual edits, sessions, original funds, keys and call history');
  worker=start();await ready(worker);const resumed=await request('/api/v1/platform/state',undefined,admin);check(resumed.status===200,'original cookie remains valid after restart');
  check(resumed.body.settings.name===label&&resumed.body.members.some(m=>m.id===member.id)&&resumed.body.organizations.some(o=>o.id===organization.id),'manual organization, person and workspace edits survive');
  check(funds(resumed.body)===beforeFunds&&resumed.body.callLogs.length===before.callLogs.length&&resumed.body.keys.some(k=>k.id===issued.key.id),'restart neither resets funds nor repeats setup or calls');
  check(worker.output().includes('不会重建账号'),'ready workspace explicitly skips seed');
  check(Number((await database.query(`select count(*)::int as count from "${original.schema}".schema_migrations`)).rows[0].count)===beforeOperations,'restart retains migration history');
  check(await call()===200,'same key and route work after review restart');
  check((await request('/api/v1/platform/state',undefined,admin)).body.callLogs.length===before.callLogs.length+1,'post-restart call adds one authoritative log');
  await stopped(worker);
  console.log('CHECK public-schema substitution, wrong identity, production mode and missing data reject');
  const intact=await readFile(stateFile,'utf8');await writeFile(stateFile,JSON.stringify({...original,schema:'public'}));check((await rejected()).includes('身份不匹配'),'public schema cannot be adopted as a review workspace');await writeFile(stateFile,intact);
  await database.query(`update "${original.schema}".review_identity set workspace_id=$1`,[randomUUID()]);check((await rejected()).includes('身份与状态文件不一致'),'marker mismatch rejects before business services start');await database.query(`update "${original.schema}".review_identity set workspace_id=$1`,[original.id]);
  await database.query(`update "${original.schema}".platform_installation set mode='production'`);check((await rejected()).includes('拒绝把正式安装'),'review cannot start against a production installation');await database.query(`update "${original.schema}".platform_installation set mode='development'`);
  const absent=randomUUID();ownedIds.add(absent);const absentSchema=`agp_review_${absent.replaceAll('-','')}`;await writeFile(stateFile,JSON.stringify({...original,id:absent,schema:absentSchema}));check((await rejected()).includes('原审查 schema 已不存在'),'ready workspace with missing data fails without reseeding');check(!(await database.query('select exists(select 1 from pg_namespace where nspname=$1) as present',[absentSchema])).rows[0].present,'missing ready schema was not recreated');await writeFile(stateFile,intact);
  console.log(`PASS ${assertions} persistent review assertions (restart, seed recovery, current session and target protection)`);
}catch(error){console.error(error instanceof assert.AssertionError?error.message:'Persistent review check failed: '+error.message);process.exitCode=1;}
finally{
  for(const child of children.reverse()){
    if(child.exitCode===null&&child.signalCode===null)try{await stopped(child);}catch{for(const pid of child.ownedPids??[])try{process.kill(pid);}catch{}child.kill();}
  }
  if(!original)try{const value=JSON.parse(await readFile(stateFile,'utf8'));if(value.workspace===workspace&&/^[a-f0-9-]{36}$/.test(value.id)&&value.schema===`agp_review_${value.id.replaceAll('-','')}`){original=value;ownedIds.add(value.id);}}catch{}
  if(database){
    if(original){assert.equal(original.workspace,workspace);assert.match(original.schema,/^agp_review_[a-f0-9]{32}$/);const exists=(await database.query('select exists(select 1 from pg_namespace where nspname=$1) as present',[original.schema])).rows[0].present;if(exists){const marker=(await database.query(`select workspace_id,workspace from "${original.schema}".review_identity where singleton=true`)).rows[0];assert.equal(marker.workspace,workspace);assert.equal(marker.workspace_id,original.id);await database.query(`drop schema "${original.schema}" cascade`);}}
    await database.end();
  }
  const physicalRuntime=await realpath(runtime);for(const ownId of ownedIds){assert.match(ownId,/^[a-f0-9-]{36}$/);const directory=resolve(runtime,`review-postgres-${ownId}`);try{assert.equal(await realpath(directory),resolve(physicalRuntime,`review-postgres-${ownId}`));assert.ok(directory.startsWith(physicalRuntime+sep));await rm(directory,{recursive:true,force:true});}catch(error){if(error.code!=='ENOENT')throw error;}}
  for(const file of [stateFile,stateFile+'.lock']){assert.ok(file.startsWith(physicalRuntime+sep)&&file.includes(workspace));await rm(file,{force:true});}
  console.log('CLEANUP only the generated check workspace/schema; human review datasets untouched');
}
