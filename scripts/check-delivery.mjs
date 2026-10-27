import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,mkdir,realpath,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {checkBackup} from './check-backup.mjs';
const root=process.cwd(),require=createRequire(resolve(root,'apps/control-plane/package.json')),{Pool}=require('pg');
const config=require('dotenv').parse(await readFile(resolve(root,'apps/control-plane/.env')));
const db=new Pool({connectionString:process.env.DATABASE_URL||config.DATABASE_URL,connectionTimeoutMillis:5000,max:5});
const {applyMigrations,loadMigrations}=require(resolve(root,'apps/control-plane/dist/store/migrations.js'));
const migrations=loadMigrations(resolve(root,'apps/control-plane/migrations')),schemas=[],children=[];
const runtime=resolve(root,'.runtime'),directory=resolve(runtime,`delivery-check-${randomUUID()}`);let assertions=0;
const check=(value,message)=>{assert.ok(value,message);assertions++;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function ownedSchema(){const name=`agp_check_${randomUUID().replaceAll('-','')}`;await db.query(`create schema "${name}"`);schemas.push(name);return name;}
async function inSchema(schema,work){assert.ok(schemas.includes(schema)&&/^agp_check_[a-f0-9]{32}$/.test(schema));const client=await db.connect();try{await client.query(`set search_path to "${schema}"`);return await work(client);}finally{await client.query('reset search_path');client.release();}}
async function migrate(schema,items=migrations){return inSchema(schema,async client=>{await client.query('begin');try{const result=await applyMigrations(client,items);await client.query('commit');return result;}catch(error){await client.query('rollback');throw error;}});}
const migration=(version,name,sql)=>({version,name,sql,checksum:createHash('sha256').update(sql).digest('hex')});
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
function start(file,env){const safe=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('UPSTREAM_'))),child=spawn(process.execPath,[resolve(root,file)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...safe,DOTENV_CONFIG_PATH:resolve(directory,'unused.env'),DATABASE_URL:'',DATABASE_SCHEMA:'',PGOPTIONS:'',REDIS_URL:'',HOST:'127.0.0.1',...env}});let output='';child.stdout.on('data',v=>output=(output+v).slice(-6000));child.stderr.on('data',v=>output=(output+v).slice(-6000));child.diagnostic=()=>output;children.push(child);return child;}
async function stop(child){if(child.exitCode===null&&child.signalCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(2000)]);}}
async function ready(url,child){for(let n=0;n<120;n++){if(child.exitCode!==null)throw new Error('isolated delivery process exited before readiness');try{if((await fetch(url)).ok)return;}catch{}await pause(100);}throw new Error('isolated delivery process did not become ready');}
async function failsToStart(file,env){const child=start(file,env);const code=await Promise.race([new Promise(r=>child.once('exit',r)),pause(15000).then(()=>null)]);check(code!==null&&code!==0,'invalid production configuration exits without listening');await stop(child);return child;}
try{
  await mkdir(directory,{recursive:true});
  const clean=await ownedSchema(),parallel=await Promise.all([migrate(clean),migrate(clean)]);
  check(parallel.map(v=>v.applied).sort((a,b)=>a-b).join(',')===`0,${migrations.length}`,'concurrent startup applies each migration once');
  const ledger=await inSchema(clean,c=>c.query('select * from schema_migrations order by version'));
  check((await migrate(clean)).applied===0,'restart skips all applied SQL');check(JSON.stringify((await inSchema(clean,c=>c.query('select * from schema_migrations order by version'))).rows)===JSON.stringify(ledger.rows),'restart preserves migration timestamps/checksums');
  const changed=migrations.map((m,i)=>i===0?{...m,checksum:'0'.repeat(64)}:m);await assert.rejects(migrate(clean,changed),/Applied migration changed/);assertions++;
  const probeVersion=Math.max(...migrations.map(m=>m.version))+1;
  const future=migration(probeVersion,`${String(probeVersion).padStart(3,'0')}_probe.sql`,'create table migration_probe(value integer);insert into migration_probe values(1)');
  check((await migrate(clean,[...migrations,future])).applied===1,'new non-idempotent migration applies once');await migrate(clean,[...migrations,future]);check((await inSchema(clean,c=>c.query('select count(*)::int as count from migration_probe'))).rows[0].count===1,'non-idempotent data is not replayed');
  await assert.rejects(migrate(clean),/newer than or absent/);assertions++;
  const rollback=await ownedSchema();await migrate(rollback);await assert.rejects(migrate(rollback,[...migrations,future,migration(probeVersion+1,`${String(probeVersion+1).padStart(3,'0')}_fail.sql`,'insert into missing_table values(1)')]));assertions++;
  check((await inSchema(rollback,c=>c.query("select to_regclass('migration_probe') as name"))).rows[0].name===null,'failure rolls back earlier DDL in the same startup');check((await inSchema(rollback,c=>c.query('select count(*)::int as count from schema_migrations'))).rows[0].count===migrations.length,'failed migrations leave no ledger entries');
  const inserted=await ownedSchema(),one=migration(1,'001_probe.sql','create table ordered_probe(value int)'),three=migration(3,'003_probe.sql','insert into ordered_probe values(3)');await migrate(inserted,[one,three]);await assert.rejects(migrate(inserted,[one,migration(2,'002_probe.sql','insert into ordered_probe values(2)'),three]),/inserted before/);assertions++;
  const legacy=await ownedSchema();await inSchema(legacy,async c=>{for(const m of migrations.filter(m=>m.version<9))await c.query(m.sql);await c.query("insert into quota_batches(id,source_type,source_id,purpose,total_amount,available_amount,model_ids,expires_at) values('legacy-preserved','personal_batch','legacy','personal',20,12.345678,'[]',now()+interval '1 day')");});await migrate(legacy);check(Number((await inSchema(legacy,c=>c.query("select available_amount from quota_batches where id='legacy-preserved'"))).rows[0].available_amount)===12.345678,'legacy idempotent baseline adoption preserves existing funds');
  console.log(`PASS ${assertions} PostgreSQL migration assertions`);

  const schema=await ownedSchema(),cpPort=await freePort(),gwPort=await freePort(),mockPort=await freePort(),cp=`http://127.0.0.1:${cpPort}`,gw=`http://127.0.0.1:${gwPort}`,token=randomUUID()+randomUUID(),bootstrap=randomUUID()+randomUUID();
  const env={PLATFORM_MODE:'production',STORE_MODE:'postgres',DATABASE_URL:process.env.DATABASE_URL||config.DATABASE_URL,DATABASE_SCHEMA:schema,PGOPTIONS:'',SERVICE_TOKEN:token,BOOTSTRAP_TOKEN:bootstrap,COOKIE_SECURE:'true',WEB_ORIGIN:'https://delivery.example.test',PORT:String(cpPort)};
  const invalid=await failsToStart('apps/control-plane/dist/main.js',{...env,SERVICE_TOKEN:'local-service-token'});check(!invalid.diagnostic().includes(config.DATABASE_URL),'startup failures do not echo the database secret');check((await db.query('select count(*)::int as count from information_schema.tables where table_schema=$1',[schema])).rows[0].count===0,'configuration rejected before database writes');
  let control=start('apps/control-plane/dist/main.js',env);await ready(`${cp}/health`,control);
  let cookie='';async function request(path,body,auth=cookie){const r=await fetch(cp+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(auth?{cookie:auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')};}
  check((await request('/api/v1/auth/bootstrap')).body.tokenRequired===true,'production initialization advertises required installation token');
  const user={directoryId:'delivery-admin',name:'交付检查管理员',password:randomUUID()+randomUUID()};
  check((await request('/api/v1/auth/setup',user)).status===403,'loopback setup also requires installation token');check((await request('/api/v1/auth/setup',{...user,bootstrapToken:bootstrap})).status===200,'valid installation token creates administrator');
  const signed=await request('/api/v1/auth/login',user);check(signed.status===200&&signed.cookie.includes('Secure')&&signed.cookie.includes('HttpOnly'),'production session is Secure and HttpOnly');cookie=signed.cookie.split(';')[0];
  let state=(await request('/api/v1/platform/state')).body;check(state.members.length===1&&state.definitions.length===0&&state.services.length===0&&state.pools.length===0&&state.quotaBatches.length===0,'fresh production workspace contains no demonstrations or money');
  const raw=await fetch(cp+'/internal/v1/policy/credentials/resolve',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({apiKey:'local-employee-key'})});check(await raw.json()===null,'public development credential does not resolve');
  async function command(type,payload){const c={type,payload,idempotencyKey:randomUUID()},p=await request('/api/v1/platform/preview',c);assert.equal(p.status,200);const r=await request('/api/v1/platform/commands',{...c,previewToken:p.body.previewToken});assert.equal(r.status,200);return r.body.result;}
  const mock=start('postman/mocks/test-model/default.js',{PLATFORM_MODE:'development',PORT:String(mockPort)});await ready(`http://127.0.0.1:${mockPort}/health`,mock);
  const definition=await command('save.definition',{name:'交付验证模型',modelId:'test-model',contextTokens:32768});
  const service=await command('save.service',{name:'交付验证来源',baseUrl:`http://127.0.0.1:${mockPort}`,mappings:[{definitionId:definition.id,upstreamModel:'test-model',inputPrice:2,outputPrice:3,cachedInputPrice:0.5,limits:{mode:'inherit'}}]});
  check((await request(`/api/v1/platform/services/${service.id}/verify`,{})).body.verification==='passed','clean production install can verify a manually configured local test source');
  const pool=await command('save.pool',{name:'交付验证池',entries:[{definitionId:definition.id,serviceId:service.id,open:true}]}),range={poolId:pool.id,mode:'follow',definitionIds:[]};
  const plan=await command('save.plan',{name:'交付验证方案',range,amount:10,cadence:'once',quotaDays:30,entitlementDays:30});await command('distribution.execute',{planId:plan.id,memberIds:[state.actor.id]});const issued=await command('key.issue',{name:'交付验证密钥',purpose:'personal'});
  const gateway=start('services/gateway-sim/dist/server.js',{PLATFORM_MODE:'production',PORT:String(gwPort),SERVICE_TOKEN:token,WEB_ORIGIN:env.WEB_ORIGIN,CONTROL_PLANE_URL:cp,GATEWAY_JOURNAL_DIR:resolve(directory,'journal')});await ready(`${gw}/health`,gateway);
  const completion=await fetch(gw+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${issued.secret}`},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'isolated delivery verification'}]})});await completion.text();check(completion.status===200,'production-configured proxy uses the explicit managed route');
  state=(await request('/api/v1/platform/state')).body;check(state.quotaBatches.length===1&&state.quotaBatches[0].availableAmount<10&&state.callLogs.length===1,'configured request settles to the original new installation ledger');
  const funds=JSON.stringify(state.quotaBatches),history=(await inSchema(schema,c=>c.query('select * from schema_migrations order by version'))).rows;
  await stop(control);control=start('apps/control-plane/dist/main.js',env);await ready(`${cp}/health`,control);state=(await request('/api/v1/platform/state')).body;
  check(JSON.stringify(state.quotaBatches)===funds&&state.members.length===1&&state.callLogs.length===1,'production restart preserves administrator, session, balances and logs');check(JSON.stringify((await inSchema(schema,c=>c.query('select * from schema_migrations order by version'))).rows)===JSON.stringify(history),'production restart does not reapply migrations');
  if(process.argv.includes('--backup'))await checkBackup({schema,schemas,db,env,control,gateway,start,stop,ready,request,check,inSchema,directory,gwPort,cp,gw,issued,migrationCount:migrations.length});
  await stop(control);await failsToStart('apps/control-plane/dist/main.js',{...env,PLATFORM_MODE:'development',COOKIE_SECURE:'false'});check((await inSchema(schema,c=>c.query('select count(*)::int as count from credentials where api_key in ($1,$2)',['local-employee-key','local-project-key']))).rows[0].count===0,'wrong development mode cannot contaminate a production installation with fixture keys');
  const noSchema=await failsToStart('apps/control-plane/dist/main.js',{...env,DATABASE_SCHEMA:`agp_check_${randomUUID().replaceAll('-','')}`});check(!noSchema.diagnostic().includes(env.DATABASE_URL),'schema failures do not reveal connection data');
  console.log(`PASS ${assertions} isolated delivery assertions (migration integrity, clean install, managed call, restart and mode isolation)`);
}catch(error){console.error(error instanceof assert.AssertionError||/^(pg_dump|pg_restore|Backup |Target |Journal |Destination |Configured |Source )/.test(error.message)?error.message:'isolated delivery verification failed');process.exitCode=1;}
finally{
  for(const child of children.reverse())await stop(child);
  for(const schema of schemas){assert.match(schema,/^agp_check_[a-f0-9]{32}$/);await db.query(`drop schema "${schema}" cascade`);}await db.end();
  const actualRuntime=await realpath(runtime),actualDirectory=await realpath(directory);if(actualDirectory.startsWith(actualRuntime+sep)&&/^delivery-check-[a-f0-9-]{36}$/.test(actualDirectory.split(/[\\/]/).pop()))await rm(actualDirectory,{recursive:true,force:true});else throw new Error('unexpected delivery test directory');
  console.log('CLEANUP owned delivery schemas and journal removed; shared development data untouched');
}
