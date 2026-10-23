import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {PlatformCommand,RetentionReport} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {PlatformService} from './platform.service';
import {MaintenanceService} from './maintenance.service';
import {prepareRetention} from './retention';

const operator='operator-demo-001',employee='employee-demo-001';
describe('bounded retention of auxiliary records',()=>{
  let repository:WorkspaceRepository,platform:PlatformService,store:DemoStore;
  const input=(type:string,payload:Record<string,unknown>):PlatformCommand=>({type,payload,idempotencyKey:crypto.randomUUID()});
  async function execute(c:PlatformCommand,actor=operator){const preview=await platform.preview(actor,c);return platform.execute(actor,{...c,previewToken:preview.previewToken});}
  const cleanup=(report:RetentionReport)=>input('retention.run',{checkedAt:report.checkedAt,fingerprint:report.fingerprint,reason:'清理过期运行记录'});
  beforeEach(async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-20T01:00:00Z'));
    store=new DemoStore();repository=new WorkspaceRepository(store);await repository.initialize();platform=new PlatformService(repository,store);
    const old=new Date(Date.now()-200*86400000).toISOString(),recent=new Date(Date.now()-86400000).toISOString();
    await repository.transact(async tx=>{
      const s=tx.state;
      const event=(id:string,status='recovered')=>({id,status,openedAt:old,updatedAt:old,recoveredAt:status==='recovered'?old:null,acknowledgedAt:null,acknowledgedBy:null});
      s.monitoring={rules:[],evaluations:{},events:[event('closed'),event('closed-unread'),event('active','active')] as any,collectionEvents:[event('collection-closed')] as any};
      s.approvals.push({id:'approval-pending',status:'pending'} as any);
      s.notifications=[
        {id:'ordinary',objectType:'entitlement',objectId:'entitlement',readAt:old},
        {id:'closed-note',objectType:'alert',objectId:'closed',readAt:old},
        {id:'unread',objectType:'alert',objectId:'closed-unread',readAt:null},
        {id:'read-recently',objectType:'entitlement',objectId:'entitlement',readAt:recent},
        {id:'pending-note',objectType:'approval',objectId:'approval-pending',readAt:old},
        {id:'active-note',objectType:'alert',objectId:'active',readAt:old},
      ].map(n=>({...n,recipientId:employee,title:n.id,body:'private-notification-body',createdAt:old}));
      s.sessions=[{tokenHash:'expired-session-secret-hash',memberId:employee,createdAt:old,expiresAt:old},{tokenHash:'current-session-secret-hash',memberId:operator,createdAt:recent,expiresAt:new Date(Date.now()+3600000).toISOString()}];
      s.operations['business-idempotency']={fingerprint:'business-fingerprint',result:{amount:7}};
    });
    store.callLogs.push({requestId:'old-accounting-call',billableState:'pending_review',startedAt:old,completedAt:old} as any);
  });
  afterEach(()=>vi.useRealTimers());
  it('previews counts without exposing another user notice or authentication hashes, and keeps linked open work',async()=>{
    const report=await platform.retentionReport(operator);
    expect(report.eligible).toEqual({notifications:2,alerts:1,collectionAlerts:1,sessions:1});
    expect(report.protected).toEqual({unreadNotifications:1,unfinishedNotifications:2,activeAlerts:1,activeSessions:1});
    expect(JSON.stringify(report)).not.toContain('private-notification-body');expect(JSON.stringify(report)).not.toContain('secret-hash');
    const before=await repository.read();await platform.preview(operator,cleanup(report));expect(await repository.read()).toEqual(before);
  });
  it('removes exactly eligible records, preserves funds/calls/idempotency and keeps the manual result across retries',async()=>{
    const report=await platform.retentionReport(operator),c=cleanup(report),funds=structuredClone([...store.quotaBatches]),calls=structuredClone(store.callLogs);
    const result=await execute(c) as any,s=await repository.read();
    expect(result.result.removed).toEqual(report.eligible);expect(s.notifications.map(n=>n.id)).toEqual(['unread','read-recently','pending-note','active-note']);
    expect(s.monitoring!.events.map(e=>e.id)).toEqual(['closed-unread','active']);expect(s.monitoring!.collectionEvents).toEqual([]);
    expect(s.sessions.map(s=>s.tokenHash)).toEqual(['current-session-secret-hash']);expect([...store.quotaBatches]).toEqual(funds);expect(store.callLogs).toEqual(calls);
    expect(s.operations['business-idempotency'].result).toEqual({amount:7});expect(s.approvals.some(a=>a.id==='approval-pending')).toBe(true);
    expect((await platform.execute(operator,c)).replayed).toBe(true);expect((await repository.read()).audit.filter(a=>a.action==='retention.run')).toHaveLength(1);
    expect((await platform.retentionReport(operator)).lastRun?.id).toBe(result.result.id);
  });
  it('rejects employee access, unsigned execution and a plan changed without a business revision',async()=>{
    const report=await platform.retentionReport(operator),c=cleanup(report),preview=await platform.preview(operator,c);
    await expect(platform.retentionReport(employee)).rejects.toMatchObject({status:403});await expect(platform.preview(employee,c)).rejects.toMatchObject({status:403});
    await expect(platform.execute(operator,c)).rejects.toMatchObject({status:409});
    await repository.transact(async tx=>{tx.state.notifications=tx.state.notifications.filter(n=>n.id!=='ordinary');},{incrementRevision:false});
    await expect(platform.execute(operator,{...c,previewToken:preview.previewToken})).rejects.toMatchObject({status:409});
    expect((await repository.read()).notifications.some(n=>n.id==='closed-note')).toBe(true);
  });
  it('validates policy changes, requires confirmation and saves a manual policy without cleaning data',async()=>{
    for(const days of [0,1.5,3651,'90'])await expect(platform.preview(operator,input('settings.retention',{days,automatic:false,reason:'核对'}))).rejects.toMatchObject({status:400});
    await expect(execute(input('settings.retention',{days:1,automatic:'yes',reason:'核对'}))).rejects.toMatchObject({status:400});
    const c=input('settings.retention',{days:1,automatic:false,reason:'按需保留'});await expect(platform.execute(operator,c)).rejects.toMatchObject({status:409});await execute(c);
    const s=await repository.read();expect(s.settings).toMatchObject({retentionDays:1,retentionAutomatic:false});expect(s.notifications).toHaveLength(6);expect(s.retention).toBeUndefined();
    await expect(execute(input('settings.update',{retentionDays:1}))).rejects.toMatchObject({status:400});
  });
  it('runs through background maintenance only when enabled, once per Shanghai day, without invalidating business drafts',async()=>{
    const maintenance=new MaintenanceService(repository,store);await maintenance.run();expect((await repository.read()).retention).toBeUndefined();
    await execute(input('settings.retention',{days:90,automatic:true,reason:'开启每日辅助记录清理'}));const revision=(await repository.read()).revision;
    await maintenance.run();const first=await repository.read();expect(first.retention?.lastRun.source).toBe('automatic');expect(first.retention?.lastRun.removed.notifications).toBe(2);expect(first.revision).toBe(revision);
    await maintenance.run();expect((await repository.read()).retention?.lastRun.id).toBe(first.retention?.lastRun.id);
    vi.setSystemTime(new Date('2026-10-20T16:01:00Z'));await maintenance.run();const next=await repository.read();expect(next.retention?.lastRun.id).not.toBe(first.retention?.lastRun.id);expect(next.audit.filter(a=>a.action==='retention.run')).toHaveLength(2);
    expect(prepareRetention(next).report.eligible.notifications).toBe(0);expect(store.callLogs[0].requestId).toBe('old-accounting-call');
  });
});
