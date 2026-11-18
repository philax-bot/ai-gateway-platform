import {MODEL_CAPABILITIES,MODEL_KINDS,type ModelDefinition} from '@ai-gateway/contracts';

export const modelTokens=(value:number|undefined)=>Number.isSafeInteger(value)&&Number(value)>0?`${value!.toLocaleString('zh-CN')} Token`:'未维护';

/* 模型资料只读投影：运营维护的能力标签与关键参数。供模型目录、选型详情共用。 */
export function ModelFacts({definition}:{definition?:ModelDefinition}){
  if(definition?.kind&&definition.kind!=='chat')return <dl className="model-facts"><div><dt>模型类型</dt><dd>{MODEL_KINDS[definition.kind]}</dd></div><div><dt>接入方式</dt><dd>API 调用</dd></div></dl>;
  return <dl className="model-facts"><div><dt>平台配置上下文</dt><dd>{modelTokens(definition?.contextTokens)}</dd></div><div><dt>最大输出参考</dt><dd>{modelTokens(definition?.maxOutputTokens)}</dd></div></dl>;
}

export function ModelCapabilities({definition}:{definition?:ModelDefinition}){
  const capabilities=definition?.capabilities??[];
  return <div className="model-capabilities" aria-label="运营已确认接入能力">{capabilities.length?capabilities.map(value=><span key={value} className="tag">{MODEL_CAPABILITIES[value]}</span>):<span className="secondary">接入能力未维护</span>}</div>;
}
