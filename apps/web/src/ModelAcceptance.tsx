import {useState} from 'react';
import type {ModelService,PlatformSnapshot,VerificationRun} from '@ai-gateway/contracts';
import {api} from './client';
import {EditorDialog,type Editor} from './components';

export function ModelAcceptance({data,service,onResult,onClose}:{data:PlatformSnapshot;service:ModelService;onResult:(run:VerificationRun)=>void;onClose:()=>void}){
  const [key]=useState(()=>crypto.randomUUID());
  const definitions=data.definitions.filter(model=>service.mappings.some(mapping=>mapping.definitionId===model.id)&&(model.kind??'chat')!=='video');
  const editor:Editor={title:`${service.name} · 实际接入验收`,description:'会发送一次真实请求。仅记录响应格式与用量证据，不修改当前连接验证结果。异步视频请在多模态工作台提交，并在任务中心核对结果。',
    initial:{definitionId:definitions[0]?.id??'',probe:'basic',maxCost:'0.1'},submitLabel:'执行一次验收',fields:[
      {key:'definitionId',label:'验收模型',type:'select',required:true,options:definitions.map(model=>({value:model.id,label:model.name}))},
      {key:'probe',label:'聊天测试项目',type:'select',options:[{value:'basic',label:'普通 Chat 响应'},{value:'stream',label:'Chat 流式与终止标记'},{value:'tools',label:'Chat 工具调用'}],show:values=>(definitions.find(model=>model.id===values.definitionId)?.kind??'chat')==='chat'},
      {key:'maxCost',label:'本次诊断费用预估上限（CNY）',type:'number',required:true,help:'按已配置上游成本限制测试请求规模。供应商实际计费按返回用量记录；未知用量保留待确认，不自动重发。未配置成本时拒绝执行。'},
    ],submit:async values=>{
      const kind=definitions.find(model=>model.id===values.definitionId)?.kind??'chat';
      const response=await api<{run:VerificationRun}>(`/api/v1/platform/services/${encodeURIComponent(service.id)}/acceptance`,{definitionId:values.definitionId,probe:kind==='chat'?values.probe:'actual',maxCost:Number(values.maxCost),idempotencyKey:key});
      onResult(response.run);return true;
    },
  };
  return <EditorDialog editor={editor} onClose={onClose}/>;
}
