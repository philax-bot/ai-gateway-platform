import { beforeEach, describe, expect, it } from 'vitest';
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
  function payload(state:WorkspaceState,baseUrl:string){
    const service=state.services[0];
    return {id:service.id,name:service.name,providerId:service.providerId??'openai-compatible',baseUrl,limits:service.limits,
      mappings:service.mappings.map(mapping=>({definitionId:mapping.definitionId,upstreamModel:mapping.upstreamModel,inputPrice:mapping.inputPrice,outputPrice:mapping.outputPrice,cachedInputPrice:mapping.cachedInputPrice,costPrice:mapping.costPrice,limits:mapping.limits}))};
  }
  async function preview(baseUrl:string){
    const body=payload(await repository.read(),baseUrl);
    return platform.preview(operator,{type:'save.service',payload:body,idempotencyKey:crypto.randomUUID()} as PlatformCommand);
  }

  it('surfaces the new destination and the credential that travels with it',async()=>{
    const impact=(await preview('http://127.0.0.1:4020')).impact as {endpointChange?:{before:string;after:string;requires:string;sendsCredential:string}};
    expect(impact.endpointChange).toMatchObject({before:'http://127.0.0.1:4010',after:'http://127.0.0.1:4020',requires:'credentials.write'});
    expect(impact.endpointChange!.sendsCredential).toContain('新地址');
  });

  it('records one dedicated audit event per endpoint move and none for an unchanged endpoint',async()=>{
    const move=await preview('http://127.0.0.1:4020'),c:PlatformCommand={type:'save.service',payload:payload(await repository.read(),'http://127.0.0.1:4020'),idempotencyKey:crypto.randomUUID(),previewToken:move.previewToken};
    await platform.execute(operator,c);
    const moved=(await repository.read()).audit.filter(entry=>entry.action==='service.endpoint_changed');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({actorId:operator,objectId:'service-local-test',detail:{before:'http://127.0.0.1:4010',after:'http://127.0.0.1:4020',verification:'unverified'}});
    expect((await preview('http://127.0.0.1:4020')).impact).not.toHaveProperty('endpointChange');
    const again=await preview('http://127.0.0.1:4020');
    await platform.execute(operator,{type:'save.service',payload:payload(await repository.read(),'http://127.0.0.1:4020'),idempotencyKey:crypto.randomUUID(),previewToken:again.previewToken});
    expect((await repository.read()).audit.filter(entry=>entry.action==='service.endpoint_changed')).toHaveLength(1);
  });
});
