import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {appendFile,cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {backupWorkspace,restoreWorkspace} from './lib/backup.mjs';

/** Called only with the delivery harness's generated schema, processes, fake model and private directory. */
export async function checkBackup({schema,schemas,db,env,control,gateway,start,stop,ready,request,check,inSchema,directory,gwPort,cp:controlUrl,gw,issued,migrationCount}){
  assert.ok(Number.isInteger(migrationCount)&&migrationCount>0,'migration count is supplied by the delivery harness');
  assert.match(schema,/^agp_check_[a-f0-9]{32}$/);assert.ok(schemas.includes(schema));
  const before=(await request('/api/v1/platform/state')).body,amount=before.quotaBatches[0].availableAmount;
  const journal=resolve(directory,'journal'),bundle=resolve(directory,'backup'),options={connectionString:env.DATABASE_URL,schema,bin:process.env.PG_BIN,destination:bundle,journals:[journal]};
  await assert.rejects(backupWorkspace({...options,destination:resolve(directory,'live-writer-backup')}),/live writer/);check(true,'backup refuses a running journal writer');
  async function internal(path,body){const response=await fetch(controlUrl+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env.SERVICE_TOKEN}`},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();}
  const credential=await internal('/internal/v1/policy/credentials/resolve',{apiKey:issued.secret}),id=`backup-pending-${randomUUID()}`;
  const admitted=await internal('/internal/v1/policy/authorize',{requestId:id,idempotencyKey:id,identity:credential.identity,purpose:'personal',modelId:'test-model',mode:'chat',estimatedInputTokens:100,maxOutputTokens:32,policyVersion:'backup-check'});
  check(admitted.decision==='allow','backup fixture has a real reservation on the source ledger');
  await stop(gateway);await stop(control);
  const event={requestId:id,idempotencyKey:`${id}:settlement`,reservationId:admitted.reservation.reservationId,outcome:'completed',forwarded:true,usageFinal:true,inputTokens:5,outputTokens:3,cachedInputTokens:1,currency:'CNY',completedAt:new Date().toISOString(),modelId:'test-model',purpose:'personal',subjectId:credential.identity.subjectId};
  const entry={phase:'queued',settlement:event,attempts:1,nextAttemptAt:0,lastStatus:503},file=createHash('sha256').update(id).digest('hex')+'.json';
  await writeFile(resolve(journal,file),JSON.stringify(entry));
  const secondJournal=resolve(directory,'empty-journal');await mkdir(secondJournal);await writeFile(resolve(secondJournal,'writer.lock'),JSON.stringify({pid:process.pid,runtimeToken:'stopped-container-runtime'}));options.journals.push(secondJournal);
  console.log('CHECK native backup of stopped gateway journals and authoritative PostgreSQL ledger');
  const backup=await backupWorkspace(options);
  check(backup.manifest.mode==='production'&&backup.manifest.journals.length===2&&backup.manifest.journals[0].phases.queued===1&&backup.manifest.journals[1].records===0,'bundle includes installation mode, pending settlement and empty second journal');
  check(backup.manifest.migrations.length===migrationCount&&backup.manifest.files.some(f=>f.path==='platform.dump'),'bundle carries migrations and native database archive');
  await assert.rejects(backupWorkspace(options),/Destination already exists/);check(true,'backup never overwrites an existing bundle');
  await assert.rejects(restoreWorkspace({connectionString:env.DATABASE_URL,bin:process.env.PG_BIN,source:bundle,journalRoot:resolve(directory,'existing-schema-restore')}),/Target schema already exists/);check(true,'restore never replaces an existing schema');
  const corrupt=resolve(directory,'corrupt-backup');await cp(bundle,corrupt,{recursive:true});await appendFile(resolve(corrupt,'platform.dump'),'corrupt');
  await assert.rejects(restoreWorkspace({connectionString:env.DATABASE_URL,bin:process.env.PG_BIN,source:corrupt,journalRoot:resolve(directory,'corrupt-restore')}),/checksum mismatch/);check(true,'checksum mismatch is rejected before database restoration');
  const malformed=resolve(directory,'malformed-backup');await cp(bundle,malformed,{recursive:true});const manifest=JSON.parse(await readFile(resolve(malformed,'manifest.json'),'utf8'));manifest.files.push({path:'../outside',size:0,sha256:'0'.repeat(64)});await writeFile(resolve(malformed,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(restoreWorkspace({connectionString:env.DATABASE_URL,bin:process.env.PG_BIN,source:malformed,journalRoot:resolve(directory,'malformed-restore')}),/Invalid backup file manifest/);check(true,'manifest paths cannot escape the bundle');
  // Keep the original as evidence and simulate an absent restore target without deleting any original objects.
  const archived=`agp_check_${randomUUID().replaceAll('-','')}`;assert.match(archived,/^agp_check_[a-f0-9]{32}$/);assert.ok(!schemas.includes(archived));schemas.push(archived);
  await db.query(`alter schema "${schema}" rename to "${archived}"`);
  const restored=await restoreWorkspace({connectionString:env.DATABASE_URL,bin:process.env.PG_BIN,source:bundle,journalRoot:resolve(directory,'restored-journals')});
  check(restored.journals.length===2&&JSON.stringify(JSON.parse(await readFile(resolve(restored.journals[0].directory,file),'utf8')))===JSON.stringify(entry),'restoration preserves exact queued event and independent journal directories');
  check((await inSchema(schema,c=>c.query('select count(*)::int as total from schema_migrations'))).rows[0].total===migrationCount,'native restore retains migration history');
  check((await inSchema(schema,c=>c.query("select count(distinct column_name)::int as total from information_schema.columns where table_schema=current_schema() and column_name in ('upstream_request_id','retry_of_request_id')"))).rows[0].total===2,'native restore retains call tracing columns');
  check((await inSchema(schema,c=>c.query("select to_regclass('service_verification_runs') as name"))).rows[0].name!==null,'native restore retains the verification run table');
  check((await inSchema(schema,c=>c.query('select count(*)::int as total from service_verification_runs'))).rows[0].total>0,'native restore retains verification run evidence');
  const restoredControl=start('apps/control-plane/dist/main.js',env);await ready(`${controlUrl}/health`,restoredControl);
  let state=(await request('/api/v1/platform/state')).body;
  check(state.members[0].id===before.members[0].id&&state.definitions[0].id===before.definitions[0].id&&state.plans[0].id===before.plans[0].id&&state.callLogs.length===1,'restored session, administrator, model, plan and historical call are accessible');
  const restoredGateway=start('services/gateway-sim/dist/server.js',{PLATFORM_MODE:'production',PORT:String(gwPort),SERVICE_TOKEN:env.SERVICE_TOKEN,WEB_ORIGIN:env.WEB_ORIGIN,CONTROL_PLANE_URL:controlUrl,GATEWAY_JOURNAL_DIR:restored.journals[0].directory});await ready(`${gw}/health`,restoredGateway);
  state=(await request('/api/v1/platform/state')).body;const recovered=state.callLogs.find(c=>c.requestId===id);
  check(recovered?.billableState==='confirmed'&&state.callLogs.length===2&&Math.abs(state.quotaBatches[0].availableAmount+recovered.actualAmount-amount)<0.0000001,'restored outbox settles once to the original restored quota batch');
  const funds=JSON.stringify(state.quotaBatches),replay=await internal('/internal/v1/usage/settlements',event);state=(await request('/api/v1/platform/state')).body;
  check(replay.status==='already_finalized'&&replay.requestId===id&&JSON.stringify(state.quotaBatches)===funds&&state.callLogs.length===2,'replayed restored event cannot double debit or duplicate call history');
  const response=await fetch(gw+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${issued.secret}`},body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'post-restore local model verification'}]})});await response.text();
  state=(await request('/api/v1/platform/state')).body;check(response.status===200&&state.callLogs.length===3,'restored key and managed route can complete a new local model request');
  check((await fetch(gw+'/health').then(r=>r.json())).outbox.queued===0,'restored gateway has no queued settlement left');
  await stop(restoredGateway);await stop(restoredControl);
  console.log('PASS native backup/restore, target protection, checksums, restored session, outbox deduplication and new managed call');
}
