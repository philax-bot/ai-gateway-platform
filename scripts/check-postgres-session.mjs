import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {connectionConfig} from './lib/backup.mjs';

const require=createRequire(new URL('../apps/control-plane/package.json',import.meta.url)),{Pool}=require('pg');
const {connectionString}=await connectionConfig(),schema=`agp_timeout_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString,connectionTimeoutMillis:5000});let store,blocker,created=false;
try{
  await admin.query(`create schema "${schema}"`);
  created=true;
  Object.assign(process.env,{DATABASE_URL:connectionString,DATABASE_SCHEMA:schema,PLATFORM_MODE:'development',REDIS_URL:'',PGOPTIONS:'',PGAPPNAME:schema});
  const {PostgresStore}=require('./dist/store/postgres.store.js'),{WorkspaceRepository}=require('./dist/platform/workspace.repository.js');
  store=new PostgresStore();await store.initialize();await new WorkspaceRepository(store).initialize();
  await store.withClient(async client=>{
    const settings=(await client.query("select current_setting('lock_timeout') as lock,current_setting('statement_timeout') as statement,current_setting('idle_in_transaction_session_timeout') as idle,current_setting('application_name') as application")).rows[0];
    assert.deepEqual(settings,{lock:'5s',statement:'30s',idle:'30s',application:schema});
  });
  blocker=await admin.connect();await blocker.query('begin');
  await blocker.query(`select payload from "${schema}".platform_workspace where id=$1 for update`,['org-demo']);
  const started=Date.now();
  await store.withClient(async client=>{
    await client.query('begin');
    try{await assert.rejects(client.query('select payload from platform_workspace where id=$1 for update',['org-demo']),error=>error.code==='55P03');}
    finally{await client.query('rollback');}
  });
  assert.ok(Date.now()-started<20000,'a blocked workspace write must fail promptly');
  await blocker.query('rollback');blocker.release();blocker=null;
  await store.withClient(async client=>{await client.query('begin');await client.query('select payload from platform_workspace where id=$1 for update',['org-demo']);await client.query('rollback');});
  console.log('PASS PostgreSQL session safeguards: bounded lock wait, rollback and connection reuse; 30s statement/idle limits');
}finally{
  if(blocker){await blocker.query('rollback');blocker.release();}
  await store?.onModuleDestroy();
  try{if(created){assert.match(schema,/^agp_timeout_[a-f0-9]{32}$/);await admin.query(`drop schema "${schema}" cascade`);}}finally{await admin.end();}
}
