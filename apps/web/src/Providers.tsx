import {useState} from 'react';
import {api} from './client';
import {hasPermission} from '@ai-gateway/contracts';
import {MODEL_KINDS,modelProviders,BUILTIN_PROVIDERS} from '@ai-gateway/contracts';
import {Panel,Table,Status,date} from './components';
import {markTint,providerMark} from './provider-mark';
import type {PageProps} from './WorkspacePages';
export function Providers({data:d,edit,setPage,detail}:Pick<PageProps,'data'|'edit'|'setPage'|'detail'>){
  const [error,setError]=useState('');
  async function usage(id:string){
    try{const result=await api<{items:{version:number;calls:number;failures:number;lastUsedAt:string}[]}>(`/api/v1/platform/upstream-credentials/${encodeURIComponent(id)}/usage`);detail('上游凭据使用记录',<><p className="secondary">按准入时绑定版本汇总已转发调用，不包含目录检查和内部诊断。</p><Table headers={['版本','调用数','异常调用','最近使用']} rows={result.items.map(row=>[`v${row.version}`,row.calls,row.failures,date(row.lastUsedAt)])} empty="该凭据还没有已结束的已转发调用。"/></>);}catch(cause){setError(cause instanceof Error?cause.message:'使用记录读取失败');}
  }
  if(!hasPermission(d.actor,'models.read'))return <Panel title="供应商"><p role="alert">供应商配置仅供运营管理。</p><button onClick={()=>setPage('home')}>返回首页</button></Panel>;
  const providers=modelProviders(d.providers);
  return <>
    {error&&<p className="notice danger" role="alert">{error}</p>}
    <Panel title="供应商与接入" actions={<button disabled={!hasPermission(d.actor,'models.write')} className="primary" onClick={()=>edit.provider()}>创建供应商</button>}>
      <p>从供应商模板接入服务，再登记模型、验证连接并加入模型池。一个供应商可连接多个服务实例。</p>
      <Table headers={['供应商','适配协议 / 类型','服务连接','状态','操作']} rows={providers.map(p=>{const services=d.services.filter(s=>(s.providerId??'openai-compatible')===p.id),mark=providerMark(p.id,p.name);return [<span className="provider-cell-name"><span className="provider-mark" style={{background:markTint(mark.color),color:mark.color}} aria-hidden="true">{mark.label}</span><span><b>{p.name}</b><small className="cell-help">{p.description}</small><small className="cell-help">{BUILTIN_PROVIDERS.some(b=>b.id===p.id)?'内置模板':'自定义供应商'}</small></span></span>,<><small className="cell-help">适配 {p.adapter}</small><span className="provider-kinds">{p.kinds.map(k=><span className="tag" key={k}>{MODEL_KINDS[k]}</span>)}</span><small className="cell-help">{p.baseUrl||'接入时填写服务地址'}</small></>,<>{services.length} 个服务<small className="cell-help">{services.filter(s=>s.active&&s.verification==='passed').length} 个已启用且验证通过</small>{services.map(s=><button disabled={!hasPermission(d.actor,'models.write')} key={s.id} className="link-button" onClick={()=>edit.service(s)}>{s.name}</button>)}</>,<Status value={p.active?'active':'disabled'} label={p.active?'已启用':'已停用'}/>,<div className="inline-actions"><button disabled={!p.active||!hasPermission(d.actor,'models.write')} onClick={()=>edit.service(undefined,undefined,p.id)}>接入服务</button><button disabled={!hasPermission(d.actor,'models.write')} onClick={()=>edit.provider(p)}>编辑配置</button>{d.providers?.some(c=>c.id===p.id)&&<button className="link-button" disabled={!hasPermission(d.actor,'models.write')||services.length>0} title={services.length?'请先迁移或停用关联的模型服务与上游凭据':undefined} onClick={()=>edit.providerDelete(p)}>{BUILTIN_PROVIDERS.some(b=>b.id===p.id)?'恢复默认':'删除'}</button>}</div>];})} empty="暂无供应商，请创建供应商后接入服务。"/>
      <p className="secondary">支持类型代表适配范围；具体模型与供应商能力需实际验证。接入服务时可选择或新建托管上游凭据，密钥加密保存；服务端环境变量作为高级接入方式保留。</p>
    </Panel>
    {hasPermission(d.actor,'credentials.read')&&<Panel title="上游凭据" actions={hasPermission(d.actor,'credentials.write')&&<button className="primary" onClick={()=>edit.upstreamCredential()}>创建上游凭据</button>}>
      <p className="secondary">仅列出可复用的凭据；在模型服务里填写的“自定义密钥”只属于该服务，不在此列出。凭据由控制面加密保存。环境变量引用继续可用，托管凭据可在模型服务中选择。轮换后新调用绑定新版本，在途请求保留原版本。</p>
      <Table headers={['凭据 / 供应商','当前版本 / 掩码','允许新调用','关联服务','更新时间','操作']} rows={(d.upstreamCredentials??[]).filter(item=>!item.serviceId).map(item=>[
        <>{item.name}<small className="cell-help">{providers.find(provider=>provider.id===item.providerId)?.name??item.providerId}</small></>,
        <>v{item.currentVersion}<small className="cell-help">{item.versions.find(version=>version.version===item.currentVersion)?.masked??'未知'}</small></>,item.active?'启用':'停用',
        d.services.filter(service=>service.credentialId===item.id).map(service=>service.name).join('、')||'尚未关联',date(item.updatedAt),
        <div className="inline-actions">{hasPermission(d.actor,'credentials.write')&&<button className="link-button" onClick={()=>edit.upstreamCredential(item)}>轮换 / 状态</button>}<button className="link-button" onClick={()=>void usage(item.id)}>版本使用记录</button></div>,
      ])} empty="还没有托管凭据，可创建后在模型服务中关联。"/>
    </Panel>}
    <Panel title="后续配置"><div className="actions"><button className="ghost" onClick={()=>setPage('models')}>模型服务与验证</button><button className="ghost" onClick={()=>setPage('catalog')}>模型目录</button><button className="ghost" onClick={()=>setPage('pools')}>模型池与路由</button></div></Panel>
  </>;
}
