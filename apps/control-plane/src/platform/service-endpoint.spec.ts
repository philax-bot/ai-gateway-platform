import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCommand, WorkspaceState } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { PlatformService } from './platform.service';

const operator='operator-demo-001';
describe('service endpoint changes are a credential operation',()=>{
  let ledger:DemoStore,repository:WorkspaceRepository,platform:PlatformService;
  beforeEach(async()=>{
    ledger=new DemoStore();repository=new WorkspaceRepository(ledger);await repository.initialize();
    platform=new PlatformService(repository,ledger);
  });
  afterEach(()=>vi.unstubAllEnvs());
  function payload(state:WorkspaceState,baseUrl:string){
    const service=state.services[0];
    return {id:service.id,name:service.name,providerId:service.providerId??'openai-compatible',baseUrl,limits:service.limits,
      mappings:service.mappings.map(mapping=>({definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel,inputPrice:mapping.inputPrice,outputPrice:mapping.outputPrice,cachedInputPrice:mapping.cachedInputPrice,costPrice:mapping.costPrice,limits:mapping.limits}))};
  }
  async function prepare(baseUrl:string, binding:Record<string,unknown>={}){
    const command:PlatformCommand={type:'save.service',payload:{...payload(await repository.read(),baseUrl),...binding},idempotencyKey:crypto.randomUUID()};
    const preview=await platform.preview(operator,command);
    return {preview,execute:()=>platform.execute(operator,{...command,previewToken:preview.previewToken})};
  }

  it('surfaces the new destination and the credential that travels with it',async()=>{
    const credentialRef='UPSTREAM_ENDPOINT_SPEC';
    const move=await prepare('http://127.0.0.1:4020',{credentialRef});
    const impact=move.preview.impact as {endpointChange?:{before:string;after:string;requires:string;sendsCredential:string}};
    expect(impact.endpointChange).toMatchObject({before:'http://127.0.0.1:4010',after:'http://127.0.0.1:4020',requires:'credentials.write'});
    expect(impact.endpointChange!.sendsCredential).toContain(credentialRef);
    await move.execute();
    expect((await repository.read()).services[0]).toMatchObject({credentialRef,verification:'unverified'});
    const audit=await platform.queryAudit(operator,{action:'service.endpoint_changed'});
    expect(audit.items[0].summary).toEqual(expect.arrayContaining([
      {label:'原上游地址',value:'http://127.0.0.1:4010'},
      {label:'新上游地址',value:'http://127.0.0.1:4020'},
      {label:'变更后凭据',value:'环境变量 '+credentialRef},
    ]));

    const unbind=await prepare('http://127.0.0.1:4030',{credentialRef:null,credentialId:null});
    expect(unbind.preview.impact.endpointChange).toMatchObject({credential:null});
    await unbind.execute();
    expect((await repository.read()).services[0]).toMatchObject({credentialRef:null,credentialId:null});
    const updated=await platform.queryAudit(operator,{action:'service.endpoint_changed',search:'4030'});
    expect(updated.items[0].reason).toContain('未绑定');
  });

  it('previews and audits inline credentials without exposing their value',async()=>{
    vi.stubEnv('PLATFORM_CREDENTIAL_ENCRYPTION_KEY',Buffer.alloc(32,11).toString('base64'));
    const credentialSecret='local-fixture-key-for-endpoint-spec';
    const move=await prepare('http://127.0.0.1:4020',{credentialSecret});
    expect(move.preview.impact.endpointChange).toMatchObject({credential:'服务内密钥 · v1'});
    expect(JSON.stringify(move.preview)).not.toContain(credentialSecret);
    await move.execute();
    const audit=await platform.queryAudit(operator,{action:'service.endpoint_changed'});
    expect(audit.items[0].summary).toContainEqual({label:'变更后凭据',value:'服务内密钥 · v1'});
    expect(JSON.stringify(audit)).not.toContain(credentialSecret);
  });

  it('records one dedicated audit event per endpoint move and none for an unchanged endpoint',async()=>{
    const move=await prepare('http://127.0.0.1:4020');
    await move.execute();
    expect((await move.execute()).replayed).toBe(true);
    const moved=(await repository.read()).audit.filter(entry=>entry.action==='service.endpoint_changed');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({actorId:operator,objectId:'service-local-test',detail:{before:'http://127.0.0.1:4010',after:'http://127.0.0.1:4020',verification:'unverified'}});
    const again=await prepare('http://127.0.0.1:4020/');
    expect(again.preview.impact).not.toHaveProperty('endpointChange');
    await again.execute();
    expect((await repository.read()).audit.filter(entry=>entry.action==='service.endpoint_changed')).toHaveLength(1);
  });
});
