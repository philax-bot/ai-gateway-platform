import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openHigress,freePort} from './lib/higress-runtime.mjs';
import {connectionConfig} from './lib/backup.mjs';
import {captureDefaultState} from './higress/business-checks.mjs';
import {collectWebEvidence} from './higress/web-evidence.mjs';

// Isolated, browser-driven task acceptance. Never reads live model credentials.
// Read session.json for the owned URL/accounts; write finish.json after UI work.
const root=process.cwd(),id=randomUUID(),directory=resolve(root,'.runtime',`higress-web-${id}`);
const schema=`agp_hg_${id.replaceAll('-','')}`,token=randomUUID(),password=randomUUID();
const require=createRequire(resolve(root,'apps/control-plane/package.json')),{Pool}=require('pg');
const {resourceId}=require(resolve(root,'apps/control-plane/dist/gateway/higress.resources.js'));
const children=[],secrets=[token,password],pause=ms=>new Promise(r=>setTimeout(r,ms));
const report={success:false,id,createdAt:new Date().toISOString(),scope:{database:'isolated PostgreSQL',dataPlane:'real Higress',model:'local deterministic fixture',realModelRequests:0},checks:[]};
const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^UPSTREAM_|^HIGRESS_|^GATEWAY_|^DATABASE_|^VITE_|^PGOPTIONS$|^NODE_OPTIONS$/.test(key)));
let db,hg,common,cp,cookie='',before,stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
function start(file,args,env={},cwd=root){const child=spawn(process.execPath,[resolve(root,file),...args],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clean,...common,...env}});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>output=(output+data).slice(-8000));child.output=()=>output;children.push(child);return child;}
async function ready(url,child){for(let n=0;n<200;n++){if(child.exitCode!==null)throw Error(child.output());try{if((await fetch(url,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await pause(100);}throw Error('readiness timeout '+url);}
async function api(path,body){const response=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const value=await response.json();if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];assert.equal(response.status,200,`${path}: ${response.status} ${JSON.stringify(value)}`);return value;}
const state=()=>api('/api/v1/platform/state');
async function command(type,payload){const input={type,payload,idempotencyKey:randomUUID()},preview=await api('/api/v1/platform/preview',input);return (await api('/api/v1/platform/commands',{...input,previewToken:preview.previewToken})).result;}
try{
  await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'empty.env'),'');
  const {connectionString}=await connectionConfig();db=new Pool({connectionString,connectionTimeoutMillis:5000});db.on('error',()=>{});before=await captureDefaultState({root,db});await writeFile(resolve(directory,'before.json'),JSON.stringify(before,null,2));await db.query(`create schema "${schema}"`);
  hg=await openHigress({root,directory:resolve(directory,'runtime'),fixture:true});secrets.push(hg.state.apiToken,hg.state.proxyToken,hg.state.modelToken);
  const [controlPort,gatewayPort,webPort]=await Promise.all([freePort(),freePort(),freePort()]);cp=`http://127.0.0.1:${controlPort}`;const gateway=`http://127.0.0.1:${gatewayPort}`,web=`http://127.0.0.1:${webPort}`;
  common={PLATFORM_MODE:'development',HOST:'127.0.0.1',WEB_ORIGIN:web,DOTENV_CONFIG_PATH:resolve(directory,'empty.env'),STORE_MODE:'postgres',DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PGOPTIONS:'',PGAPPNAME:schema,REDIS_URL:'',NODE_OPTIONS:'',BOOTSTRAP_TOKEN:'',SERVICE_TOKEN:token,COOKIE_SECURE:'false',ALLOW_UPSTREAM_REQUESTS:'true',ALLOW_UPSTREAM_VALIDATION:'true',MAINTENANCE_DISABLED:'true',...hg.environment,UPSTREAM_PROVIDER_FIXTURE:hg.state.modelToken,HIGRESS_REQUIRE_RUNTIME_READY:'true'};
  const control=start('apps/control-plane/dist/main.js',[],{PORT:String(controlPort)});await ready(cp+'/health',control);
  const gw=start('services/gateway-sim/dist/server.js',[],{PORT:String(gatewayPort),CONTROL_PLANE_URL:cp,GATEWAY_JOURNAL_DIR:resolve(directory,'journal'),UPSTREAM_TIMEOUT_MS:'10000',UPSTREAM_FIRST_BYTE_TIMEOUT_MS:'3000',UPSTREAM_IDLE_TIMEOUT_MS:'3000'});await ready(gateway+'/health',gw);
  const admin={directoryId:'web-operator',name:'审核运营',password};await api('/api/v1/auth/setup',admin);await api('/api/v1/auth/login',admin);
  const original=(await state()).services[0];const service=await command('save.service',{...original,name:'浏览器验收本地服务',baseUrl:'http://model.poc.test:4010/v1',credentialRef:'UPSTREAM_PROVIDER_FIXTURE',active:true,limits:{mode:'custom',rpm:1000,concurrency:10,maxOutputTokens:128},mappings:[{...original.mappings[0],upstreamModel:'physical-model',inputPrice:2,outputPrice:8,cachedInputPrice:.5}]});
  const route={provider:'higress',resourceType:'model_route',resourceId:resourceId({serviceId:service.id,definitionId:service.mappings[0].definitionId}),desiredVersion:'web-v1',previousVersion:null,idempotencyKey:randomUUID(),spec:{serviceId:service.id,definitionId:service.mappings[0].definitionId}};
  const published=await fetch(cp+'/internal/v1/gateway-sync',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(route)}).then(r=>r.json());assert.equal(published.status,'applied');
  assert.equal((await api(`/api/v1/platform/services/${service.id}/verify`,{})).verification,'passed');
  const pool=await command('save.pool',{id:'pool-local-test',name:'浏览器验收模型池',entries:[{definitionId:service.mappings[0].definitionId,serviceId:service.id,open:true}]});
  const range={poolId:pool.id,mode:'follow',definitionIds:[]};const plan=await command('save.plan',{name:'浏览器办公方案',range,amount:.2,cadence:'monthly',quotaDays:30,entitlementDays:365});
  const accounts={operator:admin};for(const [role,name]of [['employee','审核新员工'],['manager','审核项目经理'],['owner','审核应用负责人']]){const member=await command('save.member',{name,directoryId:'web-'+role,password,organizationId:'department-engineering',category:'employee',roles:['employee'],tags:[]});accounts[role]={directoryId:'web-'+role,password,name,id:member.id};}
  const project=await command('save.project',{initialAmount:1,validity:'permanent',name:'浏览器验收项目',managerId:accounts.manager.id,range});await command('project.members',{projectId:project.id,memberIds:[accounts.employee.id]});
  const application=await command('save.application',{initialAmount:1,validity:'permanent',billingMode:'quota',name:'浏览器验收应用',ownerId:accounts.owner.id,organizationId:'org-demo',range});
  const webProcess=start('apps/web/node_modules/vite/bin/vite.js',['--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_CONTROL_PLANE_URL:cp,VITE_GATEWAY_URL:gateway,VITE_REVIEW_MODE:'true',VITE_REVIEW_STORAGE:'postgres'},resolve(root,'apps/web'));await ready(web,webProcess);
  const session={id,directory,web: web+'/?ui=beacon',control:cp,gateway,schema,accounts,planId:plan.id,projectId:project.id,applicationId:application.id};await writeFile(resolve(directory,'session.json'),JSON.stringify(session,null,2));console.log(JSON.stringify({ready:true,directory,web:session.web}));
  let finish;
  while(!stopping){try{finish=JSON.parse(await readFile(resolve(directory,'finish.json'),'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}for(const child of children)if(child.exitCode!==null)throw Error(child.output());await pause(500);}
  assert.ok(finish,'browser acceptance interrupted');
  const applicationCalls=JSON.parse(await readFile(resolve(directory,'application-calls.json'),'utf8'));
  Object.assign(report,await collectWebEvidence({root,db,session,browser:finish,applicationCalls,before}));
  report.fixtureRequests=await fetch(hg.model+'/_poc/requests').then(r=>r.json());
  for(const call of report.calls)assert.equal(report.fixtureRequests.filter(r=>r.requestId===call.request_id).length,1,'one fixture inference per successful call');
  assert.ok(!report.fixtureRequests.some(r=>r.requestId===applicationCalls.find(c=>c.label==='disabled').requestId),'disabled Key never reaches the fixture');
}catch(error){report.success=false;report.error=secrets.reduce((s,key)=>s.replaceAll(key,'[redacted]'),error.stack??String(error));process.exitCode=1;}
finally{
  for(const child of children.toReversed())if(child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(2000)]);}
  await hg?.close();if(db){if(/^agp_hg_[a-f0-9]{32}$/.test(schema))await db.query(`drop schema if exists "${schema}" cascade`);await db.end();}
  report.completedAt=new Date().toISOString();const output=resolve(root,'.runtime/higress-web-results',id+'.json');await mkdir(resolve(root,'.runtime/higress-web-results'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  if(report.success){assert.equal(await realpath(directory),resolve(await realpath(resolve(root,'.runtime')),`higress-web-${id}`));await rm(directory,{recursive:true,force:true});}
  console.log(JSON.stringify({success:report.success,output,error:report.error}));
}
