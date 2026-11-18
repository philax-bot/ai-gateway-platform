import {useEffect,useRef,useState,type FormEvent} from 'react';
import {MODEL_KINDS,type ModelKind,type PlatformSnapshot,type PriceSnapshot} from '@ai-gateway/contracts';
import {api,gatewayBaseUrl,gatewayFailureMessage} from './client';
import {Field,Panel,money} from './components';
import {AdmissionTicket,type TicketRow} from './model-surface';
import {MediaResult,downloadBlob} from './media-result';
import {purposeLabels,type OnlineModelRequest} from './Online';

type MediaKind=Exclude<ModelKind,'chat'>;
interface Quote {decision:'allow'|'deny';reasonMessage?:string;reservedAmount?:number;price?:PriceSnapshot;sourceName?:string}
const paths:Record<MediaKind,string>={embeddings:'embeddings',rerank:'rerank',image:'images/generations',asr:'audio/transcriptions',tts:'audio/speech',video:'videos'};
const kindOrder:MediaKind[]=['image','embeddings','rerank','asr','tts','video'];
const kindHints:Record<MediaKind,string>={
  image:'填写生成提示词与数量；返回图片地址或 Base64。',
  embeddings:'一行一条文本，批量编码为向量。',
  rerank:'一条检索查询 + 候选文档，返回相关性排序与得分。',
  asr:'上传音频文件，使用 multipart 转发给上游。',
  tts:'填写朗读文字与音色，返回音频二进制。',
  video:'提交异步任务，后台轮询；关闭页面不会停止任务。',
};

export function MultimodalWorkbench({data,purposeId,onPurpose,modelRequest,refresh,setPage}:{data:PlatformSnapshot;purposeId:string;onPurpose:(id:string)=>void;modelRequest?:OnlineModelRequest;refresh:()=>Promise<boolean>;setPage:(page:string,id?:string)=>void}){
  const [kind,setKind]=useState<MediaKind>('image'),[model,setModel]=useState('');
  const [text,setText]=useState(''),[documents,setDocuments]=useState(''),[quantity,setQuantity]=useState('1'),[voice,setVoice]=useState('alloy');
  const [file,setFile]=useState<File|null>(null),[fileName,setFileName]=useState('');
  const [quote,setQuote]=useState<Quote|null>(null),[units,setUnits]=useState<number|undefined>(undefined),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false);
  const [receipt,setReceipt]=useState<{requestId:string;sourceName?:string;reservedAmount?:number;state:'done'|'unknown'}|null>(null);
  const [result,setResult]=useState<Record<string,unknown>|null>(null),[audio,setAudio]=useState(''),[requestId,setRequestId]=useState('');
  const [outputKind,setOutputKind]=useState<MediaKind>('image'),[outputDocuments,setOutputDocuments]=useState<string[]>([]);
  const resultRef=useRef<HTMLDivElement>(null),abort=useRef<AbortController|null>(null),consumed=useRef('');
  const purpose=data.purposes.find(item=>item.id===purposeId)??data.purposes[0];
  const models=(purpose?.models??[]).filter(item=>(data.definitions.find(definition=>definition.modelId===item.modelId)?.kind??'chat')===kind);
  const selected=models.find(item=>item.modelId===model);
  useEffect(()=>()=>abort.current?.abort(),[]);
  useEffect(()=>{if(result||audio)resultRef.current?.scrollIntoView({block:'nearest',behavior:'smooth'});},[result,audio]);
  useEffect(()=>()=>{if(audio)URL.revokeObjectURL(audio);},[audio]);
  useEffect(()=>{
    if(modelRequest&&modelRequest.requestId!==consumed.current&&modelRequest.purposeId===purpose?.id){
      const requested=data.definitions.find(item=>item.modelId===modelRequest.modelId)?.kind;
      if(requested&&requested!=='chat'){setKind(requested);setModel(modelRequest.modelId);consumed.current=modelRequest.requestId;setQuote(null);setError('');return;}
    }
    setModel(current=>models.some(item=>item.modelId===current)?current:models.find(item=>item.status==='ready')?.modelId??models[0]?.modelId??'');
    setQuote(null);
  },[purpose?.id,kind,modelRequest?.requestId]);
  function change(work:()=>void){work();setQuote(null);setUnits(undefined);setReceipt(null);setError('');}
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
    setBusy(true);setError('');setQuote(null);setUnits(undefined);
    try{
      if(kind==='asr'&&!file)throw new Error('请选择音频文件。');
      const quoteText=kind==='rerank'?text+'\n'+documents:kind==='asr'?'':text;
      const estimatedUnits=kind==='image'||kind==='video'?Number(quantity):kind==='tts'?Array.from(text).length:undefined;
      const value=await api<Quote>('/api/v1/platform/quote',{purpose:purpose.purpose,projectId:purpose.projectId,model,messages:[{role:'user',content:quoteText}],estimatedUnits});
      setQuote(value);setUnits(estimatedUnits);
      if(value.decision!=='allow')setError(value.reasonMessage??'当前用途无法调用该模型，请核对额度与开放范围。');
    }catch(cause){setError(cause instanceof Error?cause.message:'预估失败');}finally{setBusy(false);}
  }
  async function generate(){
    if(!purpose||busy||quote?.decision!=='allow'||!quote.price||uncertain)return;
    const controller=new AbortController(),id=crypto.randomUUID();
    abort.current=controller;setOutputKind(kind);setOutputDocuments(documents.split('\n').filter(line=>line.trim()));
    setRequestId(id);setReceipt({requestId:id,sourceName:quote.sourceName,reservedAmount:quote.reservedAmount,state:'unknown'});setBusy(true);setError('');setResult(null);setAudio('');
    let received=false,started=false;
    try{
      const credential=await api<{token:string}>(`/api/v1/platform/online-credential`,{purpose:purpose.purpose,projectId:purpose.projectId});
      const headers:Record<string,string>={authorization:`Bearer ${credential.token}`,'x-request-id':id,'idempotency-key':id,'x-price-version':quote.price.version};
      let body:BodyInit;
      if(kind==='asr'){const form=new FormData();form.set('model',model);form.set('file',file!);body=form;}
      else{headers['Content-Type']='application/json';body=JSON.stringify(requestBody());}
      started=true;
      const response=await fetch(`${gatewayBaseUrl}/v1/${paths[kind]}`,{method:'POST',body,headers,signal:controller.signal});
      received=true;if(!response.ok)throw new Error(gatewayFailureMessage(await response.text()));
      if(kind==='tts')setAudio(URL.createObjectURL(await response.blob()));
      else setResult(await response.json());
      setReceipt(previous=>previous?{...previous,state:'done'}:previous);
      await refresh();
    }catch(cause){setError(cause instanceof Error?cause.message:'请求失败');setReceipt(previous=>previous?{...previous,state:'unknown'}:previous);if(started&&!received)setUncertain(true);}
    finally{setBusy(false);setQuote(null);setUnits(undefined);abort.current=null;}
  }
  if(!purpose)return <Panel title="多模态工作台"><div className="empty-state"><p>当前没有可用用途，请先申请模型与额度。</p><div className="actions"><button className="ghost" onClick={()=>setPage('quota')}>查看我的额度</button></div></div></Panel>;
  const ticketState=busy?'pending':receipt?(receipt.state==='done'?'settled':'unknown'):quote?.decision==='deny'?'deny':quote?.decision==='allow'?'allow':'pending';
  const ticketRows:TicketRow[]=[];
  if(receipt){
    if(receipt.sourceName)ticketRows.push({label:'来源',value:receipt.sourceName});
    if(receipt.reservedAmount!==undefined)ticketRows.push({label:'预占',value:money(receipt.reservedAmount)});
    ticketRows.push({label:'请求编号',value:<code>{receipt.requestId}</code>});
  }else if(quote?.decision==='allow'){
    if(quote.sourceName)ticketRows.push({label:'来源',value:quote.sourceName});
    if(units!==undefined)ticketRows.push({label:'预估用量',value:`${units.toLocaleString('zh-CN')} ${kind==='image'?'张':kind==='video'?'秒':kind==='tts'?'字符':''}`.trim()});
    if(quote.price)ticketRows.push({label:'价格版本',value:`v${quote.price.version}`});
  }
  return <Panel title="多模态工作台" actions={<button type="button" className="ghost" onClick={()=>setPage('media-tasks')}>视频任务中心</button>}>
    <p className="secondary">使用当前用途的模型权限与额度。先预估再调用；视频提交后由后台持续查询，关闭页面不会停止任务。</p>
    <div className="section-tabs media-tabs" aria-label="选择模型类型">{kindOrder.map(item=><button type="button" key={item} aria-pressed={kind===item} className={kind===item?'selected':''} disabled={busy} onClick={()=>change(()=>setKind(item))}>{MODEL_KINDS[item]}</button>)}</div>
    <div className="workbench">
      <form className="workbench-form" onSubmit={event=>void estimate(event)}>
        <fieldset className="form-fields" disabled={busy}>
          <p className="secondary">{kindHints[kind]}</p>
          <div className="form-grid">
            <Field spec={{key:'purpose',label:'使用用途',type:'select',required:true,options:data.purposes.map(item=>({value:item.id,label:item.name}))}} value={purpose.id} onChange={value=>change(()=>onPurpose(String(value)))}/>
            <Field spec={{key:'model',label:'当前用途模型',type:'select',required:true,options:models.map(item=>({value:item.modelId,label:`${item.name} · ${purposeLabels[item.status]}`})),help:selected?undefined:'当前用途没有此类模型'}} value={selected?model:''} onChange={value=>change(()=>setModel(String(value)))}/>
            {kind==='asr'?<Field spec={{key:'audio',label:'音频文件',type:'file',required:true,accept:'audio/*',maxBytes:19*1048576,onFile:setFile,help:'最多 19 MiB，识别费用按实际计量证据结算。'}} value={fileName} onChange={value=>change(()=>setFileName(String(value)))}/>:<Field spec={{key:'text',label:kind==='rerank'?'检索查询':kind==='embeddings'?'待编码文本（一行一条）':kind==='tts'?'朗读文字':'生成提示词',type:'textarea',required:true}} value={text} onChange={value=>change(()=>setText(String(value)))}/>}
            {kind==='rerank'&&<Field spec={{key:'documents',label:'候选文档（一行一条）',type:'textarea',required:true}} value={documents} onChange={value=>change(()=>setDocuments(String(value)))}/>}
            {(kind==='image'||kind==='video')&&<Field spec={{key:'quantity',label:kind==='image'?'图片数量（1–10）':'视频时长（秒）',type:'number',required:true}} value={quantity} onChange={value=>change(()=>setQuantity(String(value)))}/>}
            {kind==='tts'&&<Field spec={{key:'voice',label:'音色标识',required:true,help:'填写当前供应商支持的音色。'}} value={voice} onChange={value=>change(()=>setVoice(String(value)))}/>}
          </div>
          {!models.length&&<p className="notice warning">当前用途没有此类模型。可切换类型或查看模型与额度。</p>}
          {selected&&<dl className="console-facts"><div><dt>适用余额</dt><dd>{money(selected.availableAmount)}</dd></div><div><dt>单次来源余额</dt><dd>{money(selected.largestBatchAmount)}</dd></div></dl>}
          <div className="actions">
            <button className="ghost" disabled={busy||!selected||selected.status!=='ready'}>{busy?'处理中…':'预估本次调用'}</button>
            {quote?.decision==='allow'&&<button type="button" className="primary" disabled={busy||uncertain} onClick={()=>void generate()}>{kind==='video'?'提交视频任务':'执行一次调用'}</button>}
          </div>
        </fieldset>
      </form>
      <section className="workbench-result" aria-label="准入与最近一次结果">
        <AdmissionTicket state={ticketState} headline={quote?.decision==='allow'&&quote.reservedAmount!==undefined?`${money(quote.reservedAmount)} 预占`:undefined} rows={ticketRows}
          note={ticketState==='deny'?(quote?.reasonMessage??error??'当前用途无法调用该模型，请核对额度与开放范围。'):ticketState==='allow'?'实际费用按返回用量结算，未知用量进入待核对。':ticketState==='unknown'?'请求结果尚未确认，请先按请求编号核对调用记录，避免重复生成和计费。':ticketState==='settled'?(outputKind==='video'?'视频任务已提交，费用在任务完成后结算；未知用量进入待核对。':'已完成。费用按实际用量结算，多余预占释放；差额从原来源补扣，用量不完整时进入待核对。'):'填写参数后先预估，确认允许后再执行。'}>
          {uncertain&&<div className="admission-ticket-actions"><button type="button" className="ghost" onClick={()=>setPage('calls',requestId)}>核对调用记录</button><button type="button" className="link-button" onClick={()=>setUncertain(false)}>已核对，允许新请求</button></div>}
          {busy&&<p className="admission-ticket-note" role="status">正在提交请求…</p>}
        </AdmissionTicket>
        {error&&!uncertain&&<p className="notice danger" role="alert">{error}</p>}
        {(result||audio)?<div ref={resultRef}>
          <MediaResult kind={outputKind} result={result} audio={audio||undefined} documents={outputDocuments} requestId={requestId} onTask={()=>setPage('media-tasks',String(result?.id??''))}/>
          <div className="actions">
            {result&&<button type="button" className="ghost" onClick={()=>downloadBlob(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),`${requestId}.json`)}>下载结果 JSON</button>}
            {result&&outputKind==='asr'&&<button type="button" className="ghost" onClick={()=>void navigator.clipboard.writeText(String(result.text??'')).catch(()=>setError('复制失败，请手动选择文本。'))}>复制转写文本</button>}
          </div>
        </div>:<div className="workbench-placeholder"><p className="secondary">结果会显示在这里：图像看缩略图，向量看维度摘要，重排看分数顺序，识别看全文，合成看播放器，视频看任务状态。</p></div>}
      </section>
    </div>
  </Panel>;
}
