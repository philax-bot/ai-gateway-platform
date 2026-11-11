import {Panel,Status,Table} from './components';
import {entryReadiness} from './model-readiness';
import type {PageProps} from './WorkspacePages';

export function ModelPools({data:d,edit,setPage}:Pick<PageProps,'data'|'edit'|'setPage'>){
  if(!d.actor.roles.includes('operator'))return <Panel title="模型池"><p role="alert">模型池仅供运营管理。</p><button className="ghost" onClick={()=>setPage('home')}>返回首页</button></Panel>;
  const name=(id:string)=>d.definitions.find(m=>m.id===id)?.name??id;
  const poolName=(id:string|null)=>d.pools.find(p=>p.id===id)?.name??'未设置';
  return <>
    <Panel title="模型池与开放范围" actions={<button className="primary" onClick={()=>edit.pool()}>创建模型池</button>}>
      <p className="secondary">一个池可纳入多个模型服务，每个服务只归属一个池。同一模型的多个来源共同承接请求；新增来源默认暂不开放。</p>
      <Table headers={['模型池','服务 / 去重模型 / 可用模型','来源与开放状态','操作']} rows={d.pools.map(p=>{
        const serviceIds=[...new Set(p.entries.map(e=>e.serviceId))],models=new Set(p.entries.map(e=>e.definitionId)),usable=new Set(p.entries.filter(e=>!entryReadiness(d,e)).map(e=>e.definitionId));
        return [<>{p.name}<small className="cell-help">{[d.settings.personalDefaultPoolId===p.id?'个人默认池':'',d.settings.projectDefaultPoolId===p.id?'项目默认池':''].filter(Boolean).join(' · ')||'非默认池'}</small></>,<>{serviceIds.length} 个服务 / {models.size} 个模型<small className="cell-help">{usable.size} 个模型已开放且配置就绪</small></>,<div className="cell-list">{p.entries.length?p.entries.map(e=>{const service=d.services.find(s=>s.id===e.serviceId),reason=entryReadiness(d,e);return <span key={`${e.serviceId}:${e.definitionId}`}><strong>{name(e.definitionId)}</strong> · {service?<button className="link-button" onClick={()=>edit.service(service)}>{service.name}</button>:e.serviceId} · <Status value={reason??'已接通并开放'}/></span>;}):<span>尚未加入模型，调整模型池以选择来源服务。</span>}</div>,<div className="inline-actions"><button onClick={()=>edit.pool(p)}>调整并预览</button><button onClick={()=>setPage('capacity')}>查看保护</button></div>];
      })} empty="还没有模型池。创建模型池并选择已接入的模型服务，再开放模型。"/>
      <p className="secondary">可用数按模型去重，只表示配置就绪，不代表当前用户已获授权、拥有额度或上游实时健康。开放范围变更需预览关联影响，资金不会随模型变化转移。</p>
      <div className="actions"><button className="ghost" onClick={()=>setPage('models')}>管理模型服务</button><button className="ghost" onClick={()=>setPage('catalog')}>查看模型目录</button></div>
    </Panel>
    <Panel title="默认模型池" actions={<button className="ghost" onClick={()=>edit.defaults()}>设置默认池</button>}>
      <dl className="detail-list"><div><dt>新个人方案默认池</dt><dd>{poolName(d.settings.personalDefaultPoolId)}</dd></div><div><dt>新项目默认池</dt><dd>{poolName(d.settings.projectDefaultPoolId)}</dd></div></dl>
      <p className="secondary">仅影响后续新建或审批预填，不迁移已有权益，不发放资金。</p>
    </Panel>
  </>;
}
