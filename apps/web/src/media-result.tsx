import {MODEL_KINDS,type ModelKind} from '@ai-gateway/contracts';
import {Table} from './components';

/* 多模态结果的读数器（组件契约 §3.26）。外壳统一，内芯按类型：
   图像看缩略图、向量看维度摘要、重排看分数顺序、识别看全文、合成看播放器、视频看任务卡。 */

export function safeMediaUrl(value:unknown):string|null {
  if(typeof value!=='string')return null;
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.toString():null;}catch{return null;}
}

export function downloadBlob(blob:Blob,name:string){
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

const imageUrl=(row:Record<string,unknown>)=>typeof row.b64_json==='string'?`data:image/png;base64,${row.b64_json}`:safeMediaUrl(row.url);
const vectorText=(value:unknown,limit=6)=>Array.isArray(value)?`${value.slice(0,limit).map(item=>typeof item==='number'?item.toFixed(4):String(item)).join(', ')}${value.length>limit?' …':''}`:'未知';

export function MediaResult({kind,result,audio,documents=[],requestId,onTask}:{kind:ModelKind;result:Record<string,unknown>|null;audio?:string;documents?:string[];requestId:string;onTask?:()=>void}){
  const images=Array.isArray(result?.data)&&kind==='image'?result.data as Record<string,unknown>[]:[];
  const vectors=Array.isArray(result?.data)&&kind==='embeddings'?result.data as Record<string,unknown>[]:[];
  const ranked=Array.isArray(result?.results)&&kind==='rerank'?result.results as Record<string,unknown>[]:[];
  const maxScore=Math.max(...ranked.map(row=>Number(row.relevance_score)||0),1);
  return <section className="media-result" aria-label={`${MODEL_KINDS[kind]}结果`}>
    <header className="media-result-head">
      <h3>{MODEL_KINDS[kind]}结果</h3>
      <small>请求编号 <code>{requestId}</code></small>
    </header>
    {kind==='image'&&(images.length?<div className="media-grid">{images.map((row,index)=>{const url=imageUrl(row);return url?<figure key={index}>
      <img className="media-preview" src={url} alt={`生成图片 ${index+1}`}/>
      <a href={url} download={`${requestId}-${index+1}.png`} target="_blank" rel="noopener noreferrer">打开或下载图片 {index+1}</a>
    </figure>:<p key={index} className="secondary">第 {index+1} 张：上游未提供可预览图片。</p>;})}</div>:<p className="secondary">上游没有返回图片。可展开原始结果核对。</p>)}
    {kind==='embeddings'&&(vectors.length?<>
      <p className="secondary">{vectors.length} 条向量{vectors[0]?.embedding?` · 维度 ${(vectors[0].embedding as unknown[]).length}`:' · 维度未知'}。这里只预览前 3 条，完整数值请下载 JSON。</p>
      <Table headers={['序号','向量维度','前 6 维预览']} rows={vectors.slice(0,3).map((row,index)=>[index,(Array.isArray(row.embedding)?row.embedding.length:'未知'),<code key={index}>{vectorText(row.embedding)}</code>])}/>
    </>:<p className="secondary">上游没有返回向量。</p>)}
    {kind==='rerank'&&(ranked.length?<ol className="media-rank">{ranked.map((row,index)=>{const score=Number(row.relevance_score)||0,source=documents[Number(row.index)];return <li key={index}>
      <span className="media-rank-no">{index+1}</span>
      <div className="media-rank-body">
        <div className="media-rank-meta"><b>{score.toFixed(4)}</b><span className="media-rank-bar" aria-hidden="true"><i style={{width:`${Math.max(2,Math.min(100,score/maxScore*100))}%`}}/></span><small>原文第 {String(row.index)} 条</small></div>
        <p>{source??'上游未标注原文'}</p>
      </div>
    </li>;})}</ol>:<p className="secondary">上游没有返回排序结果。</p>)}
    {kind==='asr'&&<>
      <p className="media-transcript">{String(result?.text??'上游未返回文本')}</p>
      <p className="secondary">识别费用按实际计量证据结算；时长与用量以上游返回为准。</p>
    </>}
    {kind==='tts'&&(audio?<>
      <audio className="media-preview" src={audio} controls/>
      <a className="link-button" href={audio} download={`${requestId}.wav`}>下载音频</a>
      <p className="secondary">音频为上游返回的实际格式；音色与采样参数按本次提交值。</p>
    </>:<p className="secondary">上游没有返回音频。</p>)}
    {kind==='video'&&<>
      <p role="status">视频任务已提交，当前状态 {String(result?.status??'未知')}。</p>
      <p className="secondary">关闭页面不会停止任务。后台持续查询结果，费用未知时进入待核对。</p>
      {onTask&&<button type="button" className="ghost" onClick={onTask}>查看任务进度与结果</button>}
    </>}
    {result&&kind!=='tts'&&<details className="disclosure"><summary>查看原始结果与用量</summary><pre className="code-block">{JSON.stringify(result,null,2)}</pre></details>}
  </section>;
}
