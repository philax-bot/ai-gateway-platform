import type { ReactNode } from 'react';
import type { PlatformSnapshot } from '@ai-gateway/contracts';
import { api } from './client';
import { batchAppliesToMember,batchModelNames,batchSourceName,fundingSourceSummary,fundingSources,purposeBatches } from './quota-view';
import { date, money, Panel, Status, Table } from './components';
import { makeEditors, type RunCommand } from './editors';
import { Online, purposeLabels } from './Online';
import {AgentWorkspace} from './AgentWorkspace';
import {SafetyGuardrail} from './SafetyGuardrail';
import { CallExplorer } from './CallExplorer';
import { Monitoring } from './Monitoring';
import { UsageCockpit } from './UsageCockpit';
import { UsageLeaderboard } from './UsageLeaderboard';
import { CockpitBeaconDemo, CockpitLightDemo, CockpitTechDemo } from './cockpit-demo';
import { ApprovalCenter,approvalLabels } from './ApprovalCenter';
import { KeyManager } from './KeyManager';
import { Projects } from './Projects';
import { Applications } from './Applications';
import {ModelCatalog} from './ModelCatalog';
import { ModelSetup } from './ModelSetup';
import {ModelPools} from './ModelPools';
import {ModelCapacity} from './ModelCapacity';
import {RetentionSettings} from './RetentionSettings';
import {OperationAudit} from './OperationAudit';
import { EmployeeHome, EnableColleague, OperationsHome } from './TaskHome';
import { organizationEnabled,organizationPath,organizationTree } from './organizations';

export { approvalLabels } from './ApprovalCenter';
export type DetailContent=ReactNode|((data:PlatformSnapshot,edit:ReturnType<typeof makeEditors>)=>ReactNode);
export interface PageProps {data:PlatformSnapshot;page:string;targetId?:string|null;active?:boolean;isOps:boolean;edit:ReturnType<typeof makeEditors>;purposeId:string;setPurpose:(value:string)=>void;setPage:(value:string,id?:string)=>void;run:RunCommand;refresh:()=>Promise<boolean>;action:(work:()=>Promise<unknown>)=>void;detail:(title:string,content:DetailContent)=>void}
export function WorkspacePages({data:d,page,targetId,active=true,isOps,edit,purposeId,setPurpose,setPage,run,refresh,action,detail}:PageProps){
  const admin=d.actor.roles.includes('operator'),memberName=(id:string)=>d.members.find(m=>m.id===id)?.name??id;
  const poolName=(id:string)=>d.pools.find(p=>p.id===id)?.name??id;
  const limitDescription=(value:PlatformSnapshot['settings']['limits'])=>value.mode==='none'?'本级不额外限制':value.mode==='inherit'?'继承企业默认保护':[['RPM',value.rpm],['TPM',value.tpm],['并发',value.concurrency],['单次输出',value.maxOutputTokens]].filter(([,v])=>v!==undefined).map(([label,v])=>`${label} ${v}`).join(' · ')||'本级未设置数值';
  const purpose=d.purposes.find(p=>p.id===purposeId)??d.purposes[0];
  const selector=<label className="purpose-select">使用用途 <select value={purpose.id} onChange={e=>setPurpose(e.target.value)}>{d.purposes.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>;
  switch(page){
    case 'catalog':return <ModelCatalog data={d} edit={edit} setPage={setPage} refresh={refresh} detail={detail}/>;
    case 'safety':return <SafetyGuardrail data={d} run={run} active={active}/>;
    case 'agent':return <AgentWorkspace refreshWorkspace={refresh} setPage={setPage}/>;
    case 'monitoring':return <Monitoring data={d} edit={edit} run={run} detail={detail} refreshWorkspace={refresh} active={active}/>;
    case 'reviews':return <CallExplorer key="reviews" data={d} kind="reviews" reconcile={edit.reconcile} detail={detail} active={active} targetId={targetId} setPage={setPage}/>;
    case 'usage':return <UsageCockpit data={d} active={active} setPage={setPage} edit={edit}/>;
    case 'leaderboard':return <UsageLeaderboard data={d} active={active} setPage={setPage} edit={edit} targetId={targetId}/>;
    case 'cockpit-light':return <CockpitLightDemo data={d} active={active} setPage={setPage}/>;
    case 'cockpit-tech':return <CockpitTechDemo data={d} active={active} setPage={setPage}/>;
    case 'cockpit-beacon':return <CockpitBeaconDemo data={d} active={active} setPage={setPage}/>;
    case 'overview':return <OperationsHome data={d} setPage={setPage}/>;
    case 'home':return <EmployeeHome data={d} purposeId={purposeId} setPurpose={setPurpose} setPage={setPage} edit={edit}/>;
    case 'models':return <ModelSetup data={d} edit={edit} setPage={setPage} refresh={refresh} detail={detail}/>;
    case 'pools':return <ModelPools data={d} edit={edit} setPage={setPage}/>;
    case 'capacity':return <ModelCapacity data={d} edit={edit} setPage={setPage}/>;
    case 'members':return <>
      <Panel title="组织结构" actions={<button className="ghost" onClick={()=>edit.organization()}>创建组织</button>}><p className="secondary">移动或停用前，先核对所有下级人员、访问变化与自动发放影响。</p><Table headers={['组织路径','人员（含下级）','有效状态','操作']} rows={d.organizations.map(o=>{const tree=organizationTree(d.organizations,o.id);return [organizationPath(d.organizations,o.id),d.members.filter(m=>tree.has(m.organizationId)).length,organizationEnabled(d.organizations,o.id)?'启用':o.active?'上级停用，当前不可用':'本组织已停用',<button className="link-button" onClick={()=>edit.organization(o)}>编辑与影响预览</button>];})}/></Panel>
      <Panel title="成员目录" actions={<><button className="ghost" onClick={()=>edit.importMembers()}>导入成员</button><button className="primary" onClick={()=>edit.member()}>创建成员</button></>}><Table headers={['姓名','主要组织','类别','有效期 / 状态','业务标签','操作']} rows={d.members.map(m=>[<>{m.name}<small className="cell-help">登录账号 {m.directoryId}</small></>,organizationPath(d.organizations,m.organizationId),m.category==='contractor'?'外部协作':'员工',<>{!m.active?'成员停用':m.validUntil&&Date.parse(m.validUntil)<=Date.now()?'人员已到期':!organizationEnabled(d.organizations,m.organizationId)?'组织停用，当前不可用':'启用'}<small className="cell-help">{date(m.validUntil)}</small></>,m.tags?.join('、')||'—',<div className="inline-actions"><button onClick={()=>edit.member(m)}>编辑</button><button onClick={()=>edit.grantPlan(undefined,m.id)}>开通方案</button></div>])}/></Panel>
    </>;
    case 'onboarding':return <>
      <EnableColleague data={d} run={run} edit={edit} setPage={setPage}/>
      <details className="disclosure"><summary>开通设置与记录</summary>
      <Panel title="个人开通方案" actions={<><button className="ghost" onClick={()=>edit.grantPlan()}>批量开通</button><button className="primary" onClick={()=>edit.plan()}>创建方案</button></>}><Table headers={['方案','模型范围','周期与金额','版本','操作']} rows={d.plans.map(p=>[p.name,`${poolName(p.range.poolId)} · ${p.range.mode==='follow'?'跟随池':'指定模型'}`,`${p.cadence==='monthly'?'每月':'一次性'} ${money(p.amount)}`,p.version,<div className="inline-actions"><button onClick={()=>edit.plan(p)}>编辑模板</button><button onClick={()=>edit.grantPlan(p.id)}>开通给人员</button></div>])}/></Panel>
      <Panel title="自动开通规则" actions={<button className="primary" onClick={()=>edit.rule()}>创建规则</button>}><p className="secondary">组织、人员类别与标签同时满足。保存规则作用于后续新增或属性变更；存量人员须单独预览应用。多个规则命中同一方案只发一次，不同方案可叠加。</p><Table headers={['规则','目标方案','匹配条件','状态','操作']} rows={d.rules.map(r=>[r.name,d.plans.find(p=>p.id===r.planId)?.name,[r.organizationId?`${d.organizations.find(o=>o.id===r.organizationId)?.name}${r.includeChildren?'及下级':'（本级）'}`:'全部组织',r.category==='employee'?'员工':r.category==='contractor'?'外部协作':'不限类别',r.tags.length?`全部标签：${r.tags.join('、')}`:'不限标签'].join(' · '),r.active?'启用':'停用',<div className="inline-actions"><button onClick={()=>edit.rule(r)}>编辑与人数预览</button>{r.active&&<button onClick={()=>action(()=>run('auto.apply',{id:r.id}))}>预览并应用到现有成员</button>}</div>])}/></Panel>
      <Panel title="已开通权益" actions={<><button className="ghost" onClick={()=>edit.topup()}>追加已有方案额度</button><button className="ghost" onClick={()=>edit.migrateEntitlements()}>迁移方案版本</button><button className="ghost" onClick={()=>action(()=>run('periodic.run',{}))}>检查本月发放</button></>}><Table headers={['成员','方案与授予版本','范围','期限','未来发放','操作']} rows={d.entitlements.map(e=>[memberName(e.memberId),`${e.planSnapshot.name} · v${e.planVersion}`,e.range.mode==='follow'?'跟随模型池':'仅指定模型',date(e.expiresAt),e.planSnapshot.cadence==='once'?'一次性方案':({scheduled:'按月继续',manually_stopped:'已手动停止',rule_not_matching:'已不匹配规则',inactive:'成员或权益无效'}[e.futureGrantStatus]),<div className="inline-actions">{e.status==='active'&&Date.parse(e.expiresAt)>Date.now()&&<button onClick={()=>edit.topup(e.planId,e.memberId)}>追加额度</button>}{e.status==='active'&&Date.parse(e.expiresAt)>Date.now()&&d.plans.some(p=>p.id===e.planId&&p.active&&p.version>e.planVersion)&&<button onClick={()=>edit.migrateEntitlements(e)}>迁移版本</button>}{e.futureGrantStatus==='scheduled'&&e.planSnapshot.cadence==='monthly'&&<button onClick={()=>action(()=>run('entitlement.stop',{id:e.id}))}>停止未来发放</button>}</div>])}/><p className="secondary">迁移版本只把同一方案的旧权益更新到当前版本，保留已发批次余额、到期日与已发周期；不补发额度，跨方案与一次性/月度互转不在首版范围。</p></Panel>
      <Panel title="发放执行记录"><Table headers={['方案 / 范围','人数','发放 / 跳过 / 失败','时间','明细']} rows={d.distributions.slice().reverse().map(r=>[<>{r.planSnapshot?.name??d.plans.find(p=>p.id===r.planId)?.name??'已有权益追加'}<small className="cell-help">{r.scopeDescription??r.kind} · {r.planSnapshot?`v${r.planSnapshot.version}`:''}</small></>,r.memberIds.length,`${r.results.filter(r=>r.status==='granted').length} / ${r.results.filter(r=>r.status==='skipped').length} / ${r.results.filter(r=>r.status==='failed').length}`,date(r.createdAt),<button className="link-button" onClick={()=>detail('逐人发放结果',<><p>批次 {r.id} · 每人标准金额 {money(r.amount)}。实际资金以成功生成的来源批次为准。</p><Table headers={['成员','结果','实际新增金额','授予版本','原因','到期日','来源批次']} rows={r.results.map(row=>[memberName(row.memberId),row.status==='granted'?'已开通 / 发放':row.status==='skipped'?'跳过':'失败',row.amount===undefined?'历史未采集':money(row.amount),row.planVersion===undefined?'—':`v${row.planVersion}`,row.reason||'—',row.expiresAt?date(row.expiresAt):'未新增资金批次',row.batchId??'—'])}/></>)}>查看明细</button>])}/></Panel>
      </details>
    </>;
    case 'projects':return <Projects data={d} isOps={isOps} edit={edit} run={run} detail={detail} setPage={setPage} targetId={targetId}/>;
    case 'applications':return <Applications data={d} edit={edit} setPage={setPage} detail={detail} isOps={isOps} targetId={targetId}/>;
    case 'quota':{
      const batches=purposeBatches(d,purpose),singleCallLimit=Math.max(0,...purpose.models.map(m=>m.largestBatchAmount));
      const sourceRows=batches.map(b=>{
        const state=b.closedAt?'已结束':Date.parse(b.expiresAt)<=Date.now()?'已过期':b.availableAmount>0?'有效':'已用完',models=batchModelNames(d,b);
        return [<>{batchSourceName(d,b)}<small className="cell-help">{b.id}</small></>,money(b.totalAmount),money(b.availableAmount),models.length?models.join('、'):'—',date(b.expiresAt),state,b.entitlementId?<button className="link-button" onClick={()=>edit.request('personal_topup',b.entitlementId!)}>申请追加</button>:purpose.projectId?<button className="link-button" onClick={()=>edit.request('project_member_quota',purpose.projectId!)}>申请追加</button>:'—'];
      });
      const modelRows=purpose.models.map(m=>{
        const sources=fundingSources(d,purpose,m.modelId),active=batches.some(b=>batchAppliesToMember(d,b)&&b.modelIds.includes(m.modelId));
        return [m.name,purposeLabels[m.status],sources.length?fundingSourceSummary(sources):active?'来源已用完':'暂无有效来源'];
      });
      /* 额度带按“剩余金额”占比分段；全为 0 时退回“原始金额”，金额本身仍以下方表格为准。 */
      const remainingTotal=batches.reduce((sum,b)=>sum+Math.max(0,b.availableAmount),0),originalTotal=batches.reduce((sum,b)=>sum+Math.max(0,b.totalAmount),0),ribbonTotal=Math.max(1,remainingTotal||originalTotal);
      const ribbonValue=(b:typeof batches[number])=>remainingTotal?Math.max(0,b.availableAmount):Math.max(0,b.totalAmount);
      return <>
        <Panel title="按用途查看额度" actions={selector}><span className="tag">{purposeLabels[purpose.status]}</span><strong className="balance">{money(purpose.availableAmount)}</strong>
          {batches.length>0&&<div className="quota-ribbon" aria-hidden="true">{batches.map((b,index)=><div key={b.id} className="quota-ribbon-seg" data-tone={String((index%4)+1)} style={{flexGrow:Math.max(1,Math.round(ribbonValue(b)/ribbonTotal*100))}}><span className="quota-ribbon-name">{batchSourceName(d,b)}</span><span className="quota-ribbon-value">{money(ribbonValue(b))}</span></div>)}</div>}
          <p className="secondary">用途余额（按来源批次去重合计） · 单次调用上限 {money(singleCallLimit)}（最大单批余额）。</p><p className="secondary">一次调用只能由一个来源批次扣费{singleCallLimit<purpose.availableAmount?'；余额分散在多个批次时，超出单批上限的部分需分次使用':''}。已有权益追加，请在来源批次行选择申请追加。</p><div className="actions"><button className="primary" onClick={()=>setPage('online')}>在线使用</button><button className="ghost" onClick={()=>edit.request(purpose.projectId?'project_member_quota':'personal_open',purpose.projectId??undefined)}>{purpose.projectId?'申请项目额度':'申请开通新模型'}</button></div></Panel>
        <Panel title="额度来源与批次"><Table headers={['来源','原始金额','剩余金额','覆盖模型','有效期','状态','追加']} rows={sourceRows} empty="当前用途还没有额度来源。"/><p className="secondary">同一来源批次可同时覆盖多个模型，余额只在本表展示一次。</p></Panel>
        <Panel title="可用模型"><Table headers={['模型','状态','支持来源']} rows={modelRows} empty="当前没有可用的已开放模型，请先查看模型权益。"/><p className="secondary">同一来源被多个模型共用时，调用任一模型都从该来源扣费；金额以“额度来源与批次”为准。</p></Panel>
      </>;
    }
    case 'online':return <Online data={d} purposeId={purpose.id} onPurpose={setPurpose} refresh={refresh}/>;
    case 'keys':return <KeyManager data={d} isOps={isOps} edit={edit} detail={detail}/>;
    case 'approvals':return <ApprovalCenter data={d} edit={edit} run={run} setPage={setPage} targetId={targetId}/>;
    case 'calls':return <CallExplorer key="calls" data={d} kind="calls" reconcile={edit.reconcile} detail={detail} active={active} targetId={targetId} setPage={setPage}/>;
    case 'settings':if(!admin)return <Panel title="设置权限已变化"><p>当前账号已无运营设置权限，请返回首页继续处理自己的任务。</p><button className="primary" onClick={()=>setPage('home')}>返回首页</button></Panel>;return <>
      <Panel title="企业信息与默认模型池" actions={<><button className="ghost" onClick={()=>edit.workspaceName()}>调整企业名称</button><button className="primary" onClick={()=>edit.defaults()}>调整默认池</button></>}><dl className="detail-list"><div><dt>企业名称</dt><dd>{d.settings.name}</dd></div><div><dt>时区</dt><dd>Asia/Shanghai</dd></div><div><dt>个人默认池</dt><dd>{poolName(d.settings.personalDefaultPoolId??'未设置')}</dd></div><div><dt>项目默认池</dt><dd>{poolName(d.settings.projectDefaultPoolId??'未设置')}</dd></div></dl></Panel>
      <Panel title="默认使用保护" actions={<button className="ghost" onClick={()=>setPage('capacity')}>前往容量与保护</button>}><p>{limitDescription(d.settings.limits)}</p><p className="secondary">默认值用于产品准入保护，不代表已验证的模型容量。统一在容量与保护中调整，变更影响后续新请求；已预占请求按原快照结算。</p></Panel>
      <RetentionSettings data={d} edit={edit} run={run}/>
      <OperationAudit data={d} detail={detail}/>
    </>;
    case 'notifications':return <Panel title="站内通知">{d.notifications.length?d.notifications.slice().reverse().map(n=><article className="resource-card" key={n.id}><div className="section-head"><h3>{n.title}</h3>{!n.readAt&&<button className="ghost" onClick={()=>action(()=>run('notification.read',{id:n.id},false))}>标为已读</button>}</div><p>{n.body}</p><small>{date(n.createdAt)}</small>{['alert','approval'].includes(n.objectType)&&<button className="link-button" onClick={()=>setPage(n.objectType==='alert'?'monitoring':'approvals',n.objectId)}>查看原始事项</button>}</article>):<div className="empty">还没有通知。审批结果、额度变化和运行告警会显示在这里。</div>}</Panel>;
    default:return null;
  }
}
