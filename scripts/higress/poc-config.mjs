// These pins identify the images actually used by the isolated experiment.
// The bundled plugin versions differ from the standalone main-branch templates.
export const HIGRESS_IMAGE='higress-registry.cn-hangzhou.cr.aliyuncs.com/higress/all-in-one@sha256:e650ae5244bb89e95a7cbe5188b9c0c9caf7a165aa5e4c89364e37a1e3efbb24';
export const MODEL_IMAGE='docker.io/library/node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
export const namespace='higress-system';
const metadata=name=>({name,namespace,resourceVersion:'1'});

export function ingress(version='v1',{unavailable=false}={}){
  if(!/^v[0-9]+$/.test(version))throw new Error('invalid PoC version');
  return {apiVersion:'networking.k8s.io/v1',kind:'Ingress',metadata:{...metadata('atlas-poc'),annotations:{
    'higress.io/destination':`${unavailable?'missing-backend':'poc-model'}.dns:4010`,
    'higress.io/ignore-path-case':'false',
    'higress.io/proxy-next-upstream':'off',
    'higress.io/proxy-next-upstream-tries':'0',
    'higress.io/response-header-control-update':`x-atlas-poc-version ${version}`,
  }},spec:{rules:[{http:{paths:['/v1/chat/completions','/_poc/ready'].map(path=>({path,pathType:'Exact',backend:{resource:{apiGroup:'networking.higress.io',kind:'McpBridge',name:'default'}}}))}}]}};
}

export function resources({proxyToken,upstreamToken}){
  if(!proxyToken||!upstreamToken||proxyToken===upstreamToken)throw new Error('distinct test credentials required');
  const wasm=(name,version,phase,priority,config)=>({apiVersion:'extensions.higress.io/v1alpha1',kind:'WasmPlugin',metadata:metadata(`atlas-${name}`),spec:{
    defaultConfig:config,defaultConfigDisable:false,failStrategy:'FAIL_CLOSE',phase,priority,
    url:`http://127.0.0.1:8002/plugins/${name}/${version}/plugin.wasm`,
  }});
  const proxy=wasm('ai-proxy','2.0.3','UNSPECIFIED_PHASE',100,{providers:[{id:'local-openai',type:'openai',apiTokens:[upstreamToken],openaiCustomUrl:'http://model.poc.test:4010/v1/chat/completions',modelMapping:{'poc-model':'physical-model'},retryOnFailure:{enabled:false},failover:{enabled:false}}]});
  proxy.spec.matchRules=[{ingress:['atlas-poc'],configDisable:false,config:{activeProviderId:'local-openai'}}];
  return {
    // Higress is a private hop after admission: retain its authoritative correlation ID.
    'envoyfilters/atlas-request-id.yaml':{apiVersion:'networking.istio.io/v1alpha3',kind:'EnvoyFilter',metadata:{...metadata('atlas-request-id'),labels:{higress:'higress-system-higress-gateway'}},spec:{configPatches:[{applyTo:'NETWORK_FILTER',match:{context:'GATEWAY',listener:{filterChain:{filter:{name:'envoy.filters.network.http_connection_manager'}}}},patch:{operation:'MERGE',value:{name:'envoy.filters.network.http_connection_manager',typed_config:{'@type':'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',preserve_external_request_id:true,request_id_extension:{typed_config:{'@type':'type.googleapis.com/envoy.extensions.request_id.uuid.v3.UuidRequestIdConfig',pack_trace_reason:false}}}}}}]}},
    'mcpbridges/default.yaml':{apiVersion:'networking.higress.io/v1',kind:'McpBridge',metadata:metadata('default'),spec:{registries:[{name:'poc-model',type:'dns',domain:'model.poc.test',port:4010,protocol:'http'}]}},
    'ingresses/atlas-poc.yaml':ingress(),
    'wasmplugins/atlas-key-auth.yaml':wasm('key-auth','2.0.0','AUTHN',310,{global_auth:true,keys:['authorization'],in_header:true,in_query:false,consumers:[{name:'atlas-admission-proxy',credential:`Bearer ${proxyToken}`}]}),
    'wasmplugins/atlas-ai-proxy.yaml':proxy,
  };
}
