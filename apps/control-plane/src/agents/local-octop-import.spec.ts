import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from '../platform/workspace.repository';
import {PlatformService} from '../platform/platform.service';
import {AuthService} from '../platform/auth.service';
import {hash,passwordHash} from '../platform/validation';
import {LocalOctopImportService} from './local-octop-import.service';

const employee='employee-demo-001',operator='operator-demo-001';
describe('local Octop import handoff',()=>{
  let service:LocalOctopImportService,repository:WorkspaceRepository,platform:PlatformService,auth:AuthService,token:string,issued:any,previous:string|undefined;
  beforeEach(async()=>{
    previous=process.env.PUBLIC_GATEWAY_URL;process.env.PUBLIC_GATEWAY_URL='https://gateway.example.com';
    const store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();platform=new PlatformService(repository,store);auth=new AuthService(repository);service=new LocalOctopImportService(repository,platform);
    await repository.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;tx.state.members.find(m=>m.id===employee)!.passwordHash=passwordHash('QaPassword1!');});
    async function command(actor:string,type:string,payload:Record<string,unknown>){const c={type,payload,idempotencyKey:crypto.randomUUID()},p=await platform.preview(actor,c);return (await platform.execute(actor,{...c,previewToken:p.previewToken})).result as any;}
    const plan=await command(operator,'save.plan',{name:'local Octop',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]},amount:1,cadence:'once',quotaDays:1,entitlementDays:1});await command(operator,'distribution.execute',{planId:plan.id,memberIds:[employee]});
    issued=await command(employee,'key.issue',{name:'Octop local',purpose:'personal'});const member=(await repository.read()).members.find(m=>m.id===employee)!;token=(await auth.login({directoryId:member.directoryId,password:'QaPassword1!'},'127.0.0.1')).token;
  });
  afterEach(()=>{service.onModuleDestroy();vi.useRealTimers();if(previous===undefined)delete process.env.PUBLIC_GATEWAY_URL;else process.env.PUBLIC_GATEWAY_URL=previous;});
  const create=()=>service.create(employee,token,{keyId:issued.key.id,apiKey:issued.secret});
  const ticket=(url:string)=>new URL(url).searchParams.get('ticket')!;
  it('hands off the existing key once without putting it in URLs or persisted state',async()=>{
    const link=await create();expect(link.url).not.toContain(issued.secret);const claim=await service.claim({ticket:ticket(link.url)});expect(claim.config).toMatchObject({apiKey:issued.secret,baseUrl:'https://gateway.example.com/v1'});expect(claim.config!.models[0]).toMatchObject({api_mode:'chat_completions',api_fallback:'none'});expect((await repository.read()).keys).toHaveLength(1);expect(JSON.stringify(await repository.read())).not.toContain(issued.secret);await expect(service.claim({ticket:ticket(link.url)})).rejects.toThrow('already used');
    service.complete({id:claim.id,receipt:claim.receipt,status:'completed'});expect(service.status(employee,link.id).status).toBe('completed');expect(()=>service.complete({id:claim.id,receipt:claim.receipt,status:'failed'})).toThrow();
  });
  it('refuses mismatched secrets, foreign owners and caller-supplied endpoints',async()=>{
    await expect(service.create(employee,token,{keyId:issued.key.id,apiKey:'wrong'})).rejects.toThrow('does not match');
    await expect(service.create(employee,token,{keyId:'foreign',apiKey:issued.secret})).rejects.toThrow('not found');
    await expect(service.create(employee,token,{keyId:issued.key.id,apiKey:issued.secret,baseUrl:'https://evil.example'})).rejects.toThrow('invalid');
  });
  it('binds status to its owner and rejects forged completion receipts',async()=>{
    const link=await create();expect(()=>service.status(operator,link.id)).toThrow('not found');const claim=await service.claim({ticket:ticket(link.url)});expect(()=>service.complete({id:link.id,receipt:'wrong',status:'completed'})).toThrow();expect(service.status(employee,link.id).status).toBe('claimed');service.complete({id:link.id,receipt:claim.receipt,status:'failed'});expect(service.status(employee,link.id).status).toBe('failed');
  });
  it('rechecks logout, key revocation and member suspension before releasing secrets',async()=>{
    const link=await create();await auth.logout(token);await expect(service.claim({ticket:ticket(link.url)})).rejects.toThrow('access changed');expect(service.status(employee,link.id).status).toBe('failed');
  });
  it('never releases a key revoked after ticket creation',async()=>{
    const link=await create();await repository.transact(async tx=>{tx.state.keys[0].status='revoked';});await expect(service.claim({ticket:ticket(link.url)})).rejects.toThrow('access changed');
  });
  it('does not release imports for a disabled member',async()=>{
    const link=await create();await repository.transact(async tx=>{tx.state.members.find(m=>m.id===employee)!.active=false;});await expect(service.claim({ticket:ticket(link.url)})).rejects.toThrow('access changed');
  });
  it('expires and destroys in-memory secrets after five minutes',async()=>{
    vi.useFakeTimers();const link=await create();await vi.advanceTimersByTimeAsync(300001);await expect(service.claim({ticket:ticket(link.url)})).rejects.toThrow('expired');expect(()=>service.status(employee,link.id)).toThrow('not found');
  });
  it('invalidates an older pending link when a new import is requested',async()=>{
    const first=await create(),next=await create();await expect(service.claim({ticket:ticket(first.url)})).rejects.toThrow();expect((await service.claim({ticket:ticket(next.url)})).config!.keyId).toBe(issued.key.id);
  });
  it('allows only one concurrent claim',async()=>{
    const link=await create(),claims=await Promise.allSettled([service.claim({ticket:ticket(link.url)}),service.claim({ticket:ticket(link.url)})]);expect(claims.filter(c=>c.status==='fulfilled')).toHaveLength(1);
  });
  it('refuses unsafe gateway configuration and clears all tickets on shutdown',async()=>{
    process.env.PUBLIC_GATEWAY_URL='http://remote.example.com';await expect(create()).rejects.toThrow('HTTPS');process.env.PUBLIC_GATEWAY_URL='https://gateway.example.com/v1';const link=await create();service.onModuleDestroy();await expect(service.claim({ticket:ticket(link.url)})).rejects.toThrow('expired');
  });
});
