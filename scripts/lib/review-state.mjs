import {randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readFile,realpath,rename,unlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,sep} from 'node:path';
import {connectionConfig} from './backup.mjs';

const require=createRequire(new URL('../../apps/control-plane/package.json',import.meta.url)),{Pool}=require('pg');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const runtimeToken=randomUUID();
async function optionalJson(path){try{if(!(await lstat(path)).isFile()||(await lstat(path)).isSymbolicLink())throw new Error('审查状态文件不能是链接或目录');return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('审查状态文件无法读取，已保留原文件');}}
async function atomicJson(path,value){const temporary=path+'.'+randomUUID()+'.tmp',handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}await rename(temporary,path);}
async function claim(path){
  const value={pid:process.pid,token:runtimeToken},previous=await optionalJson(path);
  if(previous){
    if(!Number.isSafeInteger(previous.pid)||previous.pid<1||typeof previous.token!=='string')throw new Error('审查启动锁无效，已保留以便检查');
    let alive=!(previous.pid===process.pid&&previous.token!==runtimeToken);if(alive)try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
    if(alive)throw new Error(`此持久审查工作区已有进程运行（PID ${previous.pid}），不会启动第二个写入者`);await unlink(path);
  }
  const handle=await open(path,'wx',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
  return async()=>{const current=await optionalJson(path);if(current?.pid===value.pid&&current.token===value.token)await unlink(path);};
}

/** Owns a generated review schema only. Existing shared/public/production schemas are never adopted. */
export async function openPersistentReview({root,workspace='default',ports,hostname,env=process.env,preflight=async()=>undefined}){
  if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(workspace))throw new Error('REVIEW_WORKSPACE 只能使用小写字母、数字和短横线（最多 80 字符）');
  const runtime=resolve(root,'.runtime');await mkdir(runtime,{recursive:true});
  if(!(await realpath(runtime)).startsWith((await realpath(root))+sep))throw new Error('审查运行目录必须位于当前项目内');
  const stateFile=resolve(runtime,workspace==='default'?'review-postgres.json':`review-postgres-${workspace}.json`),releaseLock=await claim(stateFile+'.lock');let pool;
  try{
    let state=await optionalJson(stateFile);
    if(state){
      if(state.format!=='signal-atlas-review'||state.version!==1||state.mode!=='postgres'||state.workspace!==workspace||!uuid.test(state.id)||state.schema!==`agp_review_${state.id.replaceAll('-','')}`||typeof state.ready!=='boolean'||!Number.isFinite(Date.parse(state.createdAt))||!['localhost','127.0.0.1'].includes(state.hostname))throw new Error('持久审查身份不匹配，未访问或覆盖现有数据');
      const keys={web:'REVIEW_WEB_PORT',control:'REVIEW_CONTROL_PORT',gateway:'REVIEW_GATEWAY_PORT',model:'REVIEW_MODEL_PORT'};
      if(!state.ports||Object.keys(state.ports).length!==4||Object.keys(keys).some(k=>!Number.isSafeInteger(state.ports[k])||state.ports[k]<1024||state.ports[k]>65535)||new Set(Object.values(state.ports)).size!==4)throw new Error('已保存的审查端口配置无效');
      for(const [key,name]of Object.entries(keys))if(env[name]!==undefined&&Number(env[name])!==state.ports[key])throw new Error('恢复审查必须沿用原端口；请移除端口覆盖，或使用新的 REVIEW_WORKSPACE');
      if(env.REVIEW_HOSTNAME!==undefined&&env.REVIEW_HOSTNAME!==state.hostname)throw new Error('恢复审查必须沿用原主机名；请移除 REVIEW_HOSTNAME 覆盖');
      await preflight(state.ports,state.hostname);
    }else{
      await preflight(ports,hostname);const id=randomUUID();state={format:'signal-atlas-review',version:1,mode:'postgres',workspace,id,schema:`agp_review_${id.replaceAll('-','')}`,ports,hostname,createdAt:new Date().toISOString(),ready:false};await atomicJson(stateFile,state);
    }
    const directory=resolve(runtime,`review-postgres-${state.id}`);await mkdir(directory,{recursive:true,mode:0o700});if(await realpath(directory)!==directory)throw new Error('持久审查目录不能指向其他路径');
    const {connectionString}=await connectionConfig();pool=new Pool({connectionString,connectionTimeoutMillis:5000,max:1});
    pool.on('error',()=>console.error('持久审查数据库的空闲连接已失效；后续查询将重新连接。'));
    const quoted='"'+state.schema+'"';
    let identity;
    try{
      const exists=(await pool.query('select exists(select 1 from pg_namespace where nspname=$1) as present',[state.schema])).rows[0].present;
      if(!exists){
        if(state.ready)throw new Error('READY_SCHEMA_MISSING');
        const client=await pool.connect();try{await client.query('begin');await client.query(`create schema ${quoted}`);await client.query(`create table ${quoted}.review_identity(singleton boolean primary key default true check(singleton),workspace_id uuid not null,workspace text not null,ready boolean not null default false)`);await client.query(`insert into ${quoted}.review_identity(singleton,workspace_id,workspace) values(true,$1,$2)`,[state.id,workspace]);await client.query('commit');}catch(error){await client.query('rollback');throw error;}finally{client.release();}
      }
      identity=(await pool.query(`select workspace_id,workspace,ready from ${quoted}.review_identity where singleton=true`)).rows[0];
      if(!identity||identity.workspace_id!==state.id||identity.workspace!==workspace||state.ready&&!identity.ready)throw new Error('IDENTITY_MISMATCH');
      const installed=(await pool.query('select to_regclass($1) as name',[state.schema+'.platform_installation'])).rows[0].name;
      if(installed&&(await pool.query(`select mode from ${quoted}.platform_installation where singleton=true`)).rows.some(row=>row.mode!=='development'))throw new Error('PRODUCTION_SCHEMA');
    }catch(error){throw new Error(error.message==='READY_SCHEMA_MISSING'?'原审查 schema 已不存在，请恢复备份后继续；不会重新创建并伪装原数据':error.message==='IDENTITY_MISMATCH'?'数据库中的审查身份与状态文件不一致，未启动业务服务':error.message==='PRODUCTION_SCHEMA'?'拒绝把正式安装作为开发审查工作区':'审查数据库无法初始化或身份检查失败；请检查连接与权限，连接配置不会回显');}
    if(identity.ready&&!state.ready){state.ready=true;await atomicJson(stateFile,state);}
    let released=false;
    return {state,stateFile,directory,connectionString,
      markReady:async objects=>{await pool.query(`update ${quoted}.review_identity set ready=true where singleton=true and workspace_id=$1`,[state.id]);state.ready=true;state.objects=objects;await atomicJson(stateFile,state);},
      release:async()=>{if(released)return;released=true;await pool.end();await releaseLock();},
    };
  }catch(error){if(pool)await pool.end();await releaseLock();throw error;}
}
