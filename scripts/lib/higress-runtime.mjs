import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {HIGRESS_IMAGE,MODEL_IMAGE,resources} from '../higress/poc-config.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tuneMesh=value=>value.replace(/^    dnsRefreshRate:.*$/m,'    dnsRefreshRate: 5s').replace(/    accessLogFormat: \|[\s\S]*?(?=    configSources:)/,'    accessLogFormat: |\n      {"request_id":"%REQ(X-REQUEST-ID)%","response_code":"%RESPONSE_CODE%","route_name":"%ROUTE_NAME%","flags":"%RESPONSE_FLAGS%","transport_failure":"%UPSTREAM_TRANSPORT_FAILURE_REASON%"}\n');
export function command(binary,args,{root,timeout=30000,allowFailure=false}={}){return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
  child.stdout.on('data',v=>out=(out+v).slice(-200000));child.stderr.on('data',v=>err=(err+v).slice(-10000));
  const timer=setTimeout(()=>child.kill(),timeout);child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);if(code===0||allowFailure)resolve({code,out,err});else reject(new Error(`${binary} ${args[0]} failed (${code}); inspect the owned Higress runtime`));});
});}
export async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function openHigress({root,directory,fixture=false,persistent=false,localModelPort}){
  await mkdir(directory,{recursive:true});
  const run=(args,options={})=>command('podman',args,{root,...options});
  let state;
  try{state=JSON.parse(await readFile(resolve(directory,'runtime.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!state){const id=randomUUID();state={version:1,id,name:`atlas-hg-${id}`,image:HIGRESS_IMAGE,apiToken:randomUUID(),proxyToken:randomUUID(),modelToken:randomUUID()};await writeFile(resolve(directory,'runtime.json'),JSON.stringify(state),{mode:0o600,flag:'wx'});}
  if(state.version!==1||state.image!==HIGRESS_IMAGE||!/^atlas-hg-[a-f0-9-]{36}$/.test(state.name))throw new Error('Higress runtime identity mismatch; existing resources preserved');
  const machines=JSON.parse((await run(['machine','list','--format','json'])).out);
  if(!machines.some(m=>m.Running))await run(['machine','start','podman-machine-default'],{timeout:60000});
  await run(['info']);
  const ssh=JSON.parse((await run(['machine','inspect'])).out)[0].SSHConfig;
  if(!/^[a-z_][a-z0-9_-]*$/.test(ssh.RemoteUsername))throw new Error('invalid machine SSH identity');
  const name=state.name,owned=[name+'-gateway',name+'-management',...(fixture?[name+'-model']:[])];
  if(localModelPort!==undefined&&(!Number.isSafeInteger(localModelPort)||localModelPort<1024||localModelPort>65535))throw new Error('invalid local model port');
  const socketDirectory='/tmp/'+name+'-relay';
  let tunnel,closed=false;
  async function close(){if(closed)return;closed=true;tunnel?.kill();
    for(const container of [...owned].reverse())await run([persistent?'stop':'rm',...(persistent?['--time','3']:['--force']),container],{allowFailure:true});
    if(localModelPort)await run(['machine','ssh','podman-machine-default','rm','-f',socketDirectory+'/model.sock'],{allowFailure:true});
    if(!persistent)await run(['network','rm',name],{allowFailure:true});
  }
  try{
    if((await run(['network','exists',name],{allowFailure:true})).code!==0)await run(['network','create','--label',`atlas.runtime=${state.id}`,...(fixture?['--internal']:[]),name]);
    const network=JSON.parse((await run(['network','inspect',name])).out)[0],subnet=network.subnets?.[0]?.subnet;
    if(network.labels?.['atlas.runtime']!==state.id)throw new Error('Refusing to modify an unowned network');
    if(!/^\d+\.\d+\.\d+\.0\/24$/.test(subnet??''))throw new Error('Owned Higress network requires an IPv4 /24 subnet');
    const prefix=subnet.split('.').slice(0,3).join('.'),gatewayAddress=prefix+'.10',modelAddress=prefix+'.11';
    async function exists(container){const result=await run(['container','inspect',container],{allowFailure:true});if(result.code!==0)return false;const value=JSON.parse(result.out)[0];if(value.Config.Labels['atlas.runtime']!==state.id)throw new Error('Refusing to adopt unowned container');return true;}
    async function detach(container){await run(['stop','--time','1',container],{allowFailure:true});const value=JSON.parse((await run(['inspect',container])).out)[0];if(value.NetworkSettings.Networks?.[name])await run(['network','disconnect',name,container]);}
    if(await exists(name+'-management'))await run(['stop','--time','1',name+'-management']);
    const existingModel=fixture&&await exists(name+'-model');if(existingModel)await detach(name+'-model');
    if(await exists(name+'-gateway')){await detach(name+'-gateway');await run(['network','connect','--ip',gatewayAddress,name,name+'-gateway']);}
    else{
      await run(['create','--name',name+'-gateway','--label',`atlas.runtime=${state.id}`,'--network',name,'--ip',gatewayAddress,'--env','MODE=gateway','--env','O11Y=off','--env','USE_PLUGIN_SERVER=on','--env','GATEWAY_CONCURRENCY=2','--env','GATEWAY_AUTO_HTTPS_ENABLED=false','--pull','never',HIGRESS_IMAGE]);
      const defaults=resolve(directory,'defaults');await run(['cp',name+'-gateway:/opt/data/defaultConfig',defaults]);
      const mesh=resolve(defaults,'configmaps/higress-config.yaml');await writeFile(mesh,tuneMesh(await readFile(mesh,'utf8')));
      await run(['cp',defaults+'/.',name+'-gateway:/data']);
      await run(['cp',mesh,name+'-gateway:/opt/data/defaultConfig/configmaps/higress-config.yaml']);
      const requestId=Object.values(resources({proxyToken:state.proxyToken,upstreamToken:state.modelToken})).find(r=>r.kind==='EnvoyFilter');
      const filter=resolve(directory,'request-id.json');await writeFile(filter,JSON.stringify(requestId));await run(['cp',filter,name+'-gateway:/data/envoyfilters/atlas-request-id.yaml']);await unlink(filter);
    }
    // Upgrade only managed mesh settings; preserve all routes, plugins and stored data.
    const meshRuntime=resolve(directory,'mesh-runtime.yaml');
    const copied=await run(['cp',name+'-gateway:/data/configmaps/higress-config.yaml',meshRuntime],{allowFailure:true});
    if(copied.code!==0)await run(['cp',name+'-gateway:/opt/data/defaultConfig/configmaps/higress-config.yaml',meshRuntime]);
    await writeFile(meshRuntime,tuneMesh(await readFile(meshRuntime,'utf8')));await run(['cp',meshRuntime,name+'-gateway:/data/configmaps/higress-config.yaml']);await run(['cp',meshRuntime,name+'-gateway:/opt/data/defaultConfig/configmaps/higress-config.yaml']);await unlink(meshRuntime);
    await run(['start',name+'-gateway']);
    if(localModelPort){
      await run(['machine','ssh','podman-machine-default','mkdir','-p','-m','700',socketDirectory]);
      await run(['machine','ssh','podman-machine-default','chown',ssh.RemoteUsername,socketDirectory]);
      // sshd may retain the owned pathname after an interrupted remote forward.
      await run(['machine','ssh','podman-machine-default','rm','-f',socketDirectory+'/model.sock']);
      if(await exists(name+'-management')){const info=JSON.parse((await run(['inspect',name+'-management'])).out)[0];if(!info.Config.Env.includes('LOCAL_MODEL_RELAY=true'))await run(['rm','--force',name+'-management']);}
    }
    if(!await exists(name+'-management')){
      const envFile=resolve(directory,'relay.env');await writeFile(envFile,`API_TOKEN=${state.apiToken}\nLOCAL_MODEL_RELAY=${!!localModelPort}\n`,{mode:0o600});
      try{await run(['create','--name',name+'-management','--label',`atlas.runtime=${state.id}`,'--network',`container:${name}-gateway`,...(localModelPort?['--volume',`${socketDirectory}:/host-relay:ro`]:[]),'--env-file',envFile,'--pull','never',MODEL_IMAGE,'node','/management.cjs']);}finally{await unlink(envFile);}
    }
    await run(['stop','--time','1',name+'-management'],{allowFailure:true});
    await run(['cp',resolve(root,'scripts/higress/management-relay.cjs'),name+'-management:/management.cjs']);
    await run(['cp',resolve(root,'scripts/higress/runtime-readiness.cjs'),name+'-management:/runtime-readiness.cjs']);
    await run(['start',name+'-management']);
    if(fixture){
      if(!await exists(name+'-model')){
        await run(['create','--name',name+'-model','--label',`atlas.runtime=${state.id}`,'--network',name,'--ip',modelAddress,'--network-alias','model.poc.test','--env',`MOCK_API_TOKEN=${state.modelToken}`,'--pull','never',MODEL_IMAGE,'node','/fixture.cjs']);
      }
      else await run(['network','connect','--ip',modelAddress,'--alias','model.poc.test',name,name+'-model']);
      await run(['stop','--time','1',name+'-model'],{allowFailure:true});
      await run(['cp',resolve(root,'scripts/higress/model-fixture.cjs'),name+'-model:/fixture.cjs']);
      await run(['start',name+'-model']);
    }
    const gateway=JSON.parse((await run(['inspect',name+'-gateway'])).out)[0],ip=gateway.NetworkSettings.Networks[name].IPAddress;
    const apiPort=await freePort(),proxyPort=await freePort(),modelPort=fixture?await freePort():null;
    const args=['-N','-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','StrictHostKeyChecking=accept-new','-o',`UserKnownHostsFile=${resolve(directory,'known_hosts')}`,'-i',ssh.IdentityPath,'-p',String(ssh.Port),'-L',`127.0.0.1:${apiPort}:${ip}:19090`,'-L',`127.0.0.1:${proxyPort}:${ip}:8080`];
    if(localModelPort)args.push('-o','StreamLocalBindUnlink=yes','-R',`${socketDirectory}/model.sock:127.0.0.1:${localModelPort}`);
    if(fixture){const model=JSON.parse((await run(['inspect',name+'-model'])).out)[0];args.push('-L',`127.0.0.1:${modelPort}:${model.NetworkSettings.Networks[name].IPAddress}:4010`);}
    args.push(`${ssh.RemoteUsername}@127.0.0.1`);let tunnelDiagnostic='';tunnel=spawn('ssh',args,{windowsHide:true,stdio:['ignore','ignore','pipe']});tunnel.stderr.on('data',data=>tunnelDiagnostic=(tunnelDiagnostic+data).slice(-2000));tunnel.on('error',error=>{tunnelDiagnostic=error.message;});
    const api=`http://127.0.0.1:${apiPort}`,proxy=`http://127.0.0.1:${proxyPort}`;
    let ready=false;for(let n=0;n<300;n++){try{if((await fetch(api+'/apis/networking.k8s.io/v1/namespaces/higress-system/ingresses',{headers:{authorization:`Bearer ${state.apiToken}`},signal:AbortSignal.timeout(800)})).ok){ready=true;break;}}catch{}await pause(200);}
    if(!ready)throw new Error('Authenticated Higress management relay did not start: '+tunnelDiagnostic);
    if(fixture){let modelReady=false;for(let n=0;n<100;n++){try{if((await fetch(`http://127.0.0.1:${modelPort}/_poc/ready`,{signal:AbortSignal.timeout(500)})).ok){modelReady=true;break;}}catch{}await pause(100);}if(!modelReady)throw new Error('Owned deterministic model fixture did not start');}
    const gatewayEnvironment={GATEWAY_DATA_PLANE:'higress',HIGRESS_PROXY_URL:proxy,UPSTREAM_HIGRESS_INTERNAL:state.proxyToken};
    return {state,name,api,proxy,model:fixture?`http://127.0.0.1:${modelPort}`:null,close,run,gatewayEnvironment,environment:{...gatewayEnvironment,HIGRESS_API_URL:api,HIGRESS_API_TOKEN:state.apiToken,HIGRESS_REQUIRE_RUNTIME_READY:'true',...(localModelPort?{HIGRESS_LOOPBACK_SOURCE_PORT:String(localModelPort),HIGRESS_LOOPBACK_RELAY_URL:'http://127.0.0.1:8111'}:{HIGRESS_LOOPBACK_HOST:'host.containers.internal'})}};
  }catch(error){await close();throw error;}
}
