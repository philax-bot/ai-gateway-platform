import {BadRequestException} from '@nestjs/common';
import type {AuditEntry,AuditPage,AuditQuery,AuditRecord,PlatformCommand,WorkspaceState} from '@ai-gateway/contracts';
import {hash} from './validation';

const actionNames:Record<string,string>={
  'workspace.bootstrap':'首次安装','save.organization':'保存组织','organization.impact':'核对组织影响','save.member':'保存成员','import.members':'导入成员',
  'save.provider':'保存供应商','delete.provider':'删除供应商','save.definition':'保存模型定义','save.service':'保存模型服务','service.verify':'验证模型连接','save.pool':'调整模型池','save.plan':'保存开通方案','save.rule':'保存自动开通规则',
  'auto.apply':'为现有成员应用规则','distribution.execute':'执行开通或发放','entitlement.grant':'授予使用权益','entitlement.stop':'停止后续发放','entitlement.revoke':'撤销使用权益','quota.monthly_grant':'发放月度额度',
  'project.initial_grant':'项目初始授额','application.initial_grant':'应用初始授额','project.changed':'项目配置变更','application.changed':'应用配置与交接',
  'project.reclaim':'回收项目预算','project.return':'退回成员额度','project.extend':'延长项目额度','application.reclaim':'回收应用额度','application.extend':'延长应用额度',
  'save.project':'保存项目','project.members':'调整项目成员','project.fund':'发放项目预算','project.allocate':'分配项目成员额度','project.end':'结束项目','project.closed':'记录项目回收',
  'save.application':'保存应用','application.fund':'发放应用额度','application.billing_changed':'切换应用计费模式','approval.submit':'提交申请','approval.withdraw':'撤回申请','approval.close':'关闭未生效申请','approval.decide':'处理审批','approval.execute':'执行已批准事项','approval.repair':'修正执行参数','approval.execution_repaired':'记录审批修正','approval.execution_failed':'记录审批执行失败',
  'key.issue':'签发密钥','key.status':'调整密钥状态','keys.status':'批量调整密钥','settings.update':'调整企业设置','settings.retention':'调整保留策略','retention.run':'清理运行辅助记录','notification.read':'读取站内通知','periodic.run':'检查周期发放','usage.reconcile':'核对调用费用',
  'credential.save':'维护上游凭据','pricing.update':'调整模型计价','alert.silence':'调整告警静默','notification.channel.save':'配置通知接收端','notification.delivery.retry':'重试通知投递','save.alert-rule':'保存告警规则','alert.ack':'知晓告警','alert.opened':'触发业务告警','alert.recovered':'恢复业务告警','alert.collection_opened':'记录采集故障','alert.collection_recovered':'记录采集恢复',
};
const systems:Record<string,string>={system:'系统','system:monthly':'周期发放任务','system:monitor':'监控任务','system:retention':'保留策略任务'};
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const string=(value:unknown)=>typeof value==='string'?value:'';
const labels:Record<string,string>={pending:'待审批',approved:'已批准待生效',effective:'已生效',failed:'执行失败',rejected:'已驳回',withdrawn:'已撤回',closed:'已关闭',active:'已启用',disabled:'已停用',revoked:'已吊销',ended:'已结束',paused:'已暂停',passed:'验证通过',unverified:'尚未验证',manual:'手动开通',automatic:'自动开通',approval:'审批开通'};
const name=(s:WorkspaceState,id:string)=>[...(s.providers??[]),...(s.upstreamCredentials??[]),...(s.monitoring?.channels??[]),...s.members,...s.organizations,...s.projects,...s.applications,...s.definitions,...s.services,...s.pools,...s.plans,...s.rules,...s.keys,...(s.monitoring?.rules??[])].find(v=>v.id===id)?.name;
const amount=(value:number)=>`${value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6})} 元`;

export function auditObjectId(command:PlatformCommand,result:unknown):string|null{
  const p=command.payload,d=record(result),key=record(d.key);
  if(command.type==='key.issue')return string(key.id)||null;
  if(command.type.startsWith('project.'))return string(p.projectId)||null;
  if(command.type.startsWith('application.'))return string(p.applicationId)||null;
  if(command.type==='usage.reconcile')return string(p.requestId)||null;
  if(command.type==='keys.status')return string(d.batchId)||null;
  if(command.type.startsWith('settings.')||command.type==='periodic.run')return null;
  if(command.type==='approval.submit'||command.type==='distribution.execute'||command.type==='retention.run')return string(d.id)||null;
  return string(p.id)||string(d.id)||null;
}

export function describeAudit(s:WorkspaceState,entry:AuditEntry):AuditRecord{
  const d=record(entry.detail),key=record(d.key),plan=record(d.planSnapshot);
  const objectId=entry.objectId||string(key.id)||string(d.projectId)||string(d.sourceId)||string(d.id)||null;
  let objectName=entry.objectName||string(d.name)||string(key.name),source:AuditRecord['objectNameSource']=objectName?'recorded':'unavailable';
  if(!objectName){
    if(entry.action.startsWith('settings.')||entry.action==='workspace.bootstrap')objectName='企业工作空间';
    else if(entry.action==='retention.run')objectName='通知、告警与过期会话';
    else if(entry.action==='keys.status')objectName=`${Array.isArray(d.keys)?d.keys.length:'多'}把用途密钥`;
    else if(entry.action==='distribution.execute')objectName=`${string(plan.name)||'人员开通与发放'} · ${Array.isArray(d.memberIds)?d.memberIds.length:'多'}人`;
    else if(entry.action==='notification.read')objectName='站内通知';
    else if(entry.action==='periodic.run')objectName='周期发放任务';
    else if(entry.action.startsWith('alert.collection_'))objectName='运行监控采集';
    else if(entry.action.startsWith('approval.')){
      const approval=s.approvals.find(a=>a.id===objectId),kinds:Record<string,string>={project_create:'项目创建',project_budget:'项目预算',project_member_quota:'项目成员额度',personal_open:'个人开通',personal_topup:'个人额度追加',application_quota:'应用额度',application_billing:'应用切换额度模式'};
      objectName=approval?`${kinds[approval.kind]??'业务'}申请 · ${name(s,approval.applicantId)??'历史申请人'}`:'历史审批事项';source=approval?'current':'unavailable';
    }else if(objectId){
      objectName=name(s,objectId)??'';source=objectName?'current':'unavailable';
      const entitlement=s.entitlements.find(e=>e.id===objectId);
      if(!objectName&&entitlement){objectName=`${entitlement.planSnapshot.name} · ${name(s,entitlement.memberId)??'历史成员'}`;source='current';}
      if(!objectName&&entry.action.startsWith('alert.')){
        const event=s.monitoring?.events.find(e=>e.id===objectId);objectName=event?.ruleSnapshot.name??'历史告警';source=event?'current':'unavailable';
      }
    }
  }
  const summary:AuditRecord['summary']=[],append=(label:string,value:unknown)=>{if(typeof value==='string'&&value||typeof value==='number'&&Number.isFinite(value))summary.push({label,value:String(value)});};
  append('名称',d.name??key.name);append('状态',labels[string(d.status??key.status)]);
  if(typeof d.active==='boolean')append('启用状态',d.active?'启用':'停用');
  for(const [field,label]of [['amount','本次金额'],['totalAmount','来源批次原始金额'],['approvedAmount','批准金额'],['availableAmount','执行后批次可用金额']]as const)if(typeof d[field]==='number')append(label,amount(d[field]));
  for(const [field,label]of [['memberId','成员'],['ownerId','应用负责人'],['managerId','项目经理'],['organizationId','所属组织'],['planId','开通方案']]as const)if(typeof d[field]==='string')append(label,name(s,d[field])??'历史对象');
  for(const [field,label]of [['expiresAt','有效期'],['approvedExpiresAt','批准期限'],['createdAt','对象创建时间']]as const)if(typeof d[field]==='string')append(label,d[field]);
  if(Array.isArray(d.memberIds))append('涉及成员',`${d.memberIds.length} 人`);
  if(typeof d.changedCount==='number'){append('实际变更',`${d.changedCount} 把`);append('跳过',`${typeof d.skippedCount==='number'?d.skippedCount:0} 把`);}
  if(Array.isArray(d.keys))for(const value of d.keys){const k=record(value);append(string(k.name)||'用途密钥',`${string(k.masked)} · ${labels[string(k.before)]??'原状态'} → ${labels[string(k.after)]??'执行后状态'}${k.changed===false?'（跳过）':''}`);}
  const removed=record(d.removed);for(const [field,label]of [['notifications','清理通知'],['alerts','清理业务告警'],['collectionAlerts','清理采集告警'],['sessions','清理过期会话']]as const)if(typeof removed[field]==='number')append(label,`${removed[field]} 条`);
  const days=d.days,automatic=d.automatic;if(typeof days==='number')append('保留期限',`${days} 天`);if(typeof automatic==='boolean')append('执行方式',automatic?'每日自动清理':'按需手动清理');
  if(entry.action==='service.verify')append('验证结果',d.verification==='passed'?'连接验证通过':d.verification==='failed'?'连接验证失败':'未确认');
  const reason=entry.action==='entitlement.grant'?(labels[entry.reason]??entry.reason):entry.action==='workspace.bootstrap'&&entry.reason==='initial setup'?'创建首位运营管理员':entry.action==='approval.execution_failed'&&entry.reason==='plan not found'?'批准时选择的方案已不存在，尚未完成生效。':entry.reason;
  const createdAt=Number.isFinite(Date.parse(entry.createdAt))?new Date(entry.createdAt).toISOString():entry.createdAt;
  return {id:entry.id,createdAt,actorId:entry.actorId,actorName:entry.actorName||systems[entry.actorId]||name(s,entry.actorId)||'历史操作者',action:entry.action,actionName:actionNames[entry.action]??'历史管理操作',objectId,objectName:objectName||'历史业务对象',objectNameSource:source,reason,summary};
}

function normalize(raw:AuditQuery){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('invalid audit query');
  const q:AuditQuery={limit:raw.limit??20};if(!Number.isInteger(q.limit)||q.limit!<1||q.limit!>100)throw new BadRequestException('audit page size must be between 1 and 100');
  for(const field of ['search','actorId','action','from','to']as const){const value=raw[field];if(value===undefined||value==='')continue;if(typeof value!=='string'||value.length>200)throw new BadRequestException(`invalid audit ${field}`);q[field]=value.trim();}
  for(const field of ['from','to']as const)if(q[field]){if(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(q[field]!)||!Number.isFinite(Date.parse(q[field]!)))throw new BadRequestException(`invalid audit ${field}`);q[field]=new Date(q[field]!).toISOString();}
  if(q.from&&q.to&&q.from>=q.to)throw new BadRequestException('audit from must be before to');
  if(q.search)q.search=q.search.toLowerCase();
  return q;
}
export function queryAudit(s:WorkspaceState,raw:AuditQuery):AuditPage{
  const q=normalize(raw),fingerprint=hash(JSON.stringify(q));let size=s.audit.length,before:[string,string]|null=null;
  if(raw.cursor!==undefined)try{
    if(typeof raw.cursor!=='string'||raw.cursor.length>700)throw 0;const v=JSON.parse(Buffer.from(raw.cursor,'base64url').toString());
    if(!Array.isArray(v)||v.length!==5||v[0]!==1||v[1]!==fingerprint||!Number.isSafeInteger(v[2])||v[2]<0||v[2]>size||typeof v[3]!=='string'||!Number.isFinite(Date.parse(v[3]))||typeof v[4]!=='string'||v[4].length>200)throw 0;
    size=v[2];before=[v[3],v[4]];if(!s.audit.slice(0,size).some(e=>e.id===v[4]&&Date.parse(e.createdAt)===Date.parse(v[3])))throw 0;
  }catch{throw new BadRequestException('invalid audit cursor; restart the search');}
  const source=s.audit.slice(0,size),views=source.map(e=>describeAudit(s,e));
  const matches=views.filter(e=>(!q.actorId||e.actorId===q.actorId)&&(!q.action||e.action===q.action)&&(!q.from||e.createdAt>=q.from)&&(!q.to||e.createdAt<q.to)&&(!q.search||[e.id,e.actorId,e.actorName,e.action,e.actionName,e.objectId??'',e.objectName,e.reason,...e.summary.flatMap(v=>[v.label,v.value])].some(value=>value.toLowerCase().includes(q.search!)))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||(a.id===b.id?0:a.id<b.id?1:-1));
  const after=before?matches.filter(e=>e.createdAt<before![0]||e.createdAt===before![0]&&e.id<before![1]):matches,items=after.slice(0,q.limit),last=items.at(-1);
  return {items,total:matches.length,collectedAt:new Date().toISOString(),nextCursor:after.length>items.length&&last?Buffer.from(JSON.stringify([1,fingerprint,size,last.createdAt,last.id])).toString('base64url'):null,actors:[...new Map(views.map(e=>[e.actorId,{id:e.actorId,name:e.actorName}])).values()],actions:[...new Map(views.map(e=>[e.action,{id:e.action,name:e.actionName}])).values()]};
}
