import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile,lstat,mkdir,open,readFile,readdir,realpath,rename,unlink,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';

const require=createRequire(new URL('../../apps/control-plane/package.json',import.meta.url)),{Pool}=require('pg');
const identifier=/^[a-z_][a-z0-9_]{0,62}$/;
const journalFile=/^[a-f0-9]{64}\.json$/;
const ownedLockToken=`backup-${randomUUID()}`;
const fail=message=>{throw new Error(message);};

export async function connectionConfig(){
  let file={};try{file=require('dotenv').parse(await readFile(new URL('../../apps/control-plane/.env',import.meta.url)));}catch(error){if(error.code!=='ENOENT')throw error;}
  const connectionString=process.env.DATABASE_URL||file.DATABASE_URL;
  if(!connectionString)fail('DATABASE_URL is required');
  return {connectionString,schema:process.env.DATABASE_SCHEMA||file.DATABASE_SCHEMA,bin:process.env.PG_BIN};
}

function pgEnvironment(connectionString){
  let url;try{url=new URL(connectionString);}catch{fail('Invalid PostgreSQL connection configuration');}
  if(!['postgres:','postgresql:'].includes(url.protocol))fail('A PostgreSQL connection URL is required');
  const keep=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','LANG','LC_ALL','LD_LIBRARY_PATH','DYLD_LIBRARY_PATH']);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>keep.has(key.toUpperCase())));
  Object.assign(env,{PGHOST:url.hostname.replace(/^\[|\]$/g,''),PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGPASSWORD:decodeURIComponent(url.password),PGCONNECT_TIMEOUT:'10',PGAPPNAME:'signal-atlas-backup'});
  const options={host:'PGHOST',hostaddr:'PGHOSTADDR',port:'PGPORT',user:'PGUSER',password:'PGPASSWORD',dbname:'PGDATABASE',sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY',sslpassword:'PGSSLPASSWORD',sslcrl:'PGSSLCRL',sslcrldir:'PGSSLCRLDIR',connect_timeout:'PGCONNECT_TIMEOUT',application_name:'PGAPPNAME',options:'PGOPTIONS',channel_binding:'PGCHANNELBINDING',target_session_attrs:'PGTARGETSESSIONATTRS',gssencmode:'PGGSSENCMODE'};
  for(const [key,value] of url.searchParams){if(!options[key])fail('Unsupported PostgreSQL connection URL option for native tools');env[options[key]]=value;}
  return env;
}

async function native(tool,args,{connectionString,bin}){
  if(bin&&!isAbsolute(bin))fail('PG_BIN must be an absolute directory');
  const executable=bin?join(bin,tool+(process.platform==='win32'?'.exe':'')):tool;
  const child=spawn(executable,args,{windowsHide:true,env:pgEnvironment(connectionString),stdio:['ignore','pipe','pipe']});
  let output='',diagnostic='';child.stdout.on('data',v=>output=(output+v).slice(-8192));child.stderr.on('data',v=>diagnostic=(diagnostic+v).slice(-8192));
  const code=await new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error(`${tool} is unavailable; configure PG_BIN or PATH`)));child.once('exit',resolve);});
  // Do not relay native diagnostics: they can include connection details or data from a restore.
  if(code!==0){const reason=/permission denied/i.test(diagnostic)?'database permission denied':/password authentication failed|no password supplied/i.test(diagnostic)?'authentication failed':/does not exist/i.test(diagnostic)?'database or object not found':/snapshot/i.test(diagnostic)?'snapshot unavailable':/version mismatch/i.test(diagnostic)?'client/server version mismatch':/connection.*failed|could not translate host/i.test(diagnostic)?'connection failed':'check client/server versions, connectivity and database permissions';fail(`${tool} failed (exit ${code??'signal'}); ${reason}`);}
  return output.trim();
}

export async function digestFile(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function absent(path){try{await lstat(path);fail('Destination already exists; choose a new directory');}catch(error){if(error.code!=='ENOENT')throw error;}}
function validateSchema(schema){if(!identifier.test(schema??''))fail('An explicit lowercase DATABASE_SCHEMA is required');return schema;}
function validateEntry(name,raw){
  let entry;try{entry=JSON.parse(raw);}catch{fail('Invalid journal JSON; inspect the source journal before backup');}
  if(!['admitted','dispatched','queued','blocked'].includes(entry?.phase)||typeof entry.settlement?.requestId!=='string'||createHash('sha256').update(entry.settlement.requestId).digest('hex')+'.json'!==name)fail('Invalid journal identity; inspect the source journal before backup');
  return entry;
}
async function regularFile(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())fail('Backup contains an unsupported file or link');return info;}
async function exclusiveJournal(directory){
  const physical=await realpath(directory),info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())fail('Journal must be an existing physical directory');
  const path=join(physical,'writer.lock');
  try{
    const lock=JSON.parse(await readFile(path,'utf8'));if(!Number.isSafeInteger(lock.pid)||lock.pid<1)fail('Invalid journal writer lock');
    // A stopped container and this one-shot tool can both be PID 1 in separate namespaces.
    // As with the gateway's restart check, a reused self PID requires this runtime's token.
    // Operators must stop every writer; this is not a cross-container/host distributed lock.
    let alive=!(lock.pid===process.pid&&lock.runtimeToken!==ownedLockToken);if(alive)try{process.kill(lock.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
    if(alive)fail('Journal has a live writer; stop that gateway before backup');await unlink(path);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const handle=await open(path,'wx',0o600),value=JSON.stringify({pid:process.pid,runtimeToken:ownedLockToken});try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}
  return {directory:physical,release:async()=>{if(await readFile(path,'utf8')===value)await unlink(path);else fail('Backup journal lock ownership changed');}};
}

/** Native schema dump + every supplied, stopped gateway journal under one database snapshot. */
export async function backupWorkspace({connectionString,schema,bin,destination,journals}){
  validateSchema(schema);if(!Array.isArray(journals)||!journals.length)fail('Supply every gateway journal directory, including an empty journal');
  const out=resolve(destination),locks=[];await absent(out);
  const db=new Pool({connectionString,connectionTimeoutMillis:5000,max:1,options:`-c search_path=${schema}`});let client;
  try{
    for(const directory of journals){const lock=await exclusiveJournal(resolve(directory));if(locks.some(previous=>previous.directory===lock.directory)){await lock.release();fail('Duplicate journal directory');}locks.push(lock);}
    if(locks.some(lock=>out===lock.directory||out.startsWith(lock.directory+sep)))fail('Backup destination must be outside gateway journals');
    const version=await native('pg_dump',['--version'],{connectionString,bin});
    client=await db.connect();
    if((await client.query('select current_schema() as name')).rows[0].name!==schema)fail('Configured source schema is absent or inaccessible');
    await client.query("set lock_timeout='5s'");
    // Lock before opening the snapshot, so an in-progress migration commits before our snapshot begins.
    await client.query("select pg_advisory_lock(hashtextextended(current_database()||':'||current_schema()||':control-plane-migrations',0))");
    await client.query('begin isolation level repeatable read');
    const tables=(await client.query("select tablename from pg_tables where schemaname=$1 order by tablename",[schema])).rows;
    if(!tables.some(t=>t.tablename==='schema_migrations')||!tables.some(t=>t.tablename==='platform_workspace'))fail('Source is not an initialized platform schema');
    const quoted=name=>'"'+name.replaceAll('"','""')+'"';
    await client.query('lock table '+tables.map(t=>quoted(schema)+'.'+quoted(t.tablename)).join(',')+' in share mode');
    const installation=(await client.query('select mode from platform_installation where singleton=true')).rows[0];
    const migrations=(await client.query('select version,name,checksum from schema_migrations order by version')).rows;
    if(!installation||!migrations.length)fail('Source installation metadata is incomplete');
    const snapshot=(await client.query('select pg_export_snapshot() as snapshot')).rows[0].snapshot;
    await mkdir(dirname(out),{recursive:true});await mkdir(out,{mode:0o700});
    const archive=join(out,'platform.dump');await native('pg_dump',['--format=custom','--no-owner','--no-acl',`--schema=${schema}`,`--snapshot=${snapshot}`,'--file',archive],{connectionString,bin});
    const files=[{path:'platform.dump',size:(await regularFile(archive)).size,sha256:await digestFile(archive)}],summary=[];
    for(const [index,lock] of locks.entries()){
      const id=`gateway-${String(index+1).padStart(3,'0')}`,folder=join(out,'journals',id);await mkdir(folder,{recursive:true,mode:0o700});let records=0;const phases={admitted:0,dispatched:0,queued:0,blocked:0};
      for(const item of await readdir(lock.directory,{withFileTypes:true})){
        if(item.isSymbolicLink()||!item.isFile())fail('Journal contains an unsupported file or directory');
        if(item.name==='writer.lock'||/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(item.name))continue;
        if(!journalFile.test(item.name))fail('Journal contains unknown files; inspect it before backup');
        const source=join(lock.directory,item.name);if((await regularFile(source)).size>2097152)fail('Journal record exceeds the supported backup size');
        const raw=await readFile(source,'utf8'),entry=validateEntry(item.name,raw),relative=`journals/${id}/${item.name}`,target=join(out,...relative.split('/'));
        await writeFile(target,raw,{flag:'wx',mode:0o600});files.push({path:relative,size:(await regularFile(target)).size,sha256:await digestFile(target)});records++;phases[entry.phase]++;
      }
      summary.push({id,records,phases});
    }
    const manifest={format:'signal-atlas-backup',version:1,createdAt:new Date().toISOString(),schema,mode:installation.mode,client:version,migrations,journals:summary,files};
    await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});await client.query('commit');return {directory:out,manifest};
  }catch(error){if(client)await client.query('rollback').catch(()=>undefined);throw error;}
  finally{if(client){await client.query('select pg_advisory_unlock_all()').catch(()=>undefined);client.release();}await db.end();for(const lock of locks.reverse())await lock.release();}
}

async function validateBundle(directory){
  const root=await realpath(directory);if((await lstat(directory)).isSymbolicLink())fail('Backup directory cannot be a link');
  await regularFile(join(root,'manifest.json'));const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  if(manifest.format!=='signal-atlas-backup'||manifest.version!==1||!['development','production'].includes(manifest.mode)||!Array.isArray(manifest.files)||!Array.isArray(manifest.journals)||!manifest.journals.length)fail('Unsupported or incomplete backup manifest');
  validateSchema(manifest.schema);
  const ids=manifest.journals.map(j=>j.id);if(ids.some(id=>!/^gateway-\d{3}$/.test(id))||new Set(ids).size!==ids.length)fail('Invalid backup journal identifiers');
  const paths=new Set();for(const file of manifest.files){
    if(typeof file.path!=='string'||(file.path!=='platform.dump'&&!/^journals\/gateway-\d{3}\/[a-f0-9]{64}\.json$/.test(file.path))||paths.has(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0)fail('Invalid backup file manifest');
    paths.add(file.path);const path=join(root,...file.path.split('/'));if(!(await realpath(path)).startsWith(root+sep))fail('Backup file resolves outside the bundle');
    if(file.path!=='platform.dump'){
      const [,id,name]=file.path.split('/');if(!ids.includes(id))fail('Unknown journal in backup');
      if((await lstat(join(root,'journals'))).isSymbolicLink()||(await lstat(join(root,'journals',id))).isSymbolicLink())fail('Backup directories cannot be links');
      validateEntry(name,await readFile(path,'utf8'));
    }
    if((await regularFile(path)).size!==file.size||await digestFile(path)!==file.sha256)fail('Backup checksum mismatch; no restoration was attempted');
  }
  if(!paths.has('platform.dump'))fail('Database archive is missing');
  for(const journal of manifest.journals)if(!Number.isSafeInteger(journal.records)||journal.records<0||[...paths].filter(path=>path.startsWith(`journals/${journal.id}/`)).length!==journal.records)fail('Backup journal record count differs from manifest');
  return {root,manifest};
}

/** Restore only into an absent schema and new journal root; never drop/overwrite target data. */
export async function restoreWorkspace({connectionString,bin,source,journalRoot}){
  const {root,manifest}=await validateBundle(resolve(source)),target=resolve(journalRoot);await absent(target);
  const db=new Pool({connectionString,connectionTimeoutMillis:5000,max:1});
  try{if((await db.query('select exists(select 1 from pg_namespace where nspname=$1) as present',[manifest.schema])).rows[0].present)fail('Target schema already exists; restore into a clean database or absent schema');}
  finally{await db.end();}
  await native('pg_restore',['--version'],{connectionString,bin});
  const staged=target+`.pending-${randomUUID()}`;await mkdir(dirname(target),{recursive:true});await mkdir(staged,{mode:0o700});
  for(const journal of manifest.journals)await mkdir(join(staged,journal.id),{mode:0o700});
  for(const file of manifest.files.filter(f=>f.path!=='platform.dump')){const [,id,name]=file.path.split('/');await copyFile(join(root,...file.path.split('/')),join(staged,id,name));}
  // A non-null empty -d selects restore-to-database mode; libpq then reads PGDATABASE from the child environment.
  // Connection URLs and passwords never appear in the process arguments.
  try{await native('pg_restore',['--single-transaction','--exit-on-error','--no-owner','--no-acl','--dbname','',join(root,'platform.dump')],{connectionString,bin});}
  catch(error){fail(`${error.message}; staged journals retained at ${staged}`);}
  try{await absent(target);await rename(staged,target);}catch{fail(`Database restored; journals remain staged at ${staged}. Keep services stopped and move that directory to the requested journal root before starting.`);}
  return {schema:manifest.schema,journalRoot:target,journals:manifest.journals.map(j=>({id:j.id,directory:join(target,j.id)}))};
}
