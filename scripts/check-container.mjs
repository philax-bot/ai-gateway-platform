import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {chmod,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';

const root=process.cwd(),id=randomUUID(),project='atlas_check_'+id.replaceAll('-','').slice(0,16),runtime=resolve(root,'.runtime'),directory=resolve(runtime,'container-check-'+id);
const envFile=resolve(directory,'runtime.env'),override=resolve(directory,'compose.check.yml'),tls=resolve(directory,'tls'),upstreams=resolve(directory,'upstreams.env');
const compose=['compose','--project-name',project,'--env-file',envFile,'-f',resolve(root,'deploy/compose.yml'),'-f',override];
const password=randomUUID().replaceAll('-',''),serviceToken=randomUUID()+randomUUID(),bootstrapToken=randomUUID()+randomUUID();
const check=(condition,message)=>{assert.ok(condition,message);assertions++;};let assertions=0,created=false,passed=false,phase='preparation',ca,origin,cookie='';
async function command(executable,args){
  const child=spawn(executable,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',v=>output=(output+v).slice(-16000));child.stderr.on('data',v=>output=(output+v).slice(-16000));
  await new Promise((done,fail)=>{child.once('error',()=>fail(new Error(`${executable} is unavailable`)));child.once('exit',code=>code===0?done():fail(new Error(`${executable} failed (${code}) during ${phase}: ${output.replaceAll(password,'[redacted]').replaceAll(serviceToken,'[redacted]').replaceAll(bootstrapToken,'[redacted]')}`)));});return output;
}
const docker=(...args)=>command('docker',args),stack=(...args)=>docker(...compose,...args);
async function request(path,body,headers={}){
  return new Promise((done,fail)=>{
    const req=httpsRequest(new URL(path,origin),{ca,method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),...headers,...(body===undefined?{}:{'content-type':'application/json'})}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',value=>text+=value);res.on('end',()=>{let value;try{value=JSON.parse(text);}catch{value=text;}done({status:res.statusCode,headers:res.headers,body:value,text});});
    });req.on('error',fail);req.setTimeout(15000,()=>req.destroy(new Error('HTTPS check timed out')));if(body!==undefined)req.write(JSON.stringify(body));req.end();
  });
}
try{
  await docker('info','--format','{{.OSType}}');await mkdir(directory,{recursive:true,mode:0o700});await mkdir(tls);
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));origin=`https://localhost:${port}`;
  if(process.platform==='win32')await command('pwsh',['-NoProfile','-File',resolve(root,'scripts/check-container-cert.ps1'),'-OutputDirectory',tls]);
  else await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',resolve(tls,'privkey.pem'),'-out',resolve(tls,'fullchain.pem'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
  ca=await readFile(resolve(tls,'fullchain.pem'));
  // Fixture key readable by the non-root Nginx UID; its parent check directory remains private on the host.
  if(process.platform!=='win32')await chmod(resolve(tls,'privkey.pem'),0o644);
  // Certificate/key are temporary localhost fixtures; no host trust-store changes.
  const backups=resolve(directory,'backups');await mkdir(backups,{mode:0o777});if(process.platform!=='win32')await chmod(backups,0o777);
  const mockToken=`container-model-${id}-$literal#`;await writeFile(upstreams,`UPSTREAM_CHECK=${mockToken}\nMOCK_API_TOKEN=${mockToken}\n`,{mode:0o600});
  await writeFile(envFile,`PUBLIC_ORIGIN=${origin}\nHTTPS_PORT=${port}\nBIND_ADDRESS=127.0.0.1\nDATABASE_URL=postgresql://atlas:${password}@check-db:5432/atlas_check\nDATABASE_SCHEMA=signal_atlas\nSERVICE_TOKEN=${serviceToken}\nBOOTSTRAP_TOKEN=${bootstrapToken}\nTLS_DIRECTORY=${tls.replaceAll('\\','/')}\nBACKUP_DIRECTORY=${backups.replaceAll('\\','/')}\nUPSTREAM_ENV_FILE=${upstreams.replaceAll('\\','/')}\n`,{mode:0o600});
  await writeFile(resolve(directory,'init.sql'),'create schema signal_atlas authorization atlas;\n');
  const mount=(source,target)=>`{type: bind, source: ${JSON.stringify(source.replaceAll('\\','/'))}, target: ${target}, read_only: true}`;
  await writeFile(override,`services:
  check-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: atlas_check
      POSTGRES_USER: atlas
      POSTGRES_PASSWORD: ${password}
    volumes:
      - check_database:/var/lib/postgresql/data
      - ${mount(resolve(directory,'init.sql'),'/docker-entrypoint-initdb.d/001-schema.sql')}
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U atlas -d atlas_check']
      interval: 2s
      timeout: 3s
      retries: 30
  check-model:
    image: node:22-alpine
    command: [node, /mock/default.js]
    environment: {PORT: '4010', HOST: '0.0.0.0', REVIEW_MODEL: 'true'}
    env_file: [{path: ${JSON.stringify(upstreams.replaceAll('\\','/'))}, format: raw}]
    volumes:
      - ${mount(resolve(root,'postman/mocks/test-model/default.js'),'/mock/default.js')}
  control-plane:
    environment: {ALLOW_UPSTREAM_VALIDATION: 'true'}
    depends_on:
      check-db: {condition: service_healthy}
  gateway:
    environment: {ALLOW_UPSTREAM_REQUESTS: 'true'}
volumes:
  check_database:
`);
  phase='image build';console.log('CHECK build server, HTTPS Web and native backup images (private configuration excluded from context)');await stack('--profile','tools','build');
  phase='isolated startup';console.log('CHECK start independent database, journal volume and HTTPS entry');created=true;await stack('up','-d','--wait','--wait-timeout','180');
  console.log('CHECK HTTPS installation, session, controlled route, SSE and persistent volume');
  check((await stack('exec','-T','control-plane','node','-e',"const fs=require('node:fs');console.log(['.env','apps/control-plane/.env','deploy/runtime.env'].some(p=>fs.existsSync(p))?'unexpected-private-file':'clean')")).trim()==='clean','server image contains no host connection configuration');
  check((await request('/')).text.includes('<div id="root">'),'HTTPS serves built Web');
  check((await request('/internal/v1/policy/credentials/resolve',{})).status===404,'HTTPS entry does not expose internal policy endpoints');
  check((await request('/api/v1/auth/bootstrap')).body.tokenRequired===true,'HTTPS bootstrap reaches empty production installation');
  const user={directoryId:'container-ops',name:'容器审查运营',password:'Review-local-2026!'};
  check((await request('/api/v1/auth/setup',{...user,bootstrapToken})).status===200,'installation token creates first operator through TLS');
  const signed=await request('/api/v1/auth/login',user),setCookie=signed.headers['set-cookie']?.[0]??'';check(signed.status===200&&setCookie.includes('Secure')&&setCookie.includes('HttpOnly'),'HTTPS login emits secure session');cookie=setCookie.split(';')[0];
  let state=(await request('/api/v1/platform/state')).body;check(state.members.length===1&&state.definitions.length===0&&state.quotaBatches.length===0,'production image has no demonstration models, money or accounts');
  async function execute(type,payload){const command={type,payload,idempotencyKey:randomUUID()},preview=await request('/api/v1/platform/preview',command);assert.equal(preview.status,200);const result=await request('/api/v1/platform/commands',{...command,previewToken:preview.body.previewToken});assert.equal(result.status,200);return result.body.result;}
  const definition=await execute('save.definition',{name:'容器本地验证模型',modelId:'test-model',contextTokens:32768});
  const service=await execute('save.service',{name:'本地模型替身',baseUrl:'http://check-model:4010',credentialRef:'UPSTREAM_CHECK',mappings:[{definitionId:definition.id,upstreamModel:'test-model',inputPrice:2,outputPrice:3,cachedInputPrice:0.5,limits:{mode:'inherit'}}]});
  const verified=await request(`/api/v1/platform/services/${service.id}/verify`,{});assert.equal(verified.status,200,'isolated mock validation must be explicitly enabled');check(verified.body.verification==='passed','container control plane reaches configured local model');
  const pool=await execute('save.pool',{name:'容器审查池',entries:[{definitionId:definition.id,serviceId:service.id,open:true}]});
  const plan=await execute('save.plan',{name:'容器审查方案',range:{poolId:pool.id,mode:'follow',definitionIds:[]},amount:10,cadence:'once',quotaDays:30,entitlementDays:30});await execute('distribution.execute',{planId:plan.id,memberIds:[state.actor.id]});
  const issued=await execute('key.issue',{name:'容器测试密钥',purpose:'personal'}),callHeaders={authorization:`Bearer ${issued.secret}`},body={model:'test-model',messages:[{role:'user',content:'container local verification'}],max_tokens:32};
  check((await request('/v1/chat/completions',body,callHeaders)).status===200,'public HTTPS endpoint completes managed model request');
  // First SSE data must arrive before the stand-in's delayed final usage, proving proxy buffering is disabled.
  const started=Date.now();let firstAt=0,stopped;const stream=await new Promise((done,fail)=>{const req=httpsRequest(new URL('/v1/chat/completions',origin),{ca,method:'POST',headers:{...callHeaders,'content-type':'application/json'}},res=>{let text='';res.on('data',value=>{if(!firstAt){firstAt=Date.now();stopped=stack('stop','gateway');}text+=value;});res.on('end',()=>done({status:res.statusCode,text}));});req.on('error',fail);req.setTimeout(15000,()=>req.destroy(new Error('SSE check timed out')));req.end(JSON.stringify({...body,stream:true,test_scenario:'delayed'}));});
  check(stream.status===200&&stream.text.includes('data: [DONE]')&&firstAt>started&&Date.now()-firstAt>=1000,'HTTPS proxy forwards SSE chunks before final usage and DONE');
  await stopped;const stoppedGateway=(await stack('ps','-a','-q','gateway')).trim();check((await docker('inspect',stoppedGateway,'--format','{{.State.ExitCode}}')).trim()==='0','SIGTERM during an active TLS stream drains settlement and exits normally');
  state=(await request('/api/v1/platform/state')).body;check(state.callLogs.length===2&&state.quotaBatches[0].availableAmount<10,'TLS calls settle to original authoritative quota batch');const funds=JSON.stringify(state.quotaBatches);
  phase='container recreation';await stack('up','-d','--force-recreate','--wait','--wait-timeout','180','control-plane','gateway','web');
  state=(await request('/api/v1/platform/state')).body;check(state.callLogs.length===2&&JSON.stringify(state.quotaBatches)===funds&&state.members.length===1,'container recreation preserves login session, quota and call history');
  const health=JSON.parse(await stack('exec','-T','gateway','node','-e',"fetch('http://127.0.0.1:4000/health').then(r=>r.text()).then(console.log)"));check(health.dataPlane==='controlled-proxy'&&health.outbox.queued===0,'recreated gateway opens the same persistent journal volume');
  const listing=(await stack('ps','--format','json')).trim(),containers=listing.startsWith('[')?JSON.parse(listing):listing.split('\n').map(line=>JSON.parse(line));
  const privateServices=containers.filter(c=>['control-plane','gateway','check-db'].includes(c.Service));
  check(privateServices.length===3&&privateServices.every(c=>!c.Publishers?.some(p=>p.PublishedPort>0)),'database and internal services publish no host ports');
  phase='container native backup';console.log('CHECK stopped-volume backup and native restore inside the isolated Compose network');
  await stack('stop','web','gateway','control-plane');
  await stack('run','--rm','--no-deps','operations','scripts/backup.mjs','backup','--out','/backups/roundtrip','--journal','/journals/gateway-001');
  const manifest=JSON.parse(await readFile(resolve(backups,'roundtrip/manifest.json'),'utf8'));check(manifest.mode==='production'&&manifest.migrations.length===9&&manifest.journals.length===1,'operations image backs up original schema and stopped persistent journal');
  // Both schemas belong only to this generated disposable PostgreSQL container.
  await stack('exec','-T','check-db','psql','-U','atlas','-d','atlas_check','-v','ON_ERROR_STOP=1','-c','alter schema signal_atlas rename to signal_atlas_before_restore');
  await stack('run','--rm','--no-deps','operations','scripts/backup.mjs','restore','--from','/backups/roundtrip','--journal-root','/journals/gateway-001/restored');
  await writeFile(envFile,(await readFile(envFile,'utf8'))+'GATEWAY_JOURNAL_PATH=/var/lib/signal-atlas/journal/restored/gateway-001\n',{mode:0o600});
  await stack('up','-d','--force-recreate','--wait','--wait-timeout','180','control-plane','gateway','web');
  state=(await request('/api/v1/platform/state')).body;check(state.callLogs.length===2&&JSON.stringify(state.quotaBatches)===funds,'container native restore preserves original session, ledger and call history');
  check((await request('/v1/chat/completions',body,callHeaders)).status===200,'same key works after container native restoration');
  state=(await request('/api/v1/platform/state')).body;check(state.callLogs.length===3,'post-restore container request adds one authoritative log');
  await writeFile(resolve(directory,'review.json'),JSON.stringify({project,origin,assertions,completedAt:new Date().toISOString(),username:user.directoryId,password:user.password,envFile,override},null,2));passed=true;
  console.log(`PASS ${assertions} isolated container/TLS assertions`);
  if(process.argv.includes('--keep'))console.log(`Retained local review: ${origin}\nAccount: ${user.directoryId} / ${user.password}\nPrivate runtime and stop parameters: ${directory}`);
}catch(error){console.error(error.message);if(created)try{console.error(await stack('logs','--no-color','--tail','20','web'));}catch{}process.exitCode=1;}
finally{
  if(!passed||!process.argv.includes('--keep')){
    phase='owned container cleanup';if(created)await stack('down','--volumes','--remove-orphans');
    try{const physical=await realpath(directory),base=await realpath(runtime);assert.ok(physical.startsWith(base+sep)&&/^container-check-[a-f0-9-]{36}$/.test(physical.split(/[\\/]/).pop()));await rm(physical,{recursive:true,force:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    console.log('CLEANUP only this generated Compose project, volumes and check directory');
  }
}
