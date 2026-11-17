import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {GatewaySyncRequest,RouteSnapshot} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from '../platform/workspace.repository';
import {GatewaySyncRepository} from './gateway-sync.repository';
import {HigressProvider} from './higress.provider';
import {binding,digest,resourceId,renderRoute} from './higress.resources';
import {saveUpstreamCredential} from '../platform/upstream-credentials';

describe('Higress publication authority',()=>{
  let provider:HigressProvider,repository:GatewaySyncRepository,workspace:WorkspaceRepository,route:RouteSnapshot,input:GatewaySyncRequest;
  let objects:Map<string,any>,writes:number;
  it('preserves versioned provider paths in generated Chat and native routes',()=>{
    const rendered=renderRoute({serviceId:'service',definitionId:'model',poolId:'pool',baseUrl:'https://ark.example/api/v3',upstreamModel:'physical',credentialRef:null},'v1','','proxy','test');
    const proxy=rendered.resources.find(r=>r.metadata.name==='atlas-ai-proxy')!;expect((proxy.spec.matchRules as any[])[0].config.providers[0].openaiCustomUrl).toBe('https://ark.example/api/v3/chat/completions');
    for(const protocol of ['responses','messages'])expect((rendered.resources.find(r=>r.kind==='Ingress'&&r.metadata.name===rendered.name+'-'+protocol)!.metadata.annotations as any)['higress.io/rewrite-target']).toBe('/api/v3/'+protocol);
  });
  beforeEach(async()=>{
    for(const [key,value] of Object.entries({PLATFORM_MODE:'development',GATEWAY_DATA_PLANE:'higress',HIGRESS_API_URL:'http://127.0.0.1:18001',HIGRESS_API_TOKEN:'separate-management-token',HIGRESS_PROXY_URL:'http://127.0.0.1:18002',UPSTREAM_HIGRESS_INTERNAL:'separate-proxy-token',HIGRESS_LOOPBACK_HOST:'',HIGRESS_REQUIRE_RUNTIME_READY:'false'}))vi.stubEnv(key,value);
    const store=new DemoStore();workspace=new WorkspaceRepository(store);repository=new GatewaySyncRepository(store);provider=new HigressProvider(repository,workspace);
    const state=await workspace.read(),service=state.services[0],mapping=service.mappings[0];
    route={serviceId:service.id,definitionId:mapping.definitionId,poolId:'test',baseUrl:service.baseUrl,upstreamModel:mapping.upstreamModel,credentialRef:service.credentialRef,maxOutputTokens:32};
    input={provider:'higress',resourceType:'model_route',resourceId:resourceId(route),desiredVersion:'v1',previousVersion:null,idempotencyKey:'first',spec:{serviceId:route.serviceId,definitionId:route.definitionId}};
    objects=new Map();writes=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
      const target=new URL(url);
      if(target.port==='18002'){
        const name=target.pathname.split('/')[2];return new Response(name,{status:200,headers:{'x-atlas-config-version':name}});
      }
      const key=target.pathname;
      if(!init?.method||init.method==='GET')return new Response(JSON.stringify(objects.get(key)??{}),{status:objects.has(key)?200:404});
      const object=JSON.parse(init.body as string);writes++;
      // The real bundled management API drops protobuf enum zero values.
      if(object.kind==='WasmPlugin'){delete object.spec.failStrategy;if(object.spec.phase==='UNSPECIFIED_PHASE')delete object.spec.phase;}
      objects.set(init.method==='PUT'?key:key+'/'+object.metadata.name,object);return new Response(JSON.stringify(object));
    }));
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
  it('rejects an unconfigured provider and unsupported resources explicitly',async()=>{
    vi.stubEnv('HIGRESS_API_URL','');expect((await provider.publishRoute(input)).errorCode).toBe('provider_unconfigured');
    expect((await provider.publishPolicyReference(input)).errorCode).toBe('unsupported_resource_type');expect(writes).toBe(0);
  });
  it('confirms, persists and replays configuration without publishing twice',async()=>{
    const first=await provider.publishRoute(input);expect(first.status).toBe('applied');const count=writes;
    expect(await provider.publishRoute(input)).toEqual(first);expect(writes).toBe(count);
    expect((await new HigressProvider(repository,workspace).getSyncStatus(input.resourceId))?.operationId).toBe(first.operationId);
    expect(JSON.stringify(await repository.read(input.resourceId))).not.toContain('separate-proxy-token');
  });
  it('retains an applied credential version after rotation publishes a newer version',async()=>{
    vi.stubEnv('PLATFORM_CREDENTIAL_ENCRYPTION_KEY',Buffer.alloc(32,13).toString('base64'));
    let credentialId='';
    await workspace.transact(async tx=>{
      const credential=saveUpstreamCredential(tx.state,{name:'local credential',providerId:'openai-compatible',secret:'credential-original'});
      credentialId=credential.id;tx.state.services[0].credentialId=credentialId;
    });
    const original={...route,credential:{id:credentialId,version:1}};
    const first=await provider.transport(original);expect(first.kind).toBe('higress');
    await workspace.transact(async tx=>{saveUpstreamCredential(tx.state,{id:credentialId,secret:'credential-rotated'});});
    const newer=await provider.transport({...route,credential:{id:credentialId,version:2}});
    expect(newer.kind).toBe('higress');expect(newer).not.toEqual(first);
    const writesBeforeReplay=writes;
    expect(await provider.transport(original)).toEqual(first);expect(writes).toBe(writesBeforeReplay);
    const state=JSON.stringify(await repository.read(resourceId(route)));
    expect(state).not.toContain('credential-original');expect(state).not.toContain('credential-rotated');
  });
  it('rejects changed idempotency input and stale version preconditions',async()=>{
    await provider.publishRoute(input);
    expect((await provider.publishRoute({...input,desiredVersion:'changed'})).errorCode).toBe('idempotency_conflict');
    expect((await provider.publishRoute({...input,idempotencyKey:'cas',previousVersion:'stale'})).errorCode).toBe('version_conflict');
  });
  it('rolls back using immutable resources after protobuf default fields were omitted',async()=>{
    await provider.publishRoute(input);
    expect((await provider.publishRoute({...input,desiredVersion:'v2',previousVersion:'v1',idempotencyKey:'second'})).status).toBe('applied');
    expect((await provider.publishRoute({...input,previousVersion:'v2',idempotencyKey:'rollback'})).status).toBe('applied');
    expect((await repository.active(input.resourceId))?.version).toBe('v1');
  });
  it('keeps version-specific provider rules in one shared AI proxy filter',async()=>{
    await provider.publishRoute(input);await provider.publishRoute({...input,desiredVersion:'v2',previousVersion:'v1',idempotencyKey:'v2'});
    const proxies=[...objects.values()].filter(value=>value.kind==='WasmPlugin'&&value.spec.url.includes('/ai-proxy/'));
    expect(proxies).toHaveLength(1);expect(proxies[0].spec.matchRules).toHaveLength(2);
    expect(new Set(proxies[0].spec.matchRules.map((rule:{ingress:string[]})=>rule.ingress[0])).size).toBe(2);
  });
  it('retains the working version if management publication fails',async()=>{
    await provider.publishRoute(input);vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('network unavailable');}));
    const failed=await provider.publishRoute({...input,desiredVersion:'v2',previousVersion:'v1',idempotencyKey:'failed'});
    expect(failed.status).toBe('rejected');expect(failed.appliedVersion).toBe('v1');expect((await repository.active(input.resourceId))?.version).toBe('v1');
  });
  it('serializes competing publications, including retries of a pending operation',async()=>{
    const original=global.fetch;let resume!:()=>void;const blocked=new Promise<void>(resolve=>resume=resolve);let started!:()=>void;const entering=new Promise<void>(resolve=>started=resolve);
    vi.stubGlobal('fetch',vi.fn(async(...args:Parameters<typeof fetch>)=>{started();await blocked;return original(...args);}));
    const first=provider.publishRoute(input);await entering;
    const replay=await provider.publishRoute(input);expect(replay.status).toBe('pending');
    expect((await provider.publishRoute({...input,idempotencyKey:'competing',desiredVersion:'v2'})).errorCode).toBe('publication_in_progress');resume();
    expect((await first).operationId).toBe(replay.operationId);
  });
  it('recovers expired publication leases without declaring them applied',async()=>{
    await repository.change(input.resourceId,state=>{state.operations[digest('interrupted')]={fingerprint:'x',binding:'x',leaseUntil:Date.now()-1,response:{provider:'higress',resourceId:input.resourceId,desiredVersion:'v0',appliedVersion:null,status:'pending',operationId:'interrupted',errorCode:null}};state.latest=state.operations[digest('interrupted')].response;});
    expect((await provider.getSyncStatus(input.resourceId))?.errorCode).toBe('publication_interrupted');
    expect((await provider.publishRoute(input)).status).toBe('applied');
  });
  it('does not dispatch a stale binding after the controlled credential changes',async()=>{
    await provider.publishRoute(input);const bound=binding(route,'');expect((await repository.active(input.resourceId))?.binding).toBe(bound);
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
    expect(await provider.transport({...route,upstreamModel:'different-model'})).toEqual({kind:'unavailable'});
  });
  it('accepts arbitrary idempotency strings without mutating object prototypes',async()=>{
    const result=await provider.publishRoute({...input,idempotencyKey:'__proto__'});expect(result.status).toBe('applied');
    expect(Object.getPrototypeOf((await repository.read(input.resourceId)).operations)).toBe(Object.prototype);
  });
  it('fences a stale publisher after its lease was superseded',async()=>{
    const original=global.fetch;let release!:()=>void,entered!:()=>void,first=true;const blocked=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    vi.stubGlobal('fetch',vi.fn(async(...args:Parameters<typeof fetch>)=>{if(first){first=false;entered();await blocked;}return original(...args);}));
    const stale=provider.publishRoute(input);await started;
    await repository.change(input.resourceId,state=>{state.operations[digest(input.idempotencyKey)].leaseUntil=Date.now()-1;});
    expect((await provider.getSyncStatus(input.resourceId))?.errorCode).toBe('publication_interrupted');
    const fresh=await provider.publishRoute({...input,idempotencyKey:'replacement',desiredVersion:'v2'});expect(fresh.status).toBe('applied');release();
    const obsolete=await stale;expect(obsolete.errorCode).toBe('publication_interrupted');expect(obsolete.operationId).toBe((await repository.read(input.resourceId)).operations[digest(input.idempotencyKey)].response.operationId);expect((await repository.active(input.resourceId))?.version).toBe('v2');
  });
  it('requires explicit runtime readiness when enabled',async()=>{
    vi.stubEnv('HIGRESS_REQUIRE_RUNTIME_READY','true');const original=global.fetch;let observations=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{if(String(url).includes('/runtime/ready/')){observations++;return new Response(JSON.stringify({ready:observations>1}));}return original(url,init);}));
    expect((await provider.publishRoute(input)).status).toBe('applied');expect(observations).toBe(2);
  });
});
