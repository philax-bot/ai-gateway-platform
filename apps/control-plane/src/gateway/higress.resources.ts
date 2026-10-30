import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import type {RouteSnapshot} from '@ai-gateway/contracts';
import {protocolUrl} from '@ai-gateway/contracts';

const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])):value;
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** Kubernetes adds default fields; compare the fields controlled by this publisher. */
export function containsConfiguration(actual:unknown,expected:unknown):boolean{
  if(Array.isArray(expected))return Array.isArray(actual)&&actual.length===expected.length&&expected.every((item,index)=>containsConfiguration(actual[index],item));
  if(expected&&typeof expected==='object')return !!actual&&typeof actual==='object'&&Object.entries(expected).every(([key,value])=>containsConfiguration((actual as Record<string,unknown>)[key],value));
  return actual===expected;
}
export const resourceId=(route:Pick<RouteSnapshot,'serviceId'|'definitionId'>)=>`route-${digest([route.serviceId,route.definitionId]).slice(0,32)}`;
export function binding(route:RouteSnapshot,credential:string){
  const local=['localhost','127.0.0.1','[::1]'].includes(new URL(route.baseUrl).hostname);
  return digest(['atlas-higress-config-v3',route.serviceId,route.definitionId,route.baseUrl,route.protocolPaths??{},route.upstreamModel,route.credentialRef,digest(credential),digest(process.env.UPSTREAM_HIGRESS_INTERNAL??''),...(local?[process.env.HIGRESS_LOOPBACK_HOST,process.env.HIGRESS_LOOPBACK_SOURCE_PORT,process.env.HIGRESS_LOOPBACK_RELAY_URL]:[])]);
}
export interface Resource {apiVersion:string;kind:string;metadata:{name:string;namespace:string;[key:string]:unknown};spec:Record<string,unknown>}
export function renderRoute(route:RouteSnapshot,version:string,credential:string,proxyToken:string,namespace:string):{name:string;resources:Resource[]}{
  const target=new URL(route.baseUrl);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash)throw new Error('invalid_route_url');
  if(['localhost','127.0.0.1','[::1]'].includes(target.hostname)&&process.env.PLATFORM_MODE!=='production'){
    if(process.env.HIGRESS_LOOPBACK_RELAY_URL&&target.port===process.env.HIGRESS_LOOPBACK_SOURCE_PORT){const relay=new URL(process.env.HIGRESS_LOOPBACK_RELAY_URL);if(relay.protocol!=='http:'||relay.hostname!=='127.0.0.1')throw new Error('invalid_loopback_relay');target.hostname=relay.hostname;target.port=relay.port;}
    else if(process.env.HIGRESS_LOOPBACK_HOST)target.hostname=process.env.HIGRESS_LOOPBACK_HOST;
  }
  const name=`atlas-${digest([binding(route,credential),version]).slice(0,32)}`,probe=name+'-probe',port=Number(target.port||(target.protocol==='https:'?443:80));
  const metadata=(name:string)=>({name,namespace,labels:{'app.kubernetes.io/managed-by':'atlas'}});
  const wasm=(name:string,plugin:string,version:string,phase:string,priority:number,config:unknown,ingresses:string[]):Resource=>({apiVersion:'extensions.higress.io/v1alpha1',kind:'WasmPlugin',metadata:metadata(name),spec:{url:`http://127.0.0.1:8002/plugins/${plugin}/${version}/plugin.wasm`,failStrategy:'FAIL_CLOSE',phase,priority,defaultConfigDisable:true,defaultConfig:{},matchRules:[{ingress:ingresses,configDisable:false,config}]}});
  let path=target.pathname.replace(/\/+$/,'');if(!path.endsWith('/chat/completions'))path+=path.endsWith('/v1')?'/chat/completions':'/v1/chat/completions';target.pathname=path;
  const ingress=(id:string,path:string):Resource=>({apiVersion:'networking.k8s.io/v1',kind:'Ingress',metadata:{...metadata(id),annotations:{'higress.io/destination':id===probe?'atlas-readiness.static:1':`${name}.${isIP(target.hostname)?'static':'dns'}:${port}`,'higress.io/request-header-control-remove':'x-atlas-hop-token','higress.io/proxy-next-upstream':'off','higress.io/proxy-next-upstream-tries':'0','higress.io/response-header-control-update':`x-atlas-config-version ${name}`}},spec:{rules:[{http:{paths:[{path,pathType:'Exact',backend:{resource:{apiGroup:'networking.higress.io',kind:'McpBridge',name:'default'}}}]}}]}});
  const native=(protocol:'responses'|'messages')=>{
    const value=ingress(name+'-'+protocol,`/atlas/${name}/v1/${protocol}`),annotations=value.metadata.annotations as Record<string,string>;
    annotations['higress.io/rewrite-target']=new URL(protocolUrl(route.baseUrl,protocol,route.protocolPaths)).pathname;
    annotations['higress.io/upstream-vhost']=new URL(route.baseUrl).host;
    if(credential)annotations['higress.io/request-header-control-update']='authorization Bearer '+credential+(protocol==='messages'?'\nx-api-key '+credential:'');
    return value;
  };
  return {name,resources:[
    {apiVersion:'networking.higress.io/v1',kind:'McpBridge',metadata:metadata('default'),spec:{registries:[{name,type:isIP(target.hostname)?'static':'dns',domain:isIP(target.hostname)?`${target.hostname}:${port}`:target.hostname,port,protocol:target.protocol==='https:'?'https':'http'},{name:'atlas-readiness',type:'static',domain:'127.0.0.1:1',port:1,protocol:'http'}]}},
    wasm(name+'-auth','key-auth','2.0.0','AUTHN',310,{global_auth:false,keys:['x-atlas-hop-token'],in_header:true,in_query:false,consumers:[{name:'atlas-admission',credential:`Bearer ${proxyToken}`}]},[name,probe,name+'-responses',name+'-messages']),
    wasm('atlas-ai-proxy','ai-proxy','2.0.3','UNSPECIFIED_PHASE',90,{activeProviderId:name,providers:[{id:name,type:'openai',...(credential?{apiTokens:[credential]}:{}),openaiCustomUrl:target.toString(),modelMapping:{[name]:route.upstreamModel},retryOnFailure:{enabled:false},failover:{enabled:false}}]},[name]),
    // A local response confirms xDS/plugin delivery without generating model tokens.
    wasm(name+'-ready','custom-response','2.0.0','AUTHN',10,{status_code:200,body:name,headers:['content-type=text/plain']},[probe]),
    ingress(name,`/atlas/${name}/v1/chat/completions`),ingress(probe,`/atlas/${name}/_ready`),
    native('responses'),native('messages'),
  ]};
}
