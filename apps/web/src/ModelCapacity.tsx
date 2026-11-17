import {hasPermission} from '@ai-gateway/contracts';
import type {UsageLimits} from '@ai-gateway/contracts';
import {Panel,Table} from './components';
import type {PageProps} from './WorkspacePages';

const modeText=(value:UsageLimits)=>value.mode==='inherit'?'继承企业默认':value.mode==='none'?'本级不额外限制':'自定义本级上限';
const limitText=(value:UsageLimits)=>value.mode==='none'?'本级不额外限制':[['RPM',value.rpm],['TPM',value.tpm],['并发',value.concurrency],['单次输出 Token',value.maxOutputTokens]].filter(([,v])=>v!==undefined).map(([label,v])=>`${label} ${Number(v).toLocaleString('zh-CN')}`).join(' · ')||'未设置数值上限';

export function ModelCapacity({data:d,edit,setPage}:Pick<PageProps,'data'|'edit'|'setPage'>){
  if(!hasPermission(d.actor,'models.read'))return <Panel title="容量与保护"><p role="alert">容量与保护仅供运营管理。</p><button className="ghost" onClick={()=>setPage('home')}>返回首页</button></Panel>;
  const defaults=d.settings.limits,effective=(value:UsageLimits)=>limitText(value.mode==='inherit'?defaults:value);
  const modelName=(id:string)=>d.definitions.find(m=>m.id===id)?.name??id;
  const sharedIds=[...new Set(d.services.flatMap(s=>s.sharedCapacityId?[s.sharedCapacityId]:[]))];
  const config=(value:UsageLimits)=><>{modeText(value)}<small className="cell-help">{value.mode==='inherit'?'来源：企业默认保护':'来源：当前对象配置'}</small></>;
  return <>
    <Panel title="企业默认保护" actions={<button className="primary" disabled={!hasPermission(d.actor,'administration.manage')} onClick={()=>edit.defaultLimits()}>调整企业默认保护</button>}>
      <p>{limitText(defaults)}</p>
      <p className="secondary">默认值由选择继承的对象分别采用，按各自边界计数；不表示企业所有请求共用一个总计数器。调整会影响所有继承对象与共享容量组。</p>
    </Panel>
    <Panel title="模型资源保护">
      <p className="secondary">以下显示本级采用的配置上限。一次请求需同时满足主体、用途、模型池、服务、服务模型及共享容量等适用限制；本级不额外限制不会解除其他边界。</p>
      <Table headers={['对象范围 / 对象','配置来源','本级采用上限','关联范围','操作']} rows={[
        ...d.services.flatMap(s=>[
          [<>模型服务<small className="cell-help">{s.name}</small></>,config(s.limits),effective(s.limits),s.sharedCapacityId?`共享容量：${s.sharedCapacityId}`:'独立登记服务',<button disabled={!hasPermission(d.actor,'models.write')} className="link-button" onClick={()=>edit.service(s)}>编辑服务保护</button>],
          ...s.mappings.map(m=>[<>服务模型<small className="cell-help">{s.name} / {modelName(m.definitionId)}</small></>,config(m.limits),effective(m.limits),'同时受所属服务保护',<button disabled={!hasPermission(d.actor,'models.write')} className="link-button" onClick={()=>edit.service(s)}>编辑模型入口保护</button>]),
        ]),
        ...d.pools.map(p=>[<>模型池<small className="cell-help">{p.name}</small></>,config(p.limits),effective(p.limits),'池内来源共同受池上限约束',<button disabled={!hasPermission(d.actor,'models.write')} className="link-button" onClick={()=>edit.pool(p)}>编辑模型池保护</button>]),
      ]} empty="尚未配置模型资源。接入模型服务后，可在这里查看服务和模型池的保护配置。"/>
      <div className="actions"><button className="ghost" onClick={()=>setPage('models')}>管理模型服务</button><button className="ghost" onClick={()=>setPage('pools')}>管理模型池</button></div>
    </Panel>
    <Panel title="共享容量">
      <Table headers={['共享容量标识','共同计数的服务','配置来源与上限','操作']} rows={sharedIds.map(id=>[id,d.services.filter(s=>s.sharedCapacityId===id).map(s=><div key={s.id}><button disabled={!hasPermission(d.actor,'models.write')} className="link-button" onClick={()=>edit.service(s)}>{s.name}</button></div>),<>企业默认保护<small className="cell-help">{limitText(defaults)}</small></>,<button className="link-button" disabled={!hasPermission(d.actor,'administration.manage')} onClick={()=>edit.defaultLimits()}>调整企业默认保护</button>])} empty="尚未登记共享容量标识。同一底层资源若登记为多个服务，请在服务配置中填写相同标识，避免重复计算可用算力。"/>
      <p className="secondary">相同标识的服务共用此边界的计数与企业默认上限，当前不支持按组单独设置上限。上限是请求保护配置，不是实测吞吐、剩余容量或可直接相加的算力；实时状态与告警请在运行监控查看。</p>
      <button className="ghost" onClick={()=>setPage('monitoring')}>查看运行监控</button>
    </Panel>
  </>;
}
