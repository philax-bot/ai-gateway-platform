import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PlatformSnapshot, PriceSnapshot } from '@ai-gateway/contracts';
import { api,gatewayBaseUrl,gatewayFailureMessage } from './client';
import { money, Field } from './components';
import { fundingSourceSummary,fundingSources } from './quota-view';
import { AdmissionTicket, type TicketRow } from './model-surface';

export const purposeLabels:Record<string,string>={not_open:'未开通模型',model_unavailable:'模型暂不可用',price_unconfigured:'价格未确认',no_quota:'无有效额度',quota_insufficient:'额度不足',ready:'可使用'};
interface Quote {decision:'allow'|'deny';reasonCode:string;sourceName?:string;reservedAmount?:number;price?:PriceSnapshot;estimatedInputTokens?:number;estimatedOutputTokens?:number;maxOutputTokens?:number}
interface Turn {id:string;prompt:string;reply:string;requestId:string;state:'streaming'|'done'|'error'|'unknown';message?:string}
interface Receipt {requestId:string;sourceName?:string;reservedAmount?:number;stagedAt:string;state:'streaming'|'done'|'unknown'}

export interface OnlineModelRequest {purposeId:string;modelId:string;requestId:string}
const denyReasons:Record<string,string>={
  quota_insufficient:'本次预计费用超过单个来源余额。可降低输出上限，或到“我的额度”申请追加。',
  price_unconfigured:'模型价格尚未确认，请联系企业运营处理。',
  request_limit_exceeded:'输入过长或输出上限超过保护范围，请减少输入或调整输出上限。',
  no_quota:'当前用途没有有效额度，请到“我的额度”查看并申请。',
};
const examples=['把下面的会议记录整理为结论、待办和负责人','解释这段报错的原因，并给出最小修复步骤','把这段需求拆成可验收的任务清单'];
/* 流式分片可能是心跳或半包，解析失败只跳过当前分片，不中断整段回复。 */
function streamDelta(line:string):string|null{
  if(!line.startsWith('data:')||line.includes('[DONE]'))return null;
  try{
    const value=JSON.parse(line.slice(5)) as {choices?:{delta?:{content?:string}}[]};
    return value.choices?.[0]?.delta?.content??null;
  }catch{
    return null;
  }
}

export function Online({data,purposeId,onPurpose,refresh,modelRequest,setPage}:{data:PlatformSnapshot;purposeId:string;onPurpose:(value:string)=>void;refresh:()=>Promise<boolean>;modelRequest?:OnlineModelRequest;setPage:(page:string,id?:string)=>void}){
  const sourcePurpose=data.purposes.find(p=>p.id===purposeId)??data.purposes[0],purpose={...sourcePurpose,models:sourcePurpose.models.filter(m=>(data.definitions.find(d=>d.modelId===m.modelId)?.kind??'chat')==='chat')};
  const [model,setModel]=useState(''),[input,setInput]=useState(''),[turns,setTurns]=useState<Turn[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [maxOutput,setMaxOutput]=useState(''),[quote,setQuote]=useState<Quote|null>(null),[receipt,setReceipt]=useState<Receipt|null>(null);
  const lastPurpose=useRef<string|undefined>(undefined),consumedRequest=useRef<string|undefined>(undefined);
  const abort=useRef<AbortController|null>(null),composer=useRef<HTMLTextAreaElement>(null),thread=useRef<HTMLDivElement>(null);
  const selected=purpose.models.find(m=>m.modelId===model);
  const selectedSources=selected?fundingSources(data,purpose,selected.modelId):[],sourceNames=fundingSourceSummary(selectedSources);
  const sharedNames=selected?[...new Set(selectedSources.flatMap(source=>source.batch.modelIds.filter(id=>id!==selected.modelId).map(id=>data.definitions.find(d=>d.modelId===id)?.name??id)))]:[];
  const history=turns.filter(turn=>turn.state!=='error').flatMap(turn=>[{role:'user' as const,content:turn.prompt},...(turn.reply?[{role:'assistant' as const,content:turn.reply}]:[])]);
  useEffect(()=>()=>abort.current?.abort(),[]);
  useEffect(()=>{if(busy)return;
    const requested=modelRequest?.purposeId===purpose.id&&modelRequest.requestId!==consumedRequest.current;
    if(requested||lastPurpose.current!==purpose.id){
      setModel(requested?modelRequest.modelId:purpose.models.find(m=>m.status==='ready')?.modelId??'');setQuote(null);setError('');
      lastPurpose.current=purpose.id;
      if(requested)consumedRequest.current=modelRequest.requestId;
    }
  },[purpose.id,modelRequest?.requestId,busy]);
  useEffect(()=>{
    let cancelled=false;setQuote(null);
    if(!model||!input.trim()||(maxOutput!==''&&(!Number.isSafeInteger(Number(maxOutput))||Number(maxOutput)<1)))return;
    const timer=setTimeout(()=>{void api<Quote>('/api/v1/platform/quote',{purpose:purpose.purpose,projectId:purpose.projectId,model,messages:[...history,{role:'user',content:input}],...(maxOutput===''?{}:{max_tokens:Number(maxOutput)})}).then(value=>{if(!cancelled)setQuote(value);}).catch(cause=>{if(!cancelled)setError(cause instanceof Error?cause.message:'报价失败');});},300);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[purpose.id,model,input,maxOutput,data.revision,turns.length]);
  useEffect(()=>{if(busy)thread.current?.querySelector('[data-turn="streaming"]')?.scrollIntoView({block:'nearest'});},[turns,busy]);
  function update(id:string,patch:Partial<Turn>){setTurns(previous=>previous.map(turn=>turn.id===id?{...turn,...patch}:turn));}
  async function send(event:FormEvent){
    event.preventDefault();
    if(!selected||quote?.decision!=='allow'||!quote.price||busy)return;
    const controller=new AbortController(),id=crypto.randomUUID(),prompt=input.trim(),messages=[...history,{role:'user' as const,content:prompt}];
    abort.current=controller;setBusy(true);setError('');setInput('');
    setTurns(previous=>[...previous,{id,prompt,reply:'',requestId:id,state:'streaming'}]);
    setReceipt({requestId:id,sourceName:quote.sourceName,reservedAmount:quote.reservedAmount,stagedAt:new Date().toISOString(),state:'streaming'});
    let received=false,started=false;
    try{
      const credential=await api<{token:string}>('/api/v1/platform/online-credential',{purpose:purpose.purpose,projectId:purpose.projectId});
      started=true;
      const response=await fetch(`${gatewayBaseUrl}/v1/chat/completions`,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',authorization:`Bearer ${credential.token}`,'idempotency-key':id,'x-price-version':quote.price.version},body:JSON.stringify({model,messages,...(maxOutput===''?{}:{max_tokens:Number(maxOutput)}),stream:true})});
      received=true;
      if(!response.ok)throw new Error(gatewayFailureMessage(await response.text()));
      if(!response.body)throw new Error('响应流不可用');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',text='';
      while(true){
        const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';
        for(const line of lines){
          if(line.startsWith('event: error'))throw new Error('响应中断，请核对调用记录');
          const delta=streamDelta(line);
          if(delta){text+=delta;update(id,{reply:text});}
        }
      }
      update(id,{state:'done'});setReceipt(previous=>previous?{...previous,state:'done'}:previous);
    }catch(cause){
      const aborted=controller.signal.aborted,uncertain=started&&!received||aborted;
      update(id,{state:uncertain?'unknown':'error',message:aborted?'已取消。用量未完整返回时保留预占并进入待核对。':cause instanceof Error?cause.message:'请求失败'});
      setReceipt(previous=>previous?{...previous,state:'unknown'}:previous);
      setError(aborted?'已取消。用量未完整返回时保留预占并进入待核对。':cause instanceof Error?cause.message:'请求失败');
    }finally{
      if(controller.signal.aborted)await new Promise(resolve=>setTimeout(resolve,350));
      await refresh();setBusy(false);abort.current=null;
    }
  }
  const ticketRows:TicketRow[]=[];
  if(selected&&receipt) ticketRows.push({label:'来源',value:receipt.sourceName??'未标注'});
  if(quote?.decision==='allow'){
    ticketRows.push({label:'估算',value:`输入 ${quote.estimatedInputTokens} · 输出 ${quote.estimatedOutputTokens} Token`});
    ticketRows.push({label:'价格',value:`版本 ${quote.price?.version??'未知'}${quote.maxOutputTokens===undefined?' · 使用上游默认输出上限':` · 生成上限 ${quote.maxOutputTokens} Token`}`});
  }
  if(receipt){
    ticketRows.push({label:'请求编号',value:<code>{receipt.requestId}</code>});
  }
  const ticketState=busy?'pending':receipt&&receipt.state!=='streaming'?(receipt.state==='done'?'settled':'unknown'):quote?.decision==='deny'?'deny':quote?.decision==='allow'?'allow':'pending';
  const ticketAmount=receipt?.reservedAmount??(quote?.decision==='allow'?quote.reservedAmount:undefined);
  const ticketHeadline=ticketAmount===undefined?undefined:ticketState==='allow'||ticketState==='pending'?`${money(ticketAmount)} 预占`:`${money(ticketAmount)}`;
  return <div className="console-pane">
    <section className="console-card console-rail" aria-label="会话设置">
      <h2>会话设置</h2>
      <Field spec={{key:'purpose',label:'使用用途',type:'select',required:true,options:data.purposes.map(item=>({value:item.id,label:item.name}))}} value={purpose.id} onChange={value=>{setQuote(null);setReceipt(null);setError('');onPurpose(String(value));}}/>
      <Field spec={{key:'model',label:'模型',type:'select',required:true,options:purpose.models.map(item=>({value:item.modelId,label:`${item.name} · ${purposeLabels[item.status]}`})),help:selected?undefined:`${model?`${model} 当前暂不可用`:'当前用途没有可直接使用的对话模型'}`}} value={selected?model:''} onChange={value=>{setQuote(null);setReceipt(null);setError('');setModel(String(value));}}/>
      <Field spec={{key:'maxOutput',label:'最多输出 Token（可选）',type:'number',step:'1',help:'留空使用上游默认值，仍受管理员设置的输出限制约束。'}} value={maxOutput} onChange={value=>{setQuote(null);setMaxOutput(String(value));}}/>
      {selected&&<dl className="console-facts">
        <div><dt>用途余额</dt><dd>{money(selected.availableAmount)}</dd></div>
        <div><dt>单次来源上限</dt><dd>{money(selected.largestBatchAmount)}</dd></div>
        <div><dt>可用来源</dt><dd>{sourceNames||'暂无有效来源'}</dd></div>
      </dl>}
      {selected&&sharedNames.length>0&&<p className="secondary">同一来源批次也覆盖 {sharedNames.join('、')}，调用任一模型都从同一笔余额扣费。</p>}
      <div className="console-rail-actions">
        <button type="button" className="link-button" onClick={()=>setPage('quota',purpose.id)}>我的额度 ›</button>
        <button type="button" className="link-button" onClick={()=>setPage('calls')}>调用记录 ›</button>
        {turns.length>0&&<button type="button" className="link-button" disabled={busy} onClick={()=>{setTurns([]);setReceipt(null);setQuote(null);setError('');}}>开始新会话</button>}
      </div>
    </section>
    <section className="console-card console-thread" aria-label="对话" ref={thread}>
      <h2 className="sr-only">对话</h2>
      {!turns.length?<div className="console-empty">
        <strong>{`${purpose.name}${selected?` · ${selected.name}`:''}`}</strong>
        <p>{selected?purposeLabels[selected.status]==='可使用'?'可以直接发送，也可以从下面的示例开始。':purposeLabels[selected.status]:purposeLabels[purpose.status]}</p>
        <div className="console-examples">{examples.map(text=><button type="button" key={text} onClick={()=>{setInput(text);composer.current?.focus();}}>{text}</button>)}</div>
      </div>:turns.map(turn=><article className="console-turn" key={turn.id}>
        <div className="console-bubble is-user"><small>你</small><p>{turn.prompt}</p></div>
        <div className="console-bubble is-assistant" data-turn={turn.state==='streaming'?'streaming':undefined} aria-live={turn.state==='streaming'?'polite':undefined}>
          <small>模型 · {selected?.name??model}</small>
          <p>{turn.reply||(turn.state==='streaming'?'正在生成…':turn.message??'没有返回内容')}</p>
          {turn.state==='unknown'&&<p className="secondary">结果尚未确认，先按请求编号核对调用记录，避免重复生成和计费。</p>}
          {turn.state!=='streaming'&&<button type="button" className="link-button" onClick={()=>setPage('calls',turn.requestId)}>核对本次调用 ›</button>}
        </div>
      </article>)}
      <form className="console-composer" onSubmit={event=>void send(event)}>
        <label className="form-field" htmlFor="console-input">你需要什么帮助？<textarea id="console-input" ref={composer} rows={4} required placeholder="描述任务；Enter 发送，Shift + Enter 换行" value={input} onChange={event=>{setQuote(null);setError('');setInput(event.target.value);}} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit();}}} disabled={busy}/></label>
        <div className="actions">
          <button className="primary" disabled={busy||!selected||quote?.decision!=='allow'}>{busy?'正在生成…':'发送'}</button>
          {busy&&<button type="button" className="ghost" onClick={()=>abort.current?.abort()}>取消请求</button>}
          {!busy&&!input.trim()&&turns.length>0&&<span className="secondary">继续输入以开始下一轮；每一轮单独准入与计费。</span>}
        </div>
        {error&&<div className="notice warning" role="status">{error}</div>}
      </form>
    </section>
    <section className="console-ticket" aria-label="准入与结算">
      <AdmissionTicket state={ticketState} headline={ticketHeadline} rows={ticketRows}
        note={ticketState==='settled'?'已完成。费用按实际用量结算，多余预占释放；差额从原来源补扣，余额不足或用量不完整时进入待核对。':ticketState==='unknown'?'请求结果尚未确认。请先用请求编号核对调用记录，再决定是否重发。':ticketState==='deny'?(denyReasons[quote?.reasonCode??'']??`暂时无法发送：${quote?.reasonCode??'未知原因'}`):ticketState==='allow'?'发送后按实际用量结算，多余预占释放。':'填写内容后显示本次预估、来源与预占。'}
        actions={<>
          {ticketState==='deny'&&['quota_insufficient','no_quota'].includes(quote?.reasonCode??'')&&<button type="button" className="ghost" onClick={()=>setPage('quota',purpose.id)}>查看我的额度</button>}
          {ticketState==='deny'&&quote?.reasonCode==='request_limit_exceeded'&&<button type="button" className="ghost" onClick={()=>composer.current?.focus()}>调整输入或输出上限</button>}
          {ticketState==='settled'&&<button type="button" className="ghost" onClick={()=>setPage('calls',receipt?.requestId)}>查看调用记录</button>}
          {ticketState==='unknown'&&<button type="button" className="ghost" onClick={()=>setPage('calls',receipt?.requestId)}>核对调用记录</button>}
        </>}/>
      <p className="secondary">准入结论以服务端实时结果为准；当前会话只保存在本页，切换页面不重置，刷新后清空。</p>
    </section>
  </div>;
}
