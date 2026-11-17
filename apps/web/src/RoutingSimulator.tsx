import {useState} from 'react';
import {ROUTING_STRATEGIES,type ModelPool,type PlatformSnapshot,type RoutingSimulation} from '@ai-gateway/contracts';
import {api} from './client';
import {EditorDialog,Modal,type Editor,type FieldSpec} from './components';
import {RoutingDecisionView} from './RoutingDecision';

export function RoutingSimulator({data,pool,onClose}:{data:PlatformSnapshot;pool:ModelPool;onClose:()=>void}){
  const [result,setResult]=useState<RoutingSimulation|null>(null);
  const definitions=data.definitions.filter(model=>pool.entries.some(entry=>entry.definitionId===model.id));
  const fields:FieldSpec[]=[
    {key:'modelId',label:'试算模型',type:'select',required:true,options:definitions.map(model=>({value:model.modelId,label:model.name}))},
    {key:'strategy',label:'拟议路由策略',type:'select',required:true,options:Object.entries(ROUTING_STRATEGIES).map(([value,label])=>({value,label}))},
    {key:'requestId',label:'请求编号',required:true,help:'相同编号和快照产生相同分流序值。'},
    {key:'input',label:'预计输入 Token',type:'number'},
    {key:'output',label:'输出上限 Token',type:'number',help:'留空采用模型与入口保护上限。'},
    {key:'units',label:'媒体预估数量',type:'number',help:'留空采用该映射的默认预占数量。'},
  ];
  const initial:Editor['initial']={modelId:definitions[0]?.modelId??'',strategy:pool.routing?.strategy??'stable',requestId:crypto.randomUUID(),input:'0',output:'',units:''};
  for(const entry of pool.entries){
    const service=data.services.find(item=>item.id===entry.serviceId);
    for(const [key,label,fallback] of [['weight','权重',1],['priority','优先级',0]] as const){
      const field=`${key}:${entry.serviceId}:${entry.definitionId}`;
      initial[field]=String(entry[key]??fallback);
      fields.push({key:field,label:`${service?.name??entry.serviceId} · ${label}`,type:'number',required:true,group:'试用权重与优先级',show:values=>values.modelId===definitions.find(model=>model.id===entry.definitionId)?.modelId});
    }
  }
  if(result)return <Modal title={`${pool.name} · 路由试算结果`} onClose={onClose}>
    <p className="notice">{result.notice}</p><p>试算请求 {result.requestId}</p>
    <RoutingDecisionView decision={result.decision}/>
    <div className="actions"><button className="ghost" onClick={()=>setResult(null)}>重新试算</button></div>
  </Modal>;
  const editor:Editor={title:`${pool.name} · 路由试算`,description:'读取当前流量快照，不改变配置、不预占额度、不调用上游。',fields,initial,submitLabel:'开始试算',submit:async values=>{
    const model=definitions.find(item=>item.modelId===values.modelId)!;
    const response=await api<RoutingSimulation>(`/api/v1/platform/pools/${encodeURIComponent(pool.id)}/simulate`,{
      modelId:values.modelId,requestId:values.requestId,estimatedInputTokens:Number(values.input),
      ...(values.output!==''?{maxOutputTokens:Number(values.output)}:{}),...(values.units!==''?{estimatedUnits:Number(values.units)}:{}),
      routing:{strategy:values.strategy,failureThreshold:pool.routing?.failureThreshold??0,cooldownSeconds:pool.routing?.cooldownSeconds??30},
      entries:pool.entries.filter(entry=>entry.definitionId===model.id).map(entry=>({serviceId:entry.serviceId,weight:Number(values[`weight:${entry.serviceId}:${entry.definitionId}`]),priority:Number(values[`priority:${entry.serviceId}:${entry.definitionId}`])})),
    });
    setResult(response);return false;
  }};
  return <EditorDialog editor={editor} onClose={onClose}/>;
}
