import {beforeEach,describe,expect,it} from 'vitest';
import type {AuditEntry,AuditQuery,PlatformCommand} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';
import {auditObjectId,describeAudit,queryAudit} from './audit-query';

const operator='operator-demo-001',employee='employee-demo-001',at='2020-01-01T00:00:00.000Z';
describe('complete, scoped and readable operation audit',()=>{
  let repository:WorkspaceRepository,platform:PlatformService;
  const entry=(i:number):AuditEntry=>({id:`audit-fixture-${String(i).padStart(4,'0')}`,actorId:operator,action:'save.application',objectId:null,reason:`historical reason ${i}`,createdAt:at,detail:{id:`application-history-${i}`,name:`历史应用 ${i}`}});
  beforeEach(async()=>{const store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();platform=new PlatformService(repository,store);});
  it('reads beyond the 500-entry snapshot and paginates equal timestamps once, excluding appended records until refresh',async()=>{
    await repository.transact(async tx=>{tx.state.audit=Array.from({length:615},(_,i)=>entry(i));});
    expect((await platform.snapshot(operator)).audit).toHaveLength(500);
    let page=await platform.queryAudit(operator,{limit:100}),ids=page.items.map(e=>e.id);expect(page.total).toBe(615);
    await repository.transact(async tx=>{tx.state.audit.push({...entry(999),createdAt:'2019-01-01T00:00:00.000Z'});});
    while(page.nextCursor){page=await platform.queryAudit(operator,{limit:100,cursor:page.nextCursor});ids.push(...page.items.map(e=>e.id));expect(page.total).toBe(615);}
    expect(ids).toHaveLength(615);expect(new Set(ids).size).toBe(615);expect(ids).toContain('audit-fixture-0000');expect(ids).not.toContain('audit-fixture-0999');expect((await platform.queryAudit(operator,{})).total).toBe(616);
  });
  it('filters all retained history by Chinese action/object text, actor and an inclusive/exclusive time range',async()=>{
    const s=await repository.read();s.audit=[entry(0),{...entry(1),actorId:employee,action:'key.status',createdAt:'2020-01-02T00:00:00.000Z',detail:{name:'编辑器接入'}}];
    expect(queryAudit(s,{search:'保存应用'}).items[0].objectName).toBe('历史应用 0');
    expect(queryAudit(s,{search:'编辑器接入',actorId:employee,action:'key.status',from:'2020-01-02T00:00:00Z',to:'2020-01-03T00:00:00Z'}).total).toBe(1);
    expect(queryAudit(s,{to:'2020-01-02T00:00:00Z'}).total).toBe(1);expect(queryAudit(s,{search:'无此对象'}).total).toBe(0);
    s.audit.push({...entry(2),createdAt:'2020-01-02T08:00:00+08:00'});expect(queryAudit(s,{from:'2020-01-02T00:00:00Z',to:'2020-01-03T00:00:00Z'}).total).toBe(2);
    const before=structuredClone(s);queryAudit(s,{});expect(s).toEqual(before);
  });
  it('binds cursors to the applied filters and validates malformed queries',async()=>{
    const s=await repository.read();s.audit=[entry(0),entry(1)];const page=queryAudit(s,{limit:1});
    expect(()=>queryAudit(s,{limit:1,search:'changed',cursor:page.nextCursor!})).toThrow('cursor');
    for(const query of [null,[],{limit:0},{limit:101},{limit:'20'},{search:7},{search:'x'.repeat(201)},{from:'2020-01-01'},{from:at,to:at},{cursor:'not-json'}])expect(()=>queryAudit(s,query as AuditQuery)).toThrow();
  });
  it('returns curated metadata and masked keys, never arbitrary credential or body fields',async()=>{
    const s=await repository.read(),record={...entry(0),action:'key.issue',detail:{key:{id:'key-real',name:'工具接入',masked:'sa_123…7890',status:'active',keyHash:'private-hash'},secret:'private-secret',password:'private-password',body:'private-body',nested:{token:'private-token'}}};
    const view=describeAudit(s,record),serialized=JSON.stringify(view);expect(view).toMatchObject({objectId:'key-real',objectName:'工具接入',actionName:'签发密钥'});
    for(const value of ['private-hash','private-secret','private-password','private-body','private-token'])expect(serialized).not.toContain(value);
    const c:PlatformCommand={type:'key.issue',payload:{applicationId:'application-real',projectId:'irrelevant',id:'irrelevant'},idempotencyKey:'test-key-issue'};expect(auditObjectId(c,record.detail)).toBe('key-real');
    s.audit=[{...entry(1),action:'keys.status',detail:{keys:[{name:'目标工具甲',masked:'sa_123…7890',before:'active',after:'disabled',changed:true}],changedCount:1,skippedCount:0}}];expect(queryAudit(s,{search:'目标工具甲'}).total).toBe(1);
  });
  it('requires the current operator role and keeps names captured at execution after people and objects are renamed',async()=>{
    await expect(platform.queryAudit(employee,{})).rejects.toMatchObject({status:403});
    const command=async(type:string,payload:Record<string,unknown>)=>{const c={type,payload,idempotencyKey:crypto.randomUUID()},preview=await platform.preview(operator,c);return (await platform.execute(operator,{...c,previewToken:preview.previewToken})).result as any;};
    const initial=await repository.read(),actor=initial.members.find(m=>m.id===operator)!;
    const app=await command('save.application',{name:'调整前应用',ownerId:employee,organizationId:'org-demo',range:{poolId:'pool-local-test',mode:'follow',definitionIds:[]}});
    await command('save.member',{...actor,name:'更名后的运营'});await command('save.application',{...app,name:'调整后应用'});
    const records=(await platform.queryAudit(operator,{action:'save.application'})).items;
    expect(records.some(e=>e.objectName==='调整前应用'&&e.actorName===actor.name&&e.objectId===app.id&&e.objectNameSource==='recorded')).toBe(true);
    expect(records.some(e=>e.objectName==='调整后应用'&&e.actorName==='更名后的运营')).toBe(true);
    await repository.transact(async tx=>{tx.state.members.find(m=>m.id===operator)!.roles=['employee'];});await expect(platform.queryAudit(operator,{})).rejects.toMatchObject({status:403});
  });
  it('requires a current settings confirmation before creating the audit of a configuration change',async()=>{
    const command={type:'settings.update',payload:{name:'已核对的工作区'},idempotencyKey:crypto.randomUUID()};
    await expect(platform.preview(operator,{...command,payload:{name:'   '}})).rejects.toMatchObject({status:400});
    await expect(platform.preview(operator,{...command,payload:{personalDefaultPoolId:'missing-pool'}})).rejects.toMatchObject({status:404});
    await expect(platform.execute(operator,command)).rejects.toMatchObject({status:409});const preview=await platform.preview(operator,command);
    await repository.transact(async tx=>{tx.state.settings.name='其他运营刚保存的名称';});
    await expect(platform.execute(operator,{...command,previewToken:preview.previewToken})).rejects.toMatchObject({status:409});expect((await repository.read()).settings.name).toBe('其他运营刚保存的名称');
    const current=await platform.preview(operator,command);expect(current.impact.settingsChanges).toEqual([{label:'企业显示名称',before:'其他运营刚保存的名称',after:'已核对的工作区'}]);await platform.execute(operator,{...command,previewToken:current.previewToken});expect((await platform.queryAudit(operator,{action:'settings.update'})).items[0].objectName).toBe('已核对的工作区');
  });
});
