import {useEffect,useRef,useState,type FormEvent} from 'react';
import {MODEL_KINDS,type ModelKind,type PlatformSnapshot,type PriceSnapshot} from '@ai-gateway/contracts';
import {api,gatewayBaseUrl,gatewayFailureMessage} from './client';
import {Field,Panel,Table,money} from './components';
import {purposeLabels,type OnlineModelRequest} from './Online';

type MediaKind=Exclude<ModelKind,'chat'>;
interface Quote {decision:'allow'|'deny';reasonMessage?:string;reservedAmount?:number;price?:PriceSnapshot;sourceName?:string}
const paths:Record<MediaKind,string>={embeddings:'embeddings',rerank:'rerank',image:'images/generations',asr:'audio/transcriptions',tts:'audio/speech',video:'videos'};
export function safeMediaUrl(value:unknown):string|null {
  if(typeof value!=='string')return null;
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.toString():null;}catch{return null;}
}
export function downloadBlob(blob:Blob,name:string){
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function MultimodalWorkbench({data,purposeId,onPurpose,modelRequest,refresh,setPage}:{data:PlatformSnapshot;purposeId:string;onPurpose:(id:string)=>void;modelRequest?:OnlineModelRequest;refresh:()=>Promise<boolean>;setPage:(page:string,id?:string)=>void}){
  const [kind,setKind]=useState<MediaKind>('image'),[model,setModel]=useState('');
  const [text,setText]=useState(''),[documents,setDocuments]=useState(''),[quantity,setQuantity]=useState('1'),[voice,setVoice]=useState('alloy');
  const [file,setFile]=useState<File|null>(null),[fileName,setFileName]=useState('');
  const [quote,setQuote]=useState<Quote|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false);
  const [result,setResult]=useState<Record<string,unknown>|null>(null),[audio,setAudio]=useState(''),[requestId,setRequestId]=useState('');
  const [outputKind,setOutputKind]=useState<MediaKind>('image'),[outputDocuments,setOutputDocuments]=useState<string[]>([]);
  const resultRef=useRef<HTMLDivElement>(null);
  const abort=useRef<AbortController|null>(null),consumed=useRef('');
  const purpose=data.purposes.find(item=>item.id===purposeId)??data.purposes[0];
  const models=(purpose?.models??[]).filter(item=>(data.definitions.find(definition=>definition.modelId===item.modelId)?.kind??'chat')===kind);
  const selected=models.find(item=>item.modelId===model);
  useEffect(()=>()=>abort.current?.abort(),[]);
  useEffect(()=>{if(result||audio)resultRef.current?.scrollIntoView({block:'start',behavior:'smooth'});},[result,audio]);
  useEffect(()=>()=>{if(audio)URL.revokeObjectURL(audio);},[audio]);
  useEffect(()=>{
    if(modelRequest&&modelRequest.requestId!==consumed.current&&modelRequest.purposeId===purpose?.id){
      const requested=data.definitions.find(item=>item.modelId===modelRequest.modelId)?.kind;
      if(requested&&requested!=='chat'){setKind(requested);setModel(modelRequest.modelId);consumed.current=modelRequest.requestId;setQuote(null);return;}
    }
    setModel(current=>models.some(item=>item.modelId===current)?current:models.find(item=>item.status==='ready')?.modelId??models[0]?.modelId??'');
    setQuote(null);
  },[purpose?.id,kind,modelRequest?.requestId]);
  function change(work:()=>void){work();setQuote(null);setError('');}
  function requestBody(){
    const body:Record<string,unknown>={model};
    if(kind==='embeddings')body.input=text.split('\n').filter(line=>line.trim());
    if(kind==='rerank')Object.assign(body,{query:text,documents:documents.split('\n').filter(line=>line.trim())});
    if(kind==='image')Object.assign(body,{prompt:text,n:Number(quantity)});
    if(kind==='video')Object.assign(body,{prompt:text,seconds:Number(quantity)});
    if(kind==='tts')Object.assign(body,{input:text,voice,response_format:'wav'});
    return body;
  }
  async function estimate(event:FormEvent){
    event.preventDefault();if(!purpose||busy)return;
    setBusy(true);setError('');setQuote(null);
    try{
      if(kind==='asr'&&!file)throw new Error('请选择音频文件。');
      const quoteText=kind==='rerank'?text+'\n'+documents:kind==='asr'?'':text;
      const units=kind==='image'||kind==='video'?Number(quantity):kind==='tts'?Array.from(text).length:undefined;
      const value=await api<Quote>('/api/v1/platform/quote',{purpose:purpose.purpose,projectId:purpose.projectId,model,messages:[{role:'user',content:quoteText}],estimatedUnits:units});
      setQuote(value);if(value.decision!=='allow')setError(value.reasonMessage??'当前用途无法调用该模型，请核对额度与开放范围。');
    }catch(cause){setError(cause instanceof Error?cause.message:'预估失败');}finally{setBusy(false);}
  }
  async function generate(){
    if(!purpose||busy||quote?.decision!=='allow'||!quote.price||uncertain)return;
    const controller=new AbortController(),id=crypto.randomUUID();abort.current=controller;setOutputKind(kind);setOutputDocuments(documents.split('\n').filter(line=>line.trim()));setRequestId(id);setBusy(true);setError('');setResult(null);setAudio('');
    let received=false,started=false;
    try{
      const credential=await api<{token:string}>('/api/v1/platform/online-credential',{purpose:purpose.purpose,projectId:purpose.projectId});
      const headers:Record<string,string>={authorization:`Bearer ${credential.token}`,'x-request-id':id,'idempotency-key':id,'x-price-version':quote.price.version};
      let body:BodyInit;
      if(kind==='asr'){const form=new FormData();form.set('model',model);form.set('file',file!);body=form;}
      else{headers['Content-Type']='application/json';body=JSON.stringify(requestBody());}
      started=true;
      const response=await fetch(`${gatewayBaseUrl}/v1/${paths[kind]}`,{method:'POST',body,headers,signal:controller.signal});
      received=true;if(!response.ok)throw new Error(gatewayFailureMessage(await response.text()));
      if(kind==='tts')setAudio(URL.createObjectURL(await response.blob()));
      else setResult(await response.json());
      await refresh();
    }catch(cause){setError(cause instanceof Error?cause.message:'请求失败');if(started&&!received)setUncertain(true);}
    finally{setBusy(false);setQuote(null);abort.current=null;}
  }
  if(!purpose)return <Panel title="多模态工作台"><p>当前没有可用用途，请先申请模型与额度。</p><button className="ghost" onClick={()=>setPage('quota')}>查看我的额度</button></Panel>;
  const imageRows=Array.isArray(result?.data)&&outputKind==='image'?result.data:[];
  const reranked=Array.isArray(result?.results)&&outputKind==='rerank'?result.results:[];
  return <>
    <Panel title="多模态调用" actions={<button className="ghost" onClick={()=>setPage('media-tasks')}>查看视频任务</button>}>
      <p className="secondary">使用当前用途的模型权限与额度。先预估再调用，视频提交后由后台持续查询，关闭页面不会停止任务。</p>
      {error&&<p className="notice danger" role="alert">{error}</p>}
      {uncertain&&<div className="notice warning"><p>请求结果尚未确认，请先按请求编号核对调用记录，避免重复生成和计费。</p><button className="ghost" onClick={()=>setPage('calls')}>查看调用记录</button><button className="ghost" onClick={()=>setUncertain(false)}>已核对记录，允许新请求</button></div>}
      <form onSubmit={estimate}><fieldset className="form-fields" disabled={busy}>
        <div className="form-grid">
          <Field spec={{key:'purpose',label:'使用用途',type:'select',required:true,options:data.purposes.map(item=>({value:item.id,label:item.name}))}} value={purpose.id} onChange={value=>change(()=>onPurpose(String(value)))}/>
          <Field spec={{key:'kind',label:'模型类型',type:'select',required:true,options:Object.entries(MODEL_KINDS).filter(([value])=>value!=='chat').map(([value,label])=>({value,label}))}} value={kind} onChange={value=>change(()=>setKind(value as MediaKind))}/>
          <Field spec={{key:'model',label:'当前用途模型',type:'select',required:true,options:models.map(item=>({value:item.modelId,label:`${item.name} · ${purposeLabels[item.status]}`}))}} value={model} onChange={value=>change(()=>setModel(String(value)))}/>
          {kind==='asr'?<Field spec={{key:'audio',label:'音频文件',type:'file',required:true,accept:'audio/*',maxBytes:19*1048576,onFile:setFile,help:'最多 19 MiB，识别费用按实际计量证据结算。'}} value={fileName} onChange={value=>change(()=>setFileName(String(value)))}/>:<Field spec={{key:'text',label:kind==='rerank'?'检索查询':kind==='embeddings'?'待编码文本（一行一条）':kind==='tts'?'朗读文字':'生成提示词',type:'textarea',required:true}} value={text} onChange={value=>change(()=>setText(String(value)))}/>}
          {kind==='rerank'&&<Field spec={{key:'documents',label:'候选文档（一行一条）',type:'textarea',required:true}} value={documents} onChange={value=>change(()=>setDocuments(String(value)))}/>}
          {(kind==='image'||kind==='video')&&<Field spec={{key:'quantity',label:kind==='image'?'图片数量（1–10）':'视频时长（秒）',type:'number',required:true}} value={quantity} onChange={value=>change(()=>setQuantity(String(value)))}/>}
          {kind==='tts'&&<Field spec={{key:'voice',label:'音色标识',required:true,help:'填写当前供应商支持的音色。'}} value={voice} onChange={value=>change(()=>setVoice(String(value)))}/>}
        </div>
        {!models.length&&<p className="notice warning">当前用途没有此类模型。可切换类型或查看模型与额度。</p>}
        {selected&&<p className="secondary">适用余额 {money(selected.availableAmount)} · 单次来源余额 {money(selected.largestBatchAmount)}</p>}
        <div className="actions"><button className="ghost" disabled={busy||!selected||selected.status!=='ready'}>{busy?'处理中…':'预估本次调用'}</button>{quote?.decision==='allow'&&<button type="button" className="primary" disabled={busy||uncertain} onClick={()=>void generate()}>{kind==='video'?'提交视频任务':'执行一次调用'}</button>}</div>
      </fieldset></form>
      {quote?.decision==='allow'&&<p className="notice" role="status">预计预占 {money(quote.reservedAmount??0)} · {quote.sourceName}。实际费用按返回用量结算，未知用量进入待核对。</p>}
      {requestId&&<p className="secondary">本次请求编号 <code>{requestId}</code></p>}
    </Panel>
    {(result||audio)&&<div ref={resultRef}><Panel title={`最近一次结果 · ${MODEL_KINDS[outputKind]}`} actions={result&&<button className="ghost" onClick={()=>downloadBlob(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),`${requestId}.json`)}>下载结果 JSON</button>}>
      {audio&&<><audio className="media-preview" src={audio} controls/><a className="link-button" href={audio} download={`${requestId}.wav`}>下载音频</a></>}
      {outputKind==='asr'&&<p>{String(result?.text??'上游未返回文本')}</p>}
      {imageRows.map((row,index)=>{const item=row as Record<string,unknown>,url=typeof item.b64_json==='string'?`data:image/png;base64,${item.b64_json}`:safeMediaUrl(item.url);return url?<div key={index}><img className="media-preview" src={url} alt={`生成图片 ${index+1}`} onError={()=>setError('图片地址或内容无法预览，可下载 JSON 核对供应商返回结果。')}/><a href={url} download={`${requestId}-${index+1}.png`} target="_blank" rel="noopener noreferrer">打开或下载图片 {index+1}</a></div>:<p key={index}>上游未提供可预览图片。</p>;})}
      {outputKind==='embeddings'&&<Table headers={['序号','向量维度']} rows={(Array.isArray(result?.data)?result.data:[]).map((row,index)=>[index,Array.isArray((row as Record<string,unknown>).embedding)?((row as Record<string,unknown>).embedding as unknown[]).length:'未知'])}/>}
      {outputKind==='rerank'&&<Table headers={['原文序号','相关性得分','候选文档']} rows={reranked.map(row=>{const item=row as Record<string,unknown>;return [String(item.index),String(item.relevance_score),outputDocuments[Number(item.index)]??'上游未标注原文'];})}/>}
      {outputKind==='video'&&<><p role="status">视频任务已提交，当前状态 {String(result?.status??'未知')}。</p><button className="primary" onClick={()=>setPage('media-tasks',String(result?.id))}>查看任务进度与结果</button></>}
      {result&&outputKind!=='video'&&<details className="disclosure"><summary>查看原始结果与用量</summary><pre className="code-block">{JSON.stringify(result,null,2)}</pre></details>}
    </Panel></div>}
  </>;
}
