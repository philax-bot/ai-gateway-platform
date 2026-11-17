import {beforeEach,describe,expect,it} from 'vitest';
import type {PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';

const operator='operator-demo-001',employee='employee-demo-001',range={poolId:'pool-local-test',mode:'follow',definitionIds:[]};
describe('command retries respect current responsibility without repeating business effects',()=>{
  let repository:WorkspaceRepository,platform:PlatformService,next:any;
  const input=(type:string,payload:Record<string,unknown>):PlatformCommand=>({type,payload,idempotencyKey:crypto.randomUUID()});
  async function execute(command:PlatformCommand,actor=operator){const preview=await platform.preview(actor,command);return platform.execute(actor,{...command,previewToken:preview.previewToken});}
  async function save(type:string,payload:Record<string,unknown>,actor=operator){return (await execute(input(type,payload),actor)).result as any;}
  beforeEach(async()=>{const store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();platform=new PlatformService(repository,store);await repository.transact(async tx=>{tx.state.services[0].verification='passed';tx.state.pools[0].entries[0].open=true;});next=await save('save.member',{directoryId:'responsibility-next',name:'新责任人',organizationId:'org-demo'});});
  async function app(){return save('save.application',{initialAmount:1,validity:'permanent',billingMode:'quota',name:'交接应用',ownerId:employee,organizationId:'org-demo',range});}
  async function project(){return save('save.project',{initialAmount:1,validity:'permanent',name:'交接项目',managerId:employee,range});}

  it('does not return an old application key response after ownership moves',async()=>{
    const application=await app(),issue=input('key.issue',{name:'旧负责人接入',purpose:'application',applicationId:application.id});await execute(issue,employee);
    await save('save.application',{...application,ownerId:next.id});await expect(platform.applicationDetail(employee,application.id)).rejects.toMatchObject({status:403});
    await expect(platform.execute(employee,issue)).rejects.toMatchObject({status:403});
  });
  it('does not return a former manager own-command result after manager reassignment',async()=>{
    const p=await project(),change=input('project.members',{projectId:p.id,memberIds:[next.id]});await execute(change,employee);
    await save('save.project',{...p,managerId:next.id});await expect(platform.execute(employee,change)).rejects.toMatchObject({status:403});
  });
  it('rejects an operator-only retry after the operator role is removed',async()=>{
    const application=await app(),fund=input('application.fund',{applicationId:application.id,amount:5,expiresAt:new Date(Date.now()+86400000).toISOString()});await execute(fund);
    await save('save.member',{...next,roles:['operator','employee']});const actor=(await repository.read()).members.find(m=>m.id===operator)!;await save('save.member',{...actor,roles:['employee']},next.id);
    await expect(platform.execute(operator,fund)).rejects.toMatchObject({status:403});expect((await platform.applicationDetail(next.id,application.id)).availableAmount).toBe(6);
  });
  it('does not replay approval decisions after responsibility changes',async()=>{
    const p=await project();await save('project.members',{projectId:p.id,memberIds:[next.id]});
    const approval=await save('approval.submit',{kind:'project_member_quota',objectId:p.id,amount:1,expiresAt:new Date(Date.now()+86400000).toISOString(),scenario:'项目工作',reason:'项目工作'},next.id);
    const decide=input('approval.decide',{id:approval.id,decision:'approve',reason:'按需批准'});await execute(decide,employee);
    await save('save.project',{...p,managerId:next.id});await expect(platform.execute(employee,decide)).rejects.toMatchObject({status:403});
  });
  it('checks permissions before previewing operator-only or unknown commands',async()=>{
    for(const type of ['save.plan','save.definition','save.alert-rule','settings.update','periodic.run'])await expect(platform.preview(employee,input(type,{name:'不应预览'}))).rejects.toMatchObject({status:403});
    await expect(platform.preview(operator,input('unknown.command',{}))).rejects.toMatchObject({status:400});
  });
  it('retains valid idempotency across revision changes and never reveals the issued secret again',async()=>{
    const application=await app(),issue=input('key.issue',{name:'合法重试',purpose:'application',applicationId:application.id});const first=await execute(issue,employee) as any;
    await save('application.fund',{applicationId:application.id,amount:5,expiresAt:new Date(Date.now()+86400000).toISOString()});const replay=await platform.execute(employee,issue) as any;
    expect(replay.replayed).toBe(true);expect(replay.result.secret).toBeUndefined();expect(replay.result.key.id).toBe(first.result.key.id);expect((await platform.applicationDetail(employee,application.id)).keys).toHaveLength(1);
  });
});
