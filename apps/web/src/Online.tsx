import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PlatformSnapshot, PriceSnapshot } from '@ai-gateway/contracts';
import { api,gatewayBaseUrl } from './client';
import { money, Panel } from './components';
import { fundingSourceSummary,fundingSources } from './quota-view';
export const purposeLabels:Record<string,string>={not_open:'未开通模型',model_unavailable:'模型暂不可用',price_unconfigured:'价格未确认',no_quota:'无有效额度',quota_insufficient:'额度不足',ready:'可使用'};
interface Quote {decision:'allow'|'deny';reasonCode:string;sourceName?:string;reservedAmount?:number;price?:PriceSnapshot;estimatedInputTokens?:number;maxOutputTokens?:number}

export function Online({data,purposeId,onPurpose,refresh}:{data:PlatformSnapshot;purposeId:string;onPurpose:(value:string)=>void;refresh:()=>Promise<boolean>}){
  const purpose=data.purposes.find(p=>p.id===purposeId)??data.purposes[0];
  const [model,setModel]=useState(''),[input,setInput]=useState(''),[reply,setReply]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [maxOutput,setMaxOutput]=useState(String(data.settings.limits.maxOutputTokens??4096)),[quote,setQuote]=useState<Quote|null>(null);
  const abort=useRef<AbortController|null>(null),selected=purpose.models.find(m=>m.modelId===model);
  const selectedSources=selected?fundingSources(data,purpose,selected.modelId):[],sourceNames=fundingSourceSummary(selectedSources);
  const sharedNames=selected?[...new Set(selectedSources.flatMap(source=>source.batch.modelIds.filter(id=>id!==selected.modelId).map(id=>data.definitions.find(d=>d.modelId===id)?.name??id)))]:[];
  useEffect(()=>()=>abort.current?.abort(),[]);
  useEffect(()=>{setModel(purpose.models.find(m=>m.status==='ready')?.modelId??'');setQuote(null);setError('');},[purpose.id]);
  useEffect(()=>{
    let cancelled=false;setQuote(null);
    if(!model||!Number.isSafeInteger(Number(maxOutput))||Number(maxOutput)<1)return;
    const timer=setTimeout(()=>{void api<Quote>('/api/v1/platform/quote',{purpose:purpose.purpose,projectId:purpose.projectId,model,messages:[{role:'user',content:input}],max_tokens:Number(maxOutput)}).then(value=>{if(!cancelled)setQuote(value);}).catch(error=>{if(!cancelled)setError(error instanceof Error?error.message:'报价失败');});},300);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[purpose.id,model,input,maxOutput,data.revision]);
  async function send(event:FormEvent){
    event.preventDefault();if(!selected||quote?.decision!=='allow'||!quote.price)return;
    const controller=new AbortController();abort.current=controller;setBusy(true);setError('');setReply('');
    try{
      const credential=await api<{token:string}>('/api/v1/platform/online-credential',{purpose:purpose.purpose,projectId:purpose.projectId});
      const response=await fetch(`${gatewayBaseUrl}/v1/chat/completions`,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',authorization:`Bearer ${credential.token}`,'idempotency-key':crypto.randomUUID(),'x-price-version':quote.price.version},body:JSON.stringify({model,messages:[{role:'user',content:input}],max_tokens:Number(maxOutput),stream:true})});
      if(!response.ok)throw new Error(await response.text());if(!response.body)throw new Error('响应流不可用');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(true){
        const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';
        for(const line of lines){
          if(line.startsWith('event: error'))throw new Error('响应中断，请查看调用日志');
          if(!line.startsWith('data:')||line.includes('[DONE]'))continue;
          try{const value=JSON.parse(line.slice(5));if(value.choices?.[0]?.delta?.content)setReply(previous=>previous+value.choices[0].delta.content);}catch{}
        }
      }
    }catch(error){setError(controller.signal.aborted?'已取消。用量未完整返回时保留预占并进入待核对。':error instanceof Error?error.message:'请求失败');}
    finally{if(controller.signal.aborted)await new Promise(resolve=>setTimeout(resolve,350));await refresh();setBusy(false);abort.current=null;}
  }
  return <Panel title="把任务交给 AI"><form onSubmit={event=>void send(event)}>
    <p className="secondary">{purpose.name}{selected?` · ${selected.name}`:''} · 在线使用无需配置密钥</p>
    {(data.purposes.length>1||purpose.models.length>1||!selected)&&<div className="form-grid">{data.purposes.length>1&&<label>使用用途<select disabled={busy} value={purpose.id} onChange={event=>{setQuote(null);setError('');onPurpose(event.target.value);}}>{data.purposes.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}{(purpose.models.length>1||!selected)&&<label>模型<select disabled={busy} value={model} onChange={event=>{setQuote(null);setError('');setModel(event.target.value);}}><option value="">选择可用模型</option>{model&&!selected&&<option value={model} disabled>{model} · 当前暂不可用</option>}{purpose.models.map(m=><option key={m.modelId} value={m.modelId}>{m.name} · {purposeLabels[m.status]}</option>)}</select></label>}</div>}
    {selected&&<p className="secondary">该模型适用余额 {money(selected.availableAmount)} · 单次调用上限 {money(selected.largestBatchAmount)}{sourceNames?` · 来源：${sourceNames}`:''}</p>}
    {selected&&sharedNames.length>0&&<p className="secondary">同一来源批次也覆盖 {sharedNames.join('、')}，调用任一模型都从同一笔余额扣费。</p>}
    {!selected&&<div className="notice warning">{model?'所选模型当前不可用，输入已保留。请选择其他可用模型，或联系企业运营。':purposeLabels[purpose.status]}</div>}
    <label className="form-field">你需要什么帮助？<textarea rows={6} required placeholder="例如：把下面的会议记录整理为结论、待办和负责人……" value={input} onChange={event=>{setQuote(null);setError('');setInput(event.target.value);}} disabled={busy}/></label>
    {quote?.decision==='deny'&&<div className="notice warning">{({quota_insufficient:'本次预计费用超过单个来源余额。可在“回复长度与费用明细”降低输出上限，或到“我的额度”申请追加。',price_unconfigured:'模型价格尚未确认，请联系企业运营处理。',request_limit_exceeded:'输入过长或输出上限超过保护范围，请减少输入或调整输出上限。',no_quota:'当前用途没有有效额度，请到“我的额度”查看并申请。'} as Record<string,string>)[quote.reasonCode]??`暂时无法发送：${quote.reasonCode}`}</div>}
    <details className="disclosure"><summary>回复长度与费用明细</summary><label className="form-field">最多输出 Token<input type="number" min="1" step="1" disabled={busy} value={maxOutput} onChange={event=>{setQuote(null);setMaxOutput(event.target.value);}}/></label>{quote?.decision==='allow'&&<p className="secondary">来源：{quote.sourceName} · 输入保守估算 {quote.estimatedInputTokens} Token · 输出最多 {quote.maxOutputTokens} Token。发送后预占，完成后按返回用量结算，多余预占释放。</p>}</details>
    {quote?.decision==='allow'&&<p className="secondary">本次最多预占 {money(quote.reservedAmount!)}，按实际用量结算。</p>}
    <div className="actions"><button className="primary" disabled={busy||!selected||quote?.decision!=='allow'}>发送</button>{busy&&<button type="button" className="ghost" onClick={()=>abort.current?.abort()}>取消请求</button>}</div>
    {reply&&<div className="reply" aria-live="polite">{reply}</div>}{error&&<div className="notice warning" role="status">{error}</div>}
  </form></Panel>;
}
