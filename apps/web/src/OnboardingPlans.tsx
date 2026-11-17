import {hasPermission} from '@ai-gateway/contracts';
import {money,Panel,Status,Table} from './components';
import {availablePlanModels,planReadiness} from './model-readiness';
import type {PageProps} from './WorkspacePages';

export function OnboardingPlans({data:d,edit,setPage}:Pick<PageProps,'data'|'edit'|'setPage'>){
  const canManage=hasPermission(d.actor,'administration.manage');
  return <Panel title="个人开通方案" actions={<button className="primary" disabled={!canManage} title={!canManage?'需要开通管理权限':undefined} onClick={()=>edit.plan()}>新建方案</button>}>
    <p className="secondary">方案组合模型池、每人额度、发放周期和有效期。保存后可在“为人员开通”中选用。</p>
    <Table headers={['方案 / 版本','模型池与范围','当前可用模型','每人额度 / 周期','有效期','状态','操作']} rows={d.plans.map(plan=>{
      const reason=planReadiness(d,plan),models=availablePlanModels(d,plan);
      return [<>{plan.name}<small className="cell-help">v{plan.version}</small></>,<>{d.pools.find(p=>p.id===plan.range.poolId)?.name??'模型池已不存在'}<small className="cell-help">{plan.range.mode==='follow'?'跟随模型池':'仅指定模型'}</small></>,models.join('、')||'暂无可用模型',<>{money(plan.amount)}<small className="cell-help">{plan.cadence==='monthly'?'每月发放':'一次性发放'}</small></>,<>{plan.cadence==='monthly'?'当月额度月底到期':`额度 ${plan.quotaDays} 天`}<small className="cell-help">权益最长 {plan.entitlementDays} 天</small></>,<><Status value={!plan.active?'disabled':reason?'pending':'active'} label={!plan.active?'已停用':reason?'暂不可用':'可开通'}/>{reason&&<small className="cell-help">{reason}</small>}</>,<div className="inline-actions"><button disabled={!canManage} onClick={()=>edit.plan(plan)}>编辑方案</button><button disabled={!canManage||!!reason} title={reason??undefined} onClick={()=>edit.grantPlan(plan.id)}>开通给人员</button>{reason&&<button className="link-button" onClick={()=>setPage('pools')}>检查模型池</button>}</div>];
    })} empty="尚未创建开通方案。点击“新建方案”，选择模型池并设置额度与有效期。"/>
    <p className="secondary">调整方案产生新版本，已开通人员保留原版本；需要变更存量权益时，在“为人员开通”的已开通权益中预览迁移。</p>
  </Panel>;
}
