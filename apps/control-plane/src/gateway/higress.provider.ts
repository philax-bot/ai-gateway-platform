import {Injectable} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {GatewaySyncRequest,GatewaySyncResponse,RouteSnapshot} from '@ai-gateway/contracts';
import type {GatewayProvider} from './gateway-provider';
import {WorkspaceRepository} from '../platform/workspace.repository';
import {GatewaySyncRepository,SyncState} from './gateway-sync.repository';
import {binding,containsConfiguration,digest,renderRoute,resourceId,Resource} from './higress.resources';

const plurals:Record<string,string>={Ingress:'ingresses',McpBridge:'mcpbridges',WasmPlugin:'wasmplugins'};
@Injectable()
export class HigressProvider implements GatewayProvider {
  constructor(private readonly repository:GatewaySyncRepository,private readonly workspace:WorkspaceRepository){}
  get enabled(){return process.env.GATEWAY_DATA_PLANE==='higress';}
  private configured(){return !!(process.env.HIGRESS_API_URL&&process.env.HIGRESS_API_TOKEN&&process.env.HIGRESS_PROXY_URL&&process.env.UPSTREAM_HIGRESS_INTERNAL);}
  private expire(state:SyncState){
    for(const op of Object.values(state.operations))if(op.response.status==='pending'&&op.leaseUntil<Date.now()){
      op.response.status='rejected';op.response.errorCode='publication_interrupted';
      if(state.latest?.operationId===op.response.operationId)state.latest=op.response;
    }
  }
  async getSyncStatus(id:string):Promise<GatewaySyncResponse|null>{const state=await this.repository.read(id);if(!Object.values(state.operations).some(op=>op.response.status==='pending'&&op.leaseUntil<Date.now()))return state.latest??null;return this.repository.change(id,state=>{this.expire(state);return state.latest??null;});}
  async publishPolicyReference(input:GatewaySyncRequest){return this.rejected(input,'unsupported_resource_type');}
  private rejected(input:GatewaySyncRequest,code:string):GatewaySyncResponse{return {provider:'higress',resourceId:input?.resourceId??'',desiredVersion:input?.desiredVersion??'',appliedVersion:null,status:'rejected',operationId:`provider-op-${randomUUID()}`,errorCode:code};}
  private credential(route:RouteSnapshot){
    if(!route.credentialRef)return '';
    if(!/^UPSTREAM_[A-Z0-9_]+$/.test(route.credentialRef)||!process.env[route.credentialRef])throw new Error('credential_unavailable');
    return process.env[route.credentialRef]!;
  }
  private async source(input:GatewaySyncRequest):Promise<RouteSnapshot>{
    const state=await this.workspace.readGatewayConfiguration();
    const service=state.services.find(s=>s.id===input.spec.serviceId),mapping=service?.mappings.find(m=>m.definitionId===input.spec.definitionId);
    if(!service||!mapping||!service.active)throw new Error('route_unavailable');
    return {serviceId:service.id,definitionId:mapping.definitionId,poolId:'',baseUrl:service.baseUrl,protocolPaths:service.protocolPaths,credentialRef:service.credentialRef,upstreamModel:mapping.upstreamModel,maxOutputTokens:1};
  }
  async publishRoute(input:GatewaySyncRequest):Promise<GatewaySyncResponse>{
    if(!this.configured())return this.rejected(input,'provider_unconfigured');
    if(!input||input.provider!=='higress'||input.resourceType!=='model_route'||!input.spec||!['serviceId','definitionId'].every(k=>typeof input.spec[k]==='string')||Object.keys(input.spec).some(k=>!['serviceId','definitionId'].includes(k))||![input.resourceId,input.desiredVersion,input.idempotencyKey].every(v=>typeof v==='string'&&v.length>0&&v.length<=160))return this.rejected(input,'invalid_sync_request');
    let route:RouteSnapshot,credential:string;
    try{route=await this.source(input);credential=this.credential(route);}catch{return this.rejected(input,'route_unavailable');}
    if(input.resourceId!==resourceId(route))return this.rejected(input,'resource_identity_mismatch');
    const bound=binding(route,credential),operationKey=digest(input.idempotencyKey),fingerprint=digest([input.provider,input.resourceType,input.resourceId,input.desiredVersion,input.previousVersion,input.spec.serviceId,input.spec.definitionId,bound]);
    const claim=await this.repository.change(input.resourceId,state=>{
      this.expire(state);
      const prior=state.operations[operationKey];
      if(prior)return {run:false,response:prior.fingerprint===fingerprint?prior.response:this.rejected(input,'idempotency_conflict')};
      if(Object.values(state.operations).some(op=>op.response.status==='pending'))return {run:false,response:this.rejected(input,'publication_in_progress')};
      if(input.previousVersion!==undefined&&input.previousVersion!==(state.active?.version??null))return {run:false,response:this.rejected(input,'version_conflict')};
      if(Object.values(state.operations).some(op=>op.response.desiredVersion===input.desiredVersion&&op.binding!==bound&&op.response.status==='applied'))return {run:false,response:this.rejected(input,'version_conflict')};
      const response={...this.rejected(input,''),status:'pending' as const,errorCode:null,appliedVersion:state.active?.version??null};
      state.operations[operationKey]={fingerprint,binding:bound,response,leaseUntil:Date.now()+120000};state.latest=response;
      return {run:true,response};
    });
    if(!claim.run)return claim.response;
    let name='',errorCode:string|null=null;
    try{
      const namespace=process.env.HIGRESS_NAMESPACE??'higress-system';if(!/^[a-z0-9-]{1,63}$/.test(namespace))throw new Error('invalid_namespace');
      const rendered=renderRoute(route,input.desiredVersion,credential,process.env.UPSTREAM_HIGRESS_INTERNAL!,namespace);name=rendered.name;
      for(const resource of rendered.resources)await this.upsert(resource);
      await this.observe(name);
    }catch(error){errorCode=error instanceof Error&&/^[a-z_0-9]+$/.test(error.message)?error.message:'runtime_not_confirmed';}
    return this.repository.change(input.resourceId,state=>{
      const op=state.operations[operationKey];
      if(op?.response.operationId!==claim.response.operationId)return {...this.rejected(input,'operation_superseded'),operationId:claim.response.operationId};
      if(op.response.status!=='pending'||op.leaseUntil<Date.now()||state.latest?.operationId!==op.response.operationId){
        this.expire(state);if(op.response.status==='pending'){op.response.status='rejected';op.response.errorCode='operation_superseded';}return op.response;
      }
      op.response.status=errorCode?'rejected':'applied';op.response.errorCode=errorCode;
      if(!errorCode){state.active={binding:bound,version:input.desiredVersion,name};op.response.appliedVersion=input.desiredVersion;}
      state.latest=op.response;return op.response;
    });
  }
  private apiUrl(path:string){
    const target=new URL(process.env.HIGRESS_API_URL!);
    if(target.username||target.password||target.search||target.hash||!(target.protocol==='https:'||(target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname))))throw new Error('invalid_management_url');
    return target.toString().replace(/\/$/,'')+path;
  }
  private async request(path:string,method='GET',body?:unknown){
    const response=await fetch(this.apiUrl(path),{method,redirect:'error',headers:{authorization:`Bearer ${process.env.HIGRESS_API_TOKEN}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    if(response.status===404&&method==='GET')return null;
    if(!response.ok){await response.body?.cancel();throw new Error('management_request_'+response.status);}
    return response.json() as Promise<Record<string,any>>;
  }
  private async upsert(resource:Resource){
    const collection=`/apis/${resource.apiVersion}/namespaces/${resource.metadata.namespace}/${plurals[resource.kind]}`;
    const path=`${collection}/${resource.metadata.name}`;
    if(resource.kind==='WasmPlugin'&&resource.metadata.name==='atlas-ai-proxy'){
      const rule=(resource.spec.matchRules as {ingress:string[]}[])[0];
      for(let attempt=0;attempt<4;attempt++){
        const prior=await this.request(path);
        if(!prior){try{await this.request(collection,'POST',resource);return;}catch(error){if(error instanceof Error&&error.message==='management_request_409')continue;throw error;}}
        if(prior.metadata?.labels?.['app.kubernetes.io/managed-by']!=='atlas'||prior.spec?.url!==resource.spec.url||prior.spec?.priority!==resource.spec.priority)throw new Error('shared_plugin_ownership_conflict');
        const rules=(prior.spec.matchRules??[]) as {ingress:string[]}[],existing=rules.find(r=>r.ingress?.includes(rule.ingress[0]));
        if(existing){if(!containsConfiguration(existing,rule))throw new Error('immutable_plugin_rule_conflict');return;}
        try{await this.request(path,'PUT',{...prior,spec:{...prior.spec,matchRules:[...rules,rule]}});return;}catch(error){if(!(error instanceof Error)||error.message!=='management_request_409'||attempt===3)throw error;}
      }
      throw new Error('shared_plugin_update_conflict');
    }
    if(resource.kind==='McpBridge'){
      const upsertRegistry=async(registry:{name:string})=>{
      for(let attempt=0;attempt<4;attempt++){
        const prior=await this.request(path);
        const registries=(prior?.spec?.registries??[]) as {name:string}[],existing=registries.find(item=>item.name===registry.name);
        if(existing){if(!containsConfiguration(existing,registry))throw new Error('immutable_registry_conflict');return;}
        try{await this.request(prior?path:collection,prior?'PUT':'POST',prior?{...prior,spec:{...prior.spec,registries:[...registries,registry]}}:resource);return;}
        catch(error){if(!(error instanceof Error)||error.message!=='management_request_409'||attempt===3)throw error;}
      }
      };
      for(const registry of resource.spec.registries as {name:string}[])await upsertRegistry(registry);return;
    }
    const prior=await this.request(path);
    // The bundled API uses protobuf JSON and omits zero-valued enum defaults.
    const observed=resource.kind==='WasmPlugin'?{failStrategy:'FAIL_CLOSE',phase:'UNSPECIFIED_PHASE',...prior?.spec}:prior?.spec;
    if(prior&&(!containsConfiguration(observed,resource.spec)||!containsConfiguration(prior.metadata?.annotations??{},resource.metadata.annotations??{})))throw new Error('immutable_'+resource.kind.toLowerCase()+'_conflict');
    if(!prior)await this.request(collection,'POST',resource);
  }
  private async observe(name:string){
    const address=process.env.HIGRESS_PROXY_URL!.replace(/\/$/,'')+`/atlas/${name}/_ready`;
    const deadline=Date.now()+20000;
    let errorCode='runtime_not_confirmed';
    do{
      try{const response=await fetch(address,{headers:{'x-atlas-hop-token':`Bearer ${process.env.UPSTREAM_HIGRESS_INTERNAL}`},redirect:'error',signal:AbortSignal.timeout(1200)});if(response.ok&&response.headers.get('x-atlas-config-version')===name&&(await response.text())===name){
        if(process.env.HIGRESS_REQUIRE_RUNTIME_READY!=='true')return;
        const runtime=await this.request('/runtime/ready/'+name);if(runtime?.ready===true)return;errorCode='upstream_not_ready';
      }else await response.body?.cancel();}catch{}
      await new Promise(resolve=>setTimeout(resolve,200));
    }while(Date.now()<deadline);
    throw new Error(errorCode);
  }
  async transport(route:RouteSnapshot,verifyRuntime=false):Promise<NonNullable<RouteSnapshot['transport']>>{
    try{
      if(!this.configured())return {kind:'unavailable'};
      const bound=binding(route,this.credential(route)),id=resourceId(route);
      let active=await this.repository.active(id);
      if(active?.binding===bound&&verifyRuntime){
        try{await this.observe(active.name);}catch{
          await this.publishRoute({provider:'higress',resourceType:'model_route',resourceId:id,desiredVersion:active.version,idempotencyKey:`recover-${randomUUID()}`,spec:{serviceId:route.serviceId,definitionId:route.definitionId}});
          active=await this.repository.active(id);
          try{if(active)await this.observe(active.name);else return {kind:'unavailable'};}catch{return {kind:'unavailable'};}
        }
      }
      if(active?.binding!==bound){
        await this.publishRoute({provider:'higress',resourceType:'model_route',resourceId:id,desiredVersion:bound,idempotencyKey:`auto-${bound}-${Math.floor(Date.now()/60000)}`,spec:{serviceId:route.serviceId,definitionId:route.definitionId}});
        active=await this.repository.active(id);
      }
      if(active?.binding!==bound)return {kind:'unavailable'};
      return {kind:'higress',baseUrl:process.env.HIGRESS_PROXY_URL!.replace(/\/$/,'')+`/atlas/${active.name}`,model:active.name,version:active.version};
    }catch{return {kind:'unavailable'};}
  }
  /** Prepare configured routes without generating upstream requests or changing business state. */
  async reconcile(){
    if(!this.enabled)return {enabled:false,routes:[]};
    const state=await this.workspace.readGatewayConfiguration(),routes=[];
    for(const service of state.services.filter(s=>s.active))for(const mapping of service.mappings){
      const transport=await this.transport({serviceId:service.id,definitionId:mapping.definitionId,poolId:'',baseUrl:service.baseUrl,protocolPaths:service.protocolPaths,credentialRef:service.credentialRef,upstreamModel:mapping.upstreamModel,maxOutputTokens:1},true);
      routes.push({resourceId:resourceId({serviceId:service.id,definitionId:mapping.definitionId}),status:transport.kind==='higress'?'applied':'unavailable'});
    }
    return {enabled:true,routes};
  }
}
