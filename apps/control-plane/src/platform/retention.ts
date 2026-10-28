import {BadRequestException,ConflictException} from '@nestjs/common';
import type {RetentionReport,RetentionRun,WorkspaceState} from '@ai-gateway/contracts';
import {hash,text} from './validation';
import {newId} from './domain';

const day=86400000;
const before=(value:string|null|undefined,limit:number)=>!!value&&Number.isFinite(Date.parse(value))&&Date.parse(value)<limit;
export function retentionPolicy(payload:Record<string,unknown>){
  const days=payload.days;
  if(typeof days!=='number'||!Number.isInteger(days)||days<1||days>3650)throw new BadRequestException('retention days must be an integer from 1 to 3650');
  if(typeof payload.automatic!=='boolean')throw new BadRequestException('retention automatic must be a boolean');
  return {days,automatic:payload.automatic,reason:text(payload.reason,'reason',2000)};
}

/** Only auxiliary records expire. Calls, ledgers, idempotency and business audit
 * remain intact: current accounting and recovery still use those records. */
export function prepareRetention(state:WorkspaceState,checkedAt=new Date().toISOString()){
  const at=Date.parse(checkedAt);
  if(!Number.isFinite(at)||at>Date.now())throw new BadRequestException('invalid retention check time');
  const days=state.settings.retentionDays,cutoff=at-days*day;
  if(!Number.isInteger(days)||days<1||days>3650)throw new ConflictException('retention policy is invalid; configure it before cleanup');
  const events=[...(state.monitoring?.events??[]),...(state.monitoring?.collectionEvents??[])];
  function finished(type:string,id:string){
    if(type==='approval')return ['effective','rejected','withdrawn'].includes(state.approvals.find(a=>a.id===id)?.status??'');
    if(type==='alert')return events.some(e=>e.id===id&&e.status==='recovered');
    return true;
  }
  const notifications=state.notifications.filter(n=>before(n.createdAt,cutoff)&&before(n.readAt,cutoff)&&finished(n.objectType,n.objectId));
  const notificationIds=new Set(notifications.map(n=>n.id));
  const referencedEvents=new Set(state.notifications.filter(n=>n.objectType==='alert'&&!notificationIds.has(n.id)).map(n=>n.objectId));
  const removable=(e:typeof events[number])=>e.status==='recovered'&&before(e.recoveredAt,cutoff)&&before(e.updatedAt,cutoff)&&(!e.acknowledgedAt||before(e.acknowledgedAt,cutoff))&&!referencedEvents.has(e.id);
  const alerts=(state.monitoring?.events??[]).filter(removable),collectionAlerts=(state.monitoring?.collectionEvents??[]).filter(removable);
  const sessions=state.sessions.filter(s=>before(s.expiresAt,at));
  const counts={notifications:notifications.length,alerts:alerts.length,collectionAlerts:collectionAlerts.length,sessions:sessions.length};
  // The fingerprint is returned, never session hashes or another user's notices.
  const fingerprint=hash(JSON.stringify({days,automatic:state.settings.retentionAutomatic===true,checkedAt,notifications:notifications.map(n=>n.id).sort(),alerts:alerts.map(e=>e.id).sort(),collectionAlerts:collectionAlerts.map(e=>e.id).sort(),sessions:sessions.map(s=>s.tokenHash).sort()}));
  const report:RetentionReport={days,automatic:state.settings.retentionAutomatic===true,checkedAt,cutoff:new Date(cutoff).toISOString(),fingerprint,eligible:counts,protected:{unreadNotifications:state.notifications.filter(n=>!n.readAt).length,unfinishedNotifications:state.notifications.filter(n=>!!n.readAt&&!finished(n.objectType,n.objectId)).length,activeAlerts:events.filter(e=>e.status==='active').length,activeSessions:state.sessions.filter(s=>!before(s.expiresAt,at)).length},lastRun:state.retention?.lastRun??null};
  return {report,notificationIds,alertIds:new Set(alerts.map(e=>e.id)),collectionAlertIds:new Set(collectionAlerts.map(e=>e.id)),sessionHashes:new Set(sessions.map(s=>s.tokenHash))};
}

export function requestedRetention(state:WorkspaceState,payload:Record<string,unknown>){
  text(payload.reason,'reason',2000);
  const prepared=prepareRetention(state,text(payload.checkedAt,'checkedAt',100));
  if(prepared.report.fingerprint!==payload.fingerprint)throw new ConflictException('retention preview changed; check the current records again');
  return prepared;
}
export function applyRetention(state:WorkspaceState,prepared:ReturnType<typeof prepareRetention>,actorId:string,source:RetentionRun['source']):RetentionRun{
  state.notifications=state.notifications.filter(n=>!prepared.notificationIds.has(n.id));
  state.sessions=state.sessions.filter(s=>!prepared.sessionHashes.has(s.tokenHash));
  if(state.monitoring){state.monitoring.events=state.monitoring.events.filter(e=>!prepared.alertIds.has(e.id));state.monitoring.collectionEvents=state.monitoring.collectionEvents?.filter(e=>!prepared.collectionAlertIds.has(e.id));}
  const run:RetentionRun={id:newId('retention'),executedAt:new Date().toISOString(),checkedAt:prepared.report.checkedAt,cutoff:prepared.report.cutoff,days:prepared.report.days,source,actorId,removed:prepared.report.eligible};
  state.retention={lastRun:run};return run;
}
export function retentionDue(state:WorkspaceState){
  if(state.settings.retentionAutomatic!==true)return false;
  const today=(at:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
  const last=state.retention?.lastRun;
  return !(last&&last.days===state.settings.retentionDays&&today(last.executedAt)===today(new Date().toISOString()));
}
export function scheduledRetention(state:WorkspaceState){
  if(!retentionDue(state))return null;
  const run=applyRetention(state,prepareRetention(state),'system:retention','automatic');
  state.audit.push({id:newId('audit'),actorId:run.actorId,action:'retention.run',objectId:run.id,reason:'按已启用的每日保留策略清理运行辅助记录',createdAt:run.executedAt,detail:{...run}});
  return run;
}
