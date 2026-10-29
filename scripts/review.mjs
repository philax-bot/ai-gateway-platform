import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPersistentReview} from './lib/review-state.mjs';
import {openHigress} from './lib/higress-runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),children=[],serviceToken=randomUUID();
const persistent=process.argv.includes('--postgres'),prebuilt=process.argv.includes('--prebuilt');
const development=process.argv.includes('--dev');
const port=(key,fallback)=>{const value=Number(process.env[key]??fallback);if(!Number.isSafeInteger(value)||value<1024||value>65535)throw new Error(`${key} 必须是 1024–65535 的端口`);return value;};
let ports={web:port('REVIEW_WEB_PORT',persistent?5176:5173),control:port('REVIEW_CONTROL_PORT',persistent?4301:4001),gateway:port('REVIEW_GATEWAY_PORT',persistent?4300:4000),model:port('REVIEW_MODEL_PORT',persistent?4310:4010)};
if(new Set(Object.values(ports)).size!==4)throw new Error('四个审查端口必须互不相同');
let hostname=process.env.REVIEW_HOSTNAME??(persistent?'localhost':'127.0.0.1');if(!['127.0.0.1','localhost'].includes(hostname))throw new Error('REVIEW_HOSTNAME 仅支持 127.0.0.1 或 localhost');
const url=key=>`http://${hostname}:${ports[key]}`;
// These published accounts exist only in an isolated, loopback-only development review workspace.
const password='Review-local-2026!',accounts=[
  {login:'review-ops',name:'审查运营',role:'运营管理员'},
  {login:'review-employee',name:'审查员工',role:'已开通个人与项目使用'},
  {login:'review-manager',name:'审查经理',role:'项目经理，可处理成员申请'},
  {login:'review-app',name:'审查应用负责人',role:'应用接入，无个人额度'},
  {login:'review-new',name:'待开通同事',role:'个人申请执行失败，供修正重试'},
];
// Review-only opt-in: the root .env may enable external verification and supply
// named upstream credentials. Values reach the control plane only, never the web build.
let localEnv={};try{localEnv=parseEnv(await readFile(resolve(root,'.env'),'utf8'));}catch{}
const allowUpstreamValidation=(process.env.REVIEW_ALLOW_UPSTREAM_VALIDATION??localEnv.REVIEW_ALLOW_UPSTREAM_VALIDATION)==='true';
// Review-only opt-in: without this, the data plane stays loopback-only even when
// an external service is configured and verified in the control plane.
const allowUpstreamRequests=(process.env.REVIEW_ALLOW_UPSTREAM_REQUESTS??localEnv.REVIEW_ALLOW_UPSTREAM_REQUESTS)==='true';
const dataPlane=process.env.REVIEW_DATA_PLANE??localEnv.REVIEW_DATA_PLANE??(development?'higress':'direct');
if(!['direct','higress'].includes(dataPlane))throw new Error('REVIEW_DATA_PLANE 必须是 direct 或 higress');
const upstreamEnvironment=Object.fromEntries(Object.entries({...localEnv,...process.env}).filter(([key])=>key.startsWith('UPSTREAM_')));
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('UPSTREAM_')&&!key.startsWith('VITE_')&&!key.startsWith('HIGRESS_')&&key!=='GATEWAY_DATA_PLANE'));
let directory,closing=false,ready=false,persistentState,higress;
function start(file,args=[],extra={},cwd=root){
  const child=spawn(process.execPath,[resolve(root,file),...args],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...environment,PLATFORM_MODE:'development',DATABASE_SCHEMA:'',DATABASE_URL:'',REDIS_URL:'',PGOPTIONS:'',STORE_MODE:'memory',HOST:'127.0.0.1',DOTENV_CONFIG_PATH:resolve(directory,'unused.env'),SERVICE_TOKEN:serviceToken,BOOTSTRAP_TOKEN:'',COOKIE_SECURE:'false',MOCK_API_TOKEN:'',ALLOW_UPSTREAM_VALIDATION:'false',ALLOW_UPSTREAM_REQUESTS:'false',WEB_ORIGIN:url('web'),...extra}});
  let output='';child.stdout.on('data',v=>output=(output+v).slice(-5000));child.stderr.on('data',v=>output=(output+v).slice(-5000));child.on('error',e=>{output+=e.message;});child.diagnostic=()=>output;children.push(child);
  child.on('exit',code=>{if(ready&&!closing){console.error(`审查服务意外退出（${code}）：${output}`);void stop(1);}});
  return child;
}
async function stop(code=0){if(closing)return;closing=true;for(const child of [...children].reverse()){if(child.exitCode!==null||child.signalCode!==null||!child.pid)continue;child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref();});}await higress?.close();await persistentState?.release();console.log(persistent?'审查服务已停止；审查库、状态文件和日记保留，下次使用同一命令继续。':'审查服务已停止；内存业务数据已清空，运行日记保留在本次目录。');process.exit(code);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
// Private parent/child channel used by the restart check; no network shutdown endpoint.
process.on('message',message=>{if(message?.type==='stop-review')void stop();});
async function waitFor(address,child){for(let n=0;n<120;n++){if(child.exitCode!==null||!child.pid)throw new Error(child.diagnostic()||'服务启动失败');try{if((await fetch(address,{signal:AbortSignal.timeout(400)})).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error(`服务启动超时：${address}\n${child.diagnostic()}`);}
async function checkPort(value){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Error(`本地端口 ${value} 已占用。停止原服务，或通过 REVIEW_*_PORT 指定其他端口后重试。`)));server.listen(value,'127.0.0.1',resolve);});await new Promise(resolve=>server.close(resolve));}
async function build(){
  const executable=process.env.npm_execpath;if(!executable)throw new Error('请使用 pnpm dev 启动，以便先构建最新源码');
  const env={...environment,VITE_CONTROL_PLANE_URL:url('control'),VITE_GATEWAY_URL:url('gateway'),VITE_REVIEW_MODE:'true',VITE_REVIEW_STORAGE:persistent?'postgres':'memory'};
  const script=/\.(c?js|mjs)$/i.test(executable),cmd=/\.cmd$/i.test(executable);
  async function complete(child){children.push(child);await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`构建失败（${code}）`)));});}
  async function pnpm(tasks){
    const command=script?process.execPath:cmd?(process.env.ComSpec??'cmd.exe'):executable,args=script?[executable,...tasks]:cmd?['/d','/s','/c',`pnpm ${tasks.join(' ')}`]:tasks;
    await complete(spawn(command,args,{cwd:root,env,windowsHide:true,stdio:'inherit'}));
  }
  if(!prebuilt)await pnpm(['-r','--filter','!@ai-gateway/web','build']);
  await pnpm(['--filter','@ai-gateway/web','typecheck']);
  if(development)return;
  // Each workspace builds its own environment-bound assets; simultaneous reviews
  // must not copy another workspace's URLs or storage banner from shared dist.
  await complete(spawn(process.execPath,[resolve(root,'apps/web/node_modules/vite/bin/vite.js'),'build','--outDir',resolve(directory,'web'),'--emptyOutDir'],{cwd:resolve(root,'apps/web'),env,windowsHide:true,stdio:'inherit'}));
}
async function seed(){
  let cookie='';
  async function api(path,body){const response=await fetch(`${url('control')}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const value=await response.json();if(!response.ok)throw Object.assign(new Error(`${path}: ${value.message??response.status}`),{status:response.status,apiMessage:value.message});return value;}
  async function login(directoryId){await api('/api/v1/auth/login',{directoryId,password});}
  let step=0;async function command(type,payload){
    const c={type,payload,idempotencyKey:persistentState?`review-seed-${persistentState.state.id}-${++step}`:randomUUID()};
    // Ask for the original result first: a new preview can legitimately reject an
    // already-created member or grant. Only a new command needs a fresh preview.
    if(persistentState)try{return (await api('/api/v1/platform/commands',c)).result;}catch(error){if(error.status!==409||error.apiMessage!=='impact preview required')throw error;}
    const preview=await api('/api/v1/platform/preview',c);return (await api('/api/v1/platform/commands',{...c,previewToken:preview.previewToken})).result;
  }
  if((await api('/api/v1/auth/bootstrap')).required)await api('/api/v1/auth/setup',{name:accounts[0].name,directoryId:accounts[0].login,password});await login(accounts[0].login);
  const state=await api('/api/v1/platform/state'),users=new Map([[accounts[0].login,state.actor.id]]),range={poolId:state.pools[0].id,mode:'follow',definitionIds:[]};
  const service=state.services[0];await command('save.service',{id:service.id,name:'本地审查模型服务',baseUrl:`${url('model')}/v1`,credentialRef:null,active:true,limits:{mode:'inherit'},mappings:service.mappings.map(m=>({definitionId:m.definitionId,upstreamModel:m.upstreamModel,inputPrice:2,outputPrice:3,cachedInputPrice:0.5,limits:{mode:'inherit'}}))});await api(`/api/v1/platform/services/${service.id}/verify`,{});
  await command('save.pool',{id:state.pools[0].id,name:'日常使用模型池',entries:[{definitionId:state.definitions[0].id,serviceId:service.id,open:true}],limits:{mode:'inherit'}});
  await command('settings.update',{name:'Signal Atlas · 人工审查',personalDefaultPoolId:range.poolId,projectDefaultPoolId:range.poolId});
  for(const account of accounts.slice(1)){const member=await command('save.member',{name:account.name,directoryId:account.login,organizationId:'department-engineering',password});users.set(account.login,member.id);}
  const plan=await command('save.plan',{name:'日常办公标准方案',range,amount:20,cadence:'monthly',quotaDays:30,entitlementDays:365});await command('distribution.execute',{planId:plan.id,memberIds:[users.get('review-employee')]});
  const project=await command('save.project',{name:'知识助手试点',description:'供经理添加成员、分配预算和审查项目使用。',managerId:users.get('review-manager'),range});await command('project.members',{projectId:project.id,memberIds:[users.get('review-employee')]});const expiry=new Date((persistentState?Date.parse(persistentState.state.createdAt):Date.now())+30*86400000).toISOString();
  const budget=await command('project.fund',{projectId:project.id,amount:100,expiresAt:expiry});await command('project.allocate',{projectId:project.id,memberId:users.get('review-employee'),sourceBatchId:budget.id,amount:10});
  const app=await command('save.application',{name:'工单归纳助手',description:'供应用负责人查看独立额度、签发密钥并接入外部工具。',ownerId:users.get('review-app'),organizationId:'department-engineering',range});await command('application.fund',{applicationId:app.id,amount:30,expiresAt:expiry});
  await login('review-employee');await command('approval.submit',{kind:'project_member_quota',objectId:project.id,amount:5,expiresAt:budget.expiresAt,scenario:'试点项目继续使用',reason:'请经理审批并从原项目预算分配。'});
  await login('review-new');const failed=await command('approval.submit',{kind:'personal_open',amount:12,expiresAt:expiry,scenario:'首次使用 AI',reason:'请运营修正原批准方案后开通。'});
  await login('review-ops');await command('approval.decide',{id:failed.id,decision:'approve',amount:8,expiresAt:expiry,planId:'review-missing-plan',reason:'审查案例：原方案选择错误，尚未开通'});
  const failure=await fetch(`${url('control')}/api/v1/platform/commands`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({type:'approval.execute',payload:{id:failed.id},idempotencyKey:randomUUID()})});if(failure.status!==404)throw new Error('执行失败案例未按预期生成');
  const appDetail=await api(`/api/v1/platform/applications/${app.id}`);if(appDetail.status!=='ready'||appDetail.keys.length)throw new Error('应用接入准备状态不符合审查场景');
  const objects={project:project.id,application:app.id,failedApproval:failed.id};await writeFile(resolve(directory,'review.json'),JSON.stringify({mode:persistent?'local-postgres-review':'local-memory-review',schema:persistentState?.state.schema,createdAt:new Date().toISOString(),ports,accounts:accounts.map(a=>({login:a.login,name:a.name,role:a.role})),objects,guide:'docs/MANUAL-REVIEW.md'},null,2));return objects;
}
try{
  if(persistent){persistentState=await openPersistentReview({root,workspace:process.env.REVIEW_WORKSPACE??'default',ports,hostname,preflight:p=>Promise.all(Object.values(p).map(checkPort))});directory=persistentState.directory;ports=persistentState.state.ports;hostname=persistentState.state.hostname;}
  else {await Promise.all(Object.values(ports).map(checkPort));const runtime=resolve(root,'.runtime');await mkdir(runtime,{recursive:true});if(!(await realpath(runtime)).startsWith((await realpath(root))+sep))throw new Error('运行目录必须位于当前工作区');directory=resolve(runtime,`review-${randomUUID()}`);await mkdir(directory);}
  console.log(persistent?'正在准备持久审查版本，仅使用独立审查库与本地模型替身…':'正在构建人工审查版本，仅使用本地内存与模型替身…');await build();
  if(dataPlane==='higress')higress=await openHigress({root,directory:resolve(directory,'higress'),persistent:true,localModelPort:ports.model});
  const dispatchEnvironment=higress?.environment??{GATEWAY_DATA_PLANE:'direct'};
  const model=start('postman/mocks/test-model/default.js',[],{PORT:String(ports.model),REVIEW_MODEL:'true'}),control=start('apps/control-plane/dist/main.js',[],{PORT:String(ports.control),PUBLIC_GATEWAY_URL:url('gateway'),ALLOW_UPSTREAM_VALIDATION:allowUpstreamValidation?'true':'false',...upstreamEnvironment,...dispatchEnvironment,...(persistentState?{STORE_MODE:'postgres',DATABASE_URL:persistentState.connectionString,DATABASE_SCHEMA:persistentState.state.schema}:{})}),gateway=start('services/gateway-sim/dist/server.js',[],{PORT:String(ports.gateway),CONTROL_PLANE_URL:url('control'),MODEL_URL:url('model'),GATEWAY_JOURNAL_DIR:resolve(directory,'journal'),ALLOW_UPSTREAM_REQUESTS:allowUpstreamRequests?'true':'false',...(higress?{}:allowUpstreamRequests?upstreamEnvironment:{}),...(higress?.gatewayEnvironment??dispatchEnvironment)});
  await Promise.all([waitFor(`${url('model')}/health`,model),waitFor(`${url('control')}/health`,control),waitFor(`${url('gateway')}/health`,gateway)]);
  if(!persistentState?.state.ready){const objects=await seed();await persistentState?.markReady(objects);}else console.log('已恢复原审查工作区；不会重建账号、重置配置或重复发放。');
  if(higress){const response=await fetch(`${url('control')}/internal/v1/gateway-sync/reconcile`,{method:'POST',headers:{authorization:`Bearer ${serviceToken}`},signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('Higress 路由准备失败');const result=await response.json();console.log(`Higress 已准备 ${result.routes.filter(route=>route.status==='applied').length}/${result.routes.length} 条路由；未生效路由会拦截调用。`);}
  const web=start('apps/web/node_modules/vite/bin/vite.js',development?['--host','127.0.0.1','--port',String(ports.web),'--strictPort']:['preview','--host','127.0.0.1','--port',String(ports.web),'--strictPort','--outDir',resolve(directory,'web')],development?{VITE_CONTROL_PLANE_URL:url('control'),VITE_GATEWAY_URL:url('gateway'),VITE_REVIEW_MODE:'true',VITE_REVIEW_STORAGE:'postgres'}:{},resolve(root,'apps/web'));await waitFor(url('web'),web);ready=true;
  if(development)console.log('本地开发：pnpm dev；前端热更新，后端改动后 Ctrl+C 并重新运行 pnpm dev。');
  process.send?.({type:'review-ready',pids:children.filter(child=>child.exitCode===null&&child.signalCode===null).map(child=>child.pid)});
  console.log(`\n人工审查入口：${url('web')}\n初始审查账号密码：${password}\n${accounts.map(a=>`${a.login}  ${a.name}  ${a.role}`).join('\n')}\n审查清单：docs/MANUAL-REVIEW.md\n外部模型连接验证：${allowUpstreamValidation?'已开启':'未开启（在根 .env 设置 REVIEW_ALLOW_UPSTREAM_VALIDATION=true 可开启）'}\n外部模型调用：${allowUpstreamRequests?'已开启':'未开启（在根 .env 设置 REVIEW_ALLOW_UPSTREAM_REQUESTS=true 可开启）'}\n${persistent?'按 Ctrl+C 停止；审查数据和日记保留，下次用同一命令继续。':'按 Ctrl+C 停止；重启清空本次业务操作。'}运行目录：${directory}${persistentState?'\n审查状态文件：'+persistentState.stateFile:''}`);
}catch(error){console.error(error instanceof Error?error.message:error);await stop(1);}
