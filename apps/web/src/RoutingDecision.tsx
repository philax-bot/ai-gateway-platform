import {ROUTING_STRATEGIES,type RoutingDecision as Decision} from '@ai-gateway/contracts';
import {date,Table} from './components';

const reasons:Record<string,string>={
  best_available_rank:'当前可用来源中排序最优',lower_rank:'排序靠后',
  consecutive_upstream_failures:'连续上游故障，冷却中',admission_limit_reached:'准入容量达到上限',
  batch_cannot_fund_reservation:'当前批次不足以承担预占',model_not_open:'未开放',
  service_unavailable:'连接、映射或服务状态未就绪',price_unconfigured:'计价未配置',
  request_limit_exceeded:'请求超过单次上限',policy_stale:'价格版本已变化',
};
const statuses:Record<string,string>={eligible:'待选择',excluded:'配置排除',cooldown:'冷却中',capacity:'容量不足',quota_insufficient:'批次余额不足',selected:'本次选中',not_selected:'未选中'};

export function RoutingDecisionView({decision}:{decision:Decision}){
  return <>
    <dl className="detail-list">
      <div><dt>策略 / 候选服务</dt><dd>{ROUTING_STRATEGIES[decision.strategy]} / {decision.candidateCount}</dd></div>
      <div><dt>采样时间</dt><dd>{decision.sampledAt?date(decision.sampledAt):'历史记录未保留'}</dd></div>
      <div><dt>策略配置摘要</dt><dd>{decision.policyVersion??'历史记录未保留'}</dd></div>
    </dl>
    <Table headers={['候选来源 / 配置版本','结果与原因','排序 / 分数','权重 / 优先级','容量快照','健康样本']} empty="此记录没有候选明细。后续新调用会保存选路依据。" rows={(decision.candidates??[]).map(row=>[
      <>{row.serviceName}<small className="cell-help">{row.configVersion===null?'配置未知':`v${row.configVersion}`}</small></>,
      <>{statuses[row.status]}<small className="cell-help">{row.reason?reasons[row.reason]??row.reason:'—'}</small>{row.cooldownUntil&&<small className="cell-help">冷却至 {date(row.cooldownUntil)}</small>}</>,
      <>{row.rank??'—'} / {row.score===null?'—':row.score.toFixed(4)}<small className="cell-help">同分序值 {row.tie===null?'—':row.tie.toFixed(4)}</small></>,
      `${row.weight} / ${row.priority}`,
      <div className="cell-list">{row.scopes.map(scope=><span key={scope.id}>{scope.id}<small className="cell-help">RPM {scope.requests}/{scope.rpm??'不限'} · TPM {scope.tokens}/{scope.tpm??'不限'} · 并发 {scope.active}/{scope.concurrency??'不限'}{row.blockedScopes.includes(scope.id)?' · 达到上限':''}</small></span>)}</div>,
      <>{row.latencySamples} 个延迟样本<small className="cell-help">{row.latencyMs===null?'延迟未知':`${row.latencyMs.toFixed(1)} ms`}</small></>,
    ])}/>
    <p className="secondary">分数越小越优先。延迟样本少于 3 个时使用当前候选的中位延迟；同分按请求编号生成稳定序值。容量在新请求准入前检查。</p>
  </>;
}
