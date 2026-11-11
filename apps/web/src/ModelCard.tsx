import {MODEL_CAPABILITIES,type ModelDefinition,type PurposeView} from '@ai-gateway/contracts';
import {Status} from './components';
import {purposeLabels} from './Online';

export const modelTokens=(value:number|undefined)=>Number.isSafeInteger(value)&&Number(value)>0?`${value!.toLocaleString('zh-CN')} Token`:'未维护';
export function ModelFacts({definition}:{definition?:ModelDefinition}){
  return <dl className="model-facts"><div><dt>平台配置上下文</dt><dd>{modelTokens(definition?.contextTokens)}</dd></div><div><dt>最大输出参考</dt><dd>{modelTokens(definition?.maxOutputTokens)}</dd></div></dl>;
}
export function ModelCapabilities({definition}:{definition?:ModelDefinition}){
  const capabilities=definition?.capabilities??[];
  return <div className="model-capabilities" aria-label="运营已确认接入能力">{capabilities.length?capabilities.map(value=><span key={value} className="tag">{MODEL_CAPABILITIES[value]}</span>):<span className="secondary">接入能力未维护</span>}</div>;
}
export function ModelCard({definition,model,onDetail,onUse,onQuota,onCopy}:{definition?:ModelDefinition;model:PurposeView['models'][number];onDetail:()=>void;onUse:()=>void;onQuota:()=>void;onCopy:()=>void}){
  const ready=model.status==='ready',quota=['no_quota','quota_insufficient'].includes(model.status);
  return <article className="resource-card model-card" aria-label={model.name}>
    <div className="model-card-top"><span className="secondary">{definition?.vendor||'厂商未维护'}</span><Status value={ready?'active':'unavailable'} label={purposeLabels[model.status]}/></div>
    <h3>{model.name}</h3><div className="model-identifier"><code>{model.modelId}</code><button type="button" className="link-button" onClick={onCopy} aria-label={`复制 ${model.name} 模型标识`}>复制</button></div>
    <p className="model-description">{definition?.description||'能力说明尚未维护，可联系企业运营了解适用任务。'}</p>
    <ModelCapabilities definition={definition}/><ModelFacts definition={definition}/>
    {!ready&&<p className="secondary model-blocked">{quota?'使用范围已保留，请查看当前用途的额度来源。':'当前接入或价格暂未就绪，请联系企业运营。'}</p>}
    <div className="actions model-card-actions"><button type="button" className="ghost" onClick={onDetail}>查看详情</button>{ready?<button type="button" className="primary" onClick={onUse}>使用此模型</button>:quota?<button type="button" className="ghost" onClick={onQuota}>查看额度</button>:<button type="button" className="ghost" disabled title={purposeLabels[model.status]}>暂不可用</button>}</div>
  </article>;
}
