import {createHash} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {estimateProtocolInput,isRequestReference,type ModelKind} from '@ai-gateway/contracts';
export interface MediaInput {body:Record<string,unknown>;form?:FormData;fingerprint:string;tokens:number;units?:number;maxInputTokens?:number}
export async function readMediaInput(request:IncomingMessage,kind:ModelKind):Promise<MediaInput>{
  const chunks:Buffer[]=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>20*1048576)throw Error('request body exceeds 20 MiB');chunks.push(Buffer.from(chunk));}
  const raw=Buffer.concat(chunks),contentType=String(request.headers['content-type']??'application/json');let form:FormData|undefined,body:Record<string,unknown>;
  if(kind==='asr'){
    if(!contentType.startsWith('multipart/form-data;'))throw Error('ASR requires multipart/form-data with model and file');
    form=await new Request('http://gateway.local',{method:'POST',headers:{'content-type':contentType},body:new Uint8Array(raw)}).formData();
    body=Object.fromEntries([...form.entries()].filter(([,value])=>typeof value==='string'));
    const file=form.get('file');if(!(file instanceof Blob)||!file.size)throw Error('a nonempty audio file is required');
    if(!form.has('response_format'))form.set('response_format','verbose_json');
  }else{const value:unknown=JSON.parse(raw.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('body must be a JSON object');body=value as Record<string,unknown>;}
  if(!isRequestReference(body.model))throw Error('model must be a valid identifier of at most 160 characters');if(body.stream===true)throw Error('streaming is not supported for this endpoint');
  let text='',units:number|undefined;
  if(kind==='embeddings'){
    const input=body.input;
    if(typeof input==='string')text=input;
    else if(Array.isArray(input)&&input.length&&input.every(v=>typeof v==='string'))text=input.join('\n');
    else if(Array.isArray(input)&&input.length&&input.every(v=>Number.isSafeInteger(v)&&v>=0))text='';
    else if(Array.isArray(input)&&input.length&&input.every(v=>Array.isArray(v)&&v.length&&v.every(n=>Number.isSafeInteger(n)&&n>=0)))text='';
    else throw Error('input must contain text or token arrays');
  }else if(kind==='rerank'){
    if(typeof body.query!=='string'||!body.query.trim()||!Array.isArray(body.documents)||!body.documents.length||body.documents.some(v=>typeof v!=='string'&&!(v&&typeof v==='object'&&typeof v.text==='string')))throw Error('query and nonempty documents are required');
    text=body.query+'\n'+body.documents.map(v=>typeof v==='string'?v:v.text).join('\n');
  }else if(kind==='image'||kind==='video'){
    if(typeof body.prompt!=='string'||!body.prompt.trim())throw Error('prompt is required');text=body.prompt;
    if(kind==='image'){units=Number(body.n??1);if(!Number.isSafeInteger(units)||units<1||units>10)throw Error('n must be 1–10');}
    else if(body.seconds!==undefined||body.duration!==undefined){units=Number(body.seconds??body.duration);if(!Number.isFinite(units)||units<=0||units>3600)throw Error('duration must be 0–3600 seconds');}
  }else if(kind==='tts'){
    if(typeof body.input!=='string'||!body.input.trim()||typeof body.voice!=='string'||!body.voice.trim())throw Error('input and voice are required');text=body.input;units=Array.from(text).length;
  }else text=String(body.prompt??'');
  const tokenArrays=kind==='embeddings'&&Array.isArray(body.input)&&typeof body.input[0]!=='string'?body.input:null;
  let tokens=tokenArrays?(Array.isArray(tokenArrays[0])?(tokenArrays as number[][]).reduce((n,a)=>n+a.length,0):tokenArrays.length):estimateProtocolInput({model:body.model,messages:[{role:'user',content:text}]},'chat');
  let maxInputTokens:number|undefined;if(kind==='embeddings'){if(tokenArrays)maxInputTokens=Array.isArray(tokenArrays[0])?Math.max(...(tokenArrays as number[][]).map(a=>a.length)):tokenArrays.length;else if(Array.isArray(body.input)){const counts=(body.input as string[]).map(content=>estimateProtocolInput({messages:[{role:'user',content}]},'chat'));maxInputTokens=Math.max(...counts);tokens=counts.reduce((a,b)=>a+b,0);}else maxInputTokens=tokens;}
  return {maxInputTokens,body,form,fingerprint:createHash('sha256').update(kind).update(raw).digest('hex'),tokens,units};
}
export function mediaTokenUsage(value:unknown):{inputTokens:number;outputTokens:number;cachedInputTokens:number}|null {
  const r=value&&typeof value==='object'?value as Record<string,unknown>:{},u=r.usage as Record<string,unknown>|undefined;
  const input=u?.prompt_tokens??u?.input_tokens,output=u?.completion_tokens??u?.output_tokens??0;
  if(typeof input!=='number'||typeof output!=='number'||!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0)return null;
  return {inputTokens:input,outputTokens:output,cachedInputTokens:0};
}
export function validMediaResponse(kind:ModelKind,value:unknown,contentType:string,size:number){
  const r=value&&typeof value==='object'?value as Record<string,unknown>:{};if(r.error||!size)return false;
  if(kind==='tts')return contentType.startsWith('audio/')||contentType.startsWith('application/octet-stream');
  if(kind==='asr')return contentType.startsWith('text/plain')||typeof r.text==='string';
  if(kind==='embeddings')return Array.isArray(r.data)&&r.data.every(v=>v&&typeof v==='object'&&(Array.isArray(v.embedding)||typeof v.embedding==='string'));
  if(kind==='rerank')return Array.isArray(r.results)||Array.isArray(r.data);
  if(kind==='image')return Array.isArray(r.data);
  return true;
}
