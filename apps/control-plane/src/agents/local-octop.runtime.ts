import {Injectable,ServiceUnavailableException,type OnModuleDestroy} from '@nestjs/common';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,realpath,open,unlink} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {runtimeMode} from '@ai-gateway/contracts';

const execute=promisify(execFile),PIN='890111b7879665840414ca28ab168b05b0db0921';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
interface RuntimeInfo {port:number;adminPassword:string;username:string;userId?:number;agentId?:string}
interface Running {child:ChildProcess;info:RuntimeInfo;home:string;userToken?:string;tokenUntil?:number}
export interface AgentObservation {running:boolean;entryUrl:string|null;agentId:string|null}

/** Explicitly local development only. Runtime files contain credentials and are
 * outside the agent workspace; production needs per-user execution isolation. */
@Injectable()
export class LocalOctopRuntime implements OnModuleDestroy {
  private processes=new Map<string,Running>();
  private rootLock:{path:string;token:string}|null=null;
  private rootClaim:Promise<void>|null=null;
  get enabled(){return process.env.OCTOP_MANAGED_ENABLED==='true'&&runtimeMode(process.env)!=='production'&&['127.0.0.1','localhost','::1'].includes(process.env.HOST??'127.0.0.1');}
  assertEnabled(){if(!this.enabled)throw new ServiceUnavailableException('managed Octop local runtime is disabled');}
  observe(id:string):AgentObservation {const p=this.processes.get(id),running=!!p&&p.child.exitCode===null&&p.child.signalCode===null;return {running,entryUrl:running?`http://127.0.0.1:${p!.info.port}`:null,agentId:running?p!.info.agentId??null:null};}

  private async paths(id:string){
    this.assertEnabled();if(!/^octop-[a-f0-9]{40}$/.test(id))throw Error('invalid managed instance identity');
    const project=process.env.OCTOP_PROJECT_ROOT,source=process.env.OCTOP_SOURCE_DIR,root=process.env.OCTOP_MANAGED_ROOT;
    if(!project||!source||!root||![project,source,root].every(isAbsolute))throw new ServiceUnavailableException('managed Octop paths must be configured by the server');
    const physicalProject=await realpath(project);await mkdir(resolve(physicalProject,'.runtime'),{recursive:true});
    const expected=await realpath(resolve(physicalProject,'.runtime'));await mkdir(root,{recursive:true});const physicalRoot=await realpath(root);
    const sub=relative(expected,physicalRoot);if(!sub||sub.startsWith('..')||isAbsolute(sub))throw new ServiceUnavailableException('managed runtime must be inside the project runtime directory');
    if(!this.rootLock&&!this.rootClaim)this.rootClaim=(async()=>{
      const lock=resolve(physicalRoot,'manager.lock');
      try{const old=JSON.parse(await readFile(lock,'utf8'));if(!Number.isSafeInteger(old.pid)||old.pid<1)throw Error('invalid manager lock');let alive=true;try{process.kill(old.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('another runtime manager is active');await unlink(lock);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const token=randomBytes(24).toString('hex'),file=await open(lock,'wx',0o600);try{await file.writeFile(JSON.stringify({pid:process.pid,token}));}finally{await file.close();}this.rootLock={path:lock,token};
    })();
    if(this.rootClaim){try{await this.rootClaim;}finally{this.rootClaim=null;}}
    const physicalSource=await realpath(source);
    if((await execute('git',['rev-parse','HEAD'],{cwd:physicalSource,windowsHide:true})).stdout.trim()!==PIN||(await execute('git',['status','--porcelain','--untracked-files=no'],{cwd:physicalSource,windowsHide:true})).stdout.trim())throw new ServiceUnavailableException('managed Octop source must match the clean reviewed revision');
    const directory=resolve(physicalRoot,id);await mkdir(directory,{recursive:true});if(!(await realpath(directory)).startsWith(physicalRoot+sep))throw Error('instance directory escaped manager root');
    return {directory,home:resolve(directory,'home'),source:physicalSource,project:physicalProject};
  }
  private async http(base:string,path:string,body?:unknown,token?:string,method?:string){
    const r=await fetch(base+path,{method:method??(body===undefined?'GET':'POST'),headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!r.ok)throw Error('managed Octop API request failed');const raw=await r.text();return raw?JSON.parse(raw):null;
  }
  private async stopProcess(child:ChildProcess){
    if(child.exitCode!==null||child.signalCode!==null)return;
    const exited=new Promise<void>(r=>child.once('exit',()=>r()));
    if(process.platform==='win32')await execute('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});else child.kill();
    let timer:NodeJS.Timeout|undefined;try{await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('owned runtime did not stop')),5000);})]);}finally{clearTimeout(timer);}
  }
  async stop(id:string){const p=this.processes.get(id);if(p){await this.stopProcess(p.child);this.processes.delete(id);}}

  async configure(id:string,apiKey:string,chatModelIds:string[]){
    const paths=await this.paths(id);let running=this.processes.get(id);
    if(running&&(running.child.exitCode!==null||running.child.signalCode!==null)){this.processes.delete(id);running=undefined;}
    const record=resolve(paths.directory,'manager.json');let info:RuntimeInfo;
    try{info=JSON.parse(await readFile(record,'utf8'));if(!Number.isSafeInteger(info.port)||info.port<1||info.port>65535||typeof info.adminPassword!=='string'||info.username!=='platform-user')throw Error('invalid runtime record');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));info={port,adminPassword:`Octop1-${randomBytes(32).toString('hex')}`,username:'platform-user'};await writeFile(record,JSON.stringify(info),{flag:'wx',mode:0o600});}
    const base=`http://127.0.0.1:${info.port}`;
    if(!running){
      // Refuse to adopt an unowned process, even if it answers this port.
      try{await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)});throw Error('unowned process occupies managed port');}catch(e){if((e as Error).message==='unowned process occupies managed port')throw e;}
      await mkdir(paths.home,{recursive:true});await writeFile(resolve(paths.home,'config.json'),JSON.stringify({bind_host:'127.0.0.1',port:info.port,enable_dashboard:true,enable_api_docs:false,require_setup_password:false,database:{driver:'sqlite',sqlite_path:'octop.db'}}));
      const inherited=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(k)));
      const child=spawn(resolve(paths.source,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),[resolve(paths.project,'scripts/octop-local-only.py'),'run','--host','127.0.0.1','--port',String(info.port)],{cwd:paths.directory,env:{...inherited,OCTOP_HOME:paths.home,OCTOP_DATABASE_DRIVER:'sqlite',OCTOP_GATEWAY_COMPAT:'1',PYTHONPATH:resolve(paths.source,'src'),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false',NO_PROXY:'127.0.0.1,localhost'},windowsHide:true,stdio:'ignore'});
      child.on('error',()=>{});running={child,info,home:paths.home};this.processes.set(id,running);
      let ready=false;for(let i=0;i<120;i++){if(child.exitCode!==null||child.signalCode!==null)break;try{ready=(await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).ok;if(ready)break;}catch{}await pause(200);}if(!ready)throw Error('managed runtime startup failed');
    }
    const setup=await this.http(base,'/api/setup/status');
    let admin:string;
    if(setup.setup_required){const wizard=await this.http(base,'/api/setup/begin',{});const created=await this.http(base,'/api/setup/initial-admin',{username:'platform-admin',password:info.adminPassword},wizard.wizard_token);admin=created.access_token;await this.http(base,'/api/setup/finish',{},admin);}
    else admin=(await this.http(base,'/api/auth/login',{username:'platform-admin',password:info.adminPassword})).access_token;
    const users=await this.http(base,'/api/users',undefined,admin);let user=users.find((u:{username:string})=>u.username===info.username);const password=`User1-${randomBytes(32).toString('hex')}`;
    if(!user)user=await this.http(base,'/api/users',{username:info.username,password,role:'user',permissions:[]},admin);
    else await this.http(base,`/api/users/${user.id}/reset-password`,{new_password:password},admin);
    info.userId=user.id;const userToken=(await this.http(base,'/api/auth/login',{username:info.username,password})).access_token;
    const gateway=new URL(process.env.OCTOP_GATEWAY_URL??'');if(gateway.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(gateway.hostname)||gateway.username||gateway.password||gateway.search||gateway.hash||!['','/','/v1'].includes(gateway.pathname))throw Error('managed gateway must be the server configured loopback URL');
    gateway.pathname='/v1';const models=await this.http(gateway.origin,'/v1/models',undefined,apiKey);if(Array.isArray(models.data))models.data=models.data.filter((model:{id:string})=>chatModelIds.includes(model.id));if(!models.data?.length)throw Error('no authorized chat models for managed instance');
    const providers=await this.http(base,'/api/admin/providers',undefined,admin);if(providers.some((p:{name:string})=>p.name!=='platform-gateway'))throw Error('managed instance has unexpected provider configuration');
    const provider=providers.find((p:{name:string})=>p.name==='platform-gateway'),body={name:'platform-gateway',kind:'openai',base_url:gateway.toString().replace(/\/$/,''),api_key:apiKey,stream_usage:true,models:models.data.map((m:{id:string})=>({id:m.id,name:m.id,enabled:true,input:['text'],api_mode:'chat_completions',api_fallback:'none'}))};
    await this.http(base,provider?`/api/admin/providers/${provider.id}`:'/api/admin/providers',body,admin,provider?'PATCH':'POST');
    const agents=await this.http(base,'/api/agents',undefined,userToken);let agent=agents.find((a:{agent_id:string})=>a.agent_id===info.agentId);
    const profile={name:'平台个人 Agent',default_model:`platform-gateway/${models.data[0].id}`,max_iters:32,max_tokens:128,skill_package_ids:[],knowledge_base_ids:[],mcp_servers:[],config:{memory:{memory_enabled:false,extract_on_session_end:false}}};
    if(!agent)agent=await this.http(base,'/api/agents',profile,userToken);else await this.http(base,`/api/agents/${agent.agent_id}`,{default_model:profile.default_model},userToken,'PATCH');
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(agent.agent_id))throw Error('invalid managed agent identity');info.agentId=agent.agent_id;
    const system=resolve(paths.home,'agents',agent.agent_id,'.octop');await mkdir(system,{recursive:true});await writeFile(resolve(system,'.bootstrapped'),'Platform instance has a configured owner.\n');
    await this.http(base,`/api/agents/${agent.agent_id}/reload`,{},userToken);await writeFile(record,JSON.stringify(info),{mode:0o600});running.info=info;
    running.userToken=userToken;running.tokenUntil=Date.now()+300_000;
    return this.observe(id);
  }
  async conversation(id:string,threadId:string|undefined,signal:AbortSignal){
    this.assertEnabled();const p=this.processes.get(id);if(!p||!this.observe(id).running||!p.info.agentId)throw Error('instance unavailable');
    const base=`http://127.0.0.1:${p.info.port}`,path=`/api/agents/${p.info.agentId}/threads`;
    if(!p.userToken||Date.now()>p.tokenUntil!){const login=await this.access(id);p.userToken=(await this.http(base,'/api/auth/login',{username:login.username,password:login.password})).access_token;p.tokenUntil=Date.now()+300_000;}
    signal.throwIfAborted();
    if(threadId){const sessions=await this.http(base,path,undefined,p.userToken);if(!Array.isArray(sessions)||!sessions.some((s:{thread_id:string})=>s.thread_id===threadId))throw Error('conversation unavailable');}
    else threadId=(await this.http(base,path,{},p.userToken)).thread_id;
    signal.throwIfAborted();if(typeof threadId!=='string'||!threadId)throw Error('conversation unavailable');
    const socket=new WebSocket(`${base.replace('http:','ws:')}/api/agents/${p.info.agentId}/chat/ws?token=${encodeURIComponent(p.userToken!)}`);
    return {socket,threadId};
  }
  async access(id:string){
    const p=this.processes.get(id);if(!p||!this.observe(id).running||!p.info.userId)throw Error('managed instance is not running');const base=`http://127.0.0.1:${p.info.port}`;
    const admin=(await this.http(base,'/api/auth/login',{username:'platform-admin',password:p.info.adminPassword})).access_token;
    const password=`User1-${randomBytes(32).toString('hex')}`;await this.http(base,`/api/users/${p.info.userId}/reset-password`,{new_password:password},admin);
    return {loginUrl:base,username:p.info.username,password};
  }
  async onModuleDestroy(){for(const id of this.processes.keys())await this.stop(id);if(this.rootLock){const current=JSON.parse(await readFile(this.rootLock.path,'utf8'));if(current.token===this.rootLock.token)await unlink(this.rootLock.path);this.rootLock=null;}}
}
