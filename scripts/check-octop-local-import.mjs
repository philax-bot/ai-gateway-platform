import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {createServer} from 'node:net';

export async function verifyLocalOctopImport({root,directory,cp,gw,web,password,children,check,report,people,api,command,secrets}){
  const [alice,bob]=people,route='/api/v1/platform/local-octop/imports',helper=resolve(directory,'octop-connector.ps1');
  await writeFile(helper,'\uFEFF'+await readFile(resolve(root,'apps/web/public/octop-connector.ps1'),'utf8'));
  const extraProviders=[];
  async function runHelper(input){
    const program=`$ErrorActionPreference='Stop';try{. '${helper.replaceAll("'","''")}' -LibraryOnly;$i=[Console]::In.ReadToEnd()|ConvertFrom-Json;Import-OctopProvider $i.base $i.token $i.config $i.platform;Write-Output 'IMPORTED'}catch{Write-Output ('IMPORT_FAILED: '+$_.Exception.Message+' '+$_.ScriptStackTrace);exit 1}`;
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',program],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);child.stdin.end(JSON.stringify(input));let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',()=>{});const code=await new Promise(r=>child.once('exit',r));assert.equal(code,0,'Windows connector import failed: '+out);assert.ok(out.includes('IMPORTED'));
  }
  async function nativeTurn(base,token,agentId){
    await new Promise((done,fail)=>{const ws=new WebSocket(`${base.replace('http:','ws:')}/api/agents/${agentId}/chat/ws?token=${token}`);let text='',finished=false;const frames=[];const timer=setTimeout(()=>end(Error('local import turn timeout')),45000);function end(e){if(finished)return;finished=true;clearTimeout(timer);ws.close();e?fail(e):done();}ws.addEventListener('open',()=>ws.send(JSON.stringify({type:'user_turn',text:'Reply MANAGED_OK',session_key:randomUUID(),skills:[],knowledge_base_ids:[],mcp_servers:[],conversation_mode:'ask'})));ws.addEventListener('error',()=>end(Error('native chat failed')));ws.addEventListener('message',e=>{const f=JSON.parse(e.data);if(frames.length<30)frames.push({type:f.type,keys:Object.keys(f)});if(f.type==='token')text+=f.content??'';if(f.type==='error')end(Error('native import model error'));if(f.type==='done')end(text.includes('MANAGED_OK')?null:Error('missing imported model result: '+JSON.stringify({text,frames})));});});
  }
  const adminTokens=new Map();
  for(const p of people){const info=JSON.parse(await readFile(resolve(directory,'managed',p.view.instance.id,'manager.json'),'utf8'));const login=await api(p.base,'/api/auth/login',{body:{username:'platform-admin',password:info.adminPassword}});adminTokens.set(p.name,login.value.access_token);secrets.push(login.value.access_token);}
  const expect=r=>{assert.equal(r.status,200);return r.value;};
  const issued=await command('key.issue',{name:'Local Octop import QA',purpose:'personal'},alice.cookie);secrets.push(issued.secret);
  const body={keyId:issued.key.id,apiKey:issued.secret};
  check((await api(cp,route,{body})).status===401,'local import requires platform login');
  check((await api(cp,route,{cookie:bob.cookie,body})).status===404,'another member cannot export this Key');
  check((await api(cp,route,{cookie:alice.cookie,body:{...body,baseUrl:'https://foreign.example'}})).status===400,'caller cannot replace gateway URL');
  const response=await api(cp,route,{cookie:alice.cookie,body}),created=expect(response);check(response.cache==='no-store'&&!created.url.includes(issued.secret),'launch URL is uncached and contains no API Key');
  check((await api(cp,route+'/'+created.id,{cookie:bob.cookie})).status===404,'import progress is owner scoped');
  const ticket=new URL(created.url).searchParams.get('ticket'),claim=expect(await api(cp,route+'/claim',{body:{ticket}}));secrets.push(claim.receipt);
  check(claim.config.baseUrl===gw+'/v1'&&claim.config.apiKey===issued.secret,'handoff carries the existing personal Key and configured gateway');
  check((await api(cp,route+'/claim',{body:{ticket}})).status===410,'ticket cannot be redeemed twice');
  const token=adminTokens.get('alice'),before=expect(await api(alice.base,'/api/admin/providers',{token}));
  await runHelper({base:alice.base,token,config:claim.config,platform:cp});
  let after=expect(await api(alice.base,'/api/admin/providers',{token}));const imported=after.find(p=>p.name===claim.config.providerName);extraProviders.push([alice,imported.id]);
  check(!!imported&&imported.api_key===issued.secret&&imported.base_url===gw+'/v1'&&imported.stream_usage,'actual Windows helper imports Provider into actual Octop');
  check(before.every(p=>JSON.stringify(after.find(a=>a.id===p.id))===JSON.stringify(p)),'import preserves every existing Provider');
  await runHelper({base:alice.base,token,config:claim.config,platform:cp});after=expect(await api(alice.base,'/api/admin/providers',{token}));check(after.filter(p=>p.name===claim.config.providerName).length===1,'repeated import updates the same managed Provider');
  const bobProviders=expect(await api(bob.base,'/api/admin/providers',{token:adminTokens.get('bob')}));check(!bobProviders.some(p=>p.api_key===issued.secret),'import does not change another user local instance');
  expect(await api(cp,route+'/complete',{body:{id:claim.id,receipt:claim.receipt,status:'completed'}}));check(expect(await api(cp,route+'/'+claim.id,{cookie:alice.cookie})).status==='completed','portal progress changes only after local completion acknowledgement');
  const agentResponse=await api(alice.base,'/api/agents',{token:alice.token,body:{name:'Local import QA',default_model:claim.config.providerName+'/test-model',max_iters:32,max_tokens:128,skill_package_ids:[],knowledge_base_ids:[],mcp_servers:[],config:{memory:{memory_enabled:false,extract_on_session_end:false}}}});assert.equal(agentResponse.status,201);const agent=agentResponse.value;
  const marker=resolve(directory,'managed',alice.view.instance.id,'home','agents',agent.agent_id,'.octop');await mkdir(marker,{recursive:true});await writeFile(resolve(marker,'.bootstrapped'),'QA local import is configured.\n');expect(await api(alice.base,`/api/agents/${agent.agent_id}/reload`,{body:{},token:alice.token}).then(r=>({...r,status:r.status===204?200:r.status})));
  await nativeTurn(alice.base,alice.token,agent.agent_id);check(true,'Octop uses the imported personal Key for an actual metered model call');
  await api(alice.base,`/api/agents/${agent.agent_id}`,{token:alice.token,method:'DELETE'});
  const installed=resolve(process.env.USERPROFILE??'','.octop/portable'),installedPython=resolve(installed,'runtime/python.exe');
  if(existsSync(installedPython)){
    const metadata=await readFile(resolve(installed,'VERSION.txt'),'utf8'),version=metadata.match(/^octop_version=(.+)$/m)?.[1]?.trim();
    const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));const base=`http://127.0.0.1:${port}`,home=resolve(directory,'installed-version-home');await mkdir(home);await writeFile(resolve(home,'config.json'),JSON.stringify({bind_host:'127.0.0.1',port,enable_dashboard:false,require_setup_password:false,database:{driver:'sqlite',sqlite_path:'octop.db'}}));
    const bootstrap=`import site,runpy;site.addsitedir(${JSON.stringify(resolve(installed,'packages'))});runpy.run_path(${JSON.stringify(resolve(root,'scripts/octop-local-only.py'))},run_name='__main__')`;
    const inherited=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(k)));
    const native=spawn(installedPython,['-c',bootstrap,'run','--host','127.0.0.1','--port',String(port)],{cwd:directory,env:{...inherited,OCTOP_HOME:home,OCTOP_DATABASE_DRIVER:'sqlite',OCTOP_GREEN_PACKAGES:resolve(installed,'packages'),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false',NO_PROXY:'127.0.0.1,localhost'},windowsHide:true,stdio:['ignore','pipe','pipe']});let nativeLog='';native.stdout.on('data',d=>nativeLog=(nativeLog+d).slice(-10000));native.stderr.on('data',d=>nativeLog=(nativeLog+d).slice(-10000));native.log=()=>nativeLog;children.push(native);
    let ready=false;for(let i=0;i<200;i++){if(native.exitCode!==null)break;try{ready=(await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,150));}if(!ready)throw Error('installed core startup failed: '+nativeLog.slice(-3000));check(ready,'installed Octop core starts with an isolated test home');
    const wizard=expect(await api(base,'/api/setup/begin',{body:{}})),admin=await api(base,'/api/setup/initial-admin',{token:wizard.wizard_token,body:{username:'local-import-qa',password}});assert.equal(admin.status,201);const localToken=admin.value.access_token;secrets.push(localToken);expect(await api(base,'/api/setup/finish',{body:{},token:localToken}));
    await runHelper({base,token:localToken,config:claim.config,platform:cp});await runHelper({base,token:localToken,config:claim.config,platform:cp});const providers=expect(await api(base,'/api/admin/providers',{token:localToken}));check(providers.length===1&&providers[0].api_key===issued.secret&&providers[0].base_url===gw+'/v1'&&providers[0].stream_usage,`installed Octop ${version}: actual create/update imports use the expected Key and protocol`);
    const legacyAgentResponse=await api(base,'/api/agents',{token:localToken,body:{name:'Installed version QA',default_model:claim.config.providerName+'/test-model',max_iters:32,max_tokens:128,skill_package_ids:[],knowledge_base_ids:[],mcp_servers:[],config:{memory:{memory_enabled:false,extract_on_session_end:false}}}});assert.equal(legacyAgentResponse.status,201);const legacyAgent=legacyAgentResponse.value;
    const legacyMarker=resolve(home,'agents',legacyAgent.agent_id,'.octop');await mkdir(legacyMarker,{recursive:true});await writeFile(resolve(legacyMarker,'.bootstrapped'),'QA import configured.\n');assert.equal((await api(base,`/api/agents/${legacyAgent.agent_id}/reload`,{token:localToken,body:{}})).status,204);
    await nativeTurn(base,localToken,legacyAgent.agent_id);check(true,`installed Octop ${version}: imported Key completes an actual metered model turn`);
    report.installedOctopCompatibility={version,actualProviderApiImport:true,actualProviderApiUpdate:true,actualMeteredTurn:true,home:'isolated QA home',desktopGuiOpened:false,existingUserHomeChanged:false};
  }
  if(process.argv.includes('--web')){const {verifyLocalImportBrowser}=await import('./check-octop-local-import-web.mjs');await verifyLocalImportBrowser({root,directory,cp,gw,web,password,children,check,report});}
  // Parent lifecycle checks expect only their dedicated Provider after this isolated import test.
  for(const [p,id] of extraProviders)await api(p.base,`/api/admin/providers/${id}`,{token:adminTokens.get(p.name),method:'DELETE'});
  report.localImport={success:true,actualWindowsPowerShell:true,actualOctop:true,upstream:'local stand-in',realModelRequests:0,officialDesktopInstallerTested:false};
}
