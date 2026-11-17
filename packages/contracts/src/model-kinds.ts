export const MODEL_KINDS={chat:'对话',embeddings:'向量嵌入',rerank:'重排序',image:'图片生成',asr:'语音识别',tts:'语音合成',video:'视频生成'} as const;
export type ModelKind=keyof typeof MODEL_KINDS;
export const METER_UNITS={per_request:'次',per_image:'张',per_second:'秒',per_1000_characters:'千字符'} as const;
export type MeterUnit=keyof typeof METER_UNITS;
export interface MeterPrice {unit:MeterUnit;price:number;costPrice?:number|null;estimatedUnits:number;maxUnits:number}
export interface MeteredUsage {unit:MeterUnit;quantity:number}
export function meteredUsageText(usage:MeteredUsage){return `${usage.quantity} ${usage.unit==='per_1000_characters'?'字符':METER_UNITS[usage.unit]}`;}
export const MODEL_API_PATHS:Record<ModelKind,string>={chat:'/v1/chat/completions',embeddings:'/v1/embeddings',rerank:'/v1/rerank',image:'/v1/images/generations',asr:'/v1/audio/transcriptions',tts:'/v1/audio/speech',video:'/v1/videos'};
export interface ModelProvider {
  id:string;name:string;description:string;baseUrl:string;adapter:'openai'|'cohere'|'xai'|'volcengine';kinds:ModelKind[];active:boolean;
}
export const BUILTIN_PROVIDERS:readonly ModelProvider[]=[
  {id:'openai-compatible',name:'OpenAI 兼容服务',description:'兼容接口与自建推理服务；按实际模型能力配置。',baseUrl:'',adapter:'openai',kinds:['chat','embeddings','rerank','image','asr','tts','video'],active:true},
  {id:'openai',name:'OpenAI',description:'官方对话、向量、图像、语音及视频接口。',baseUrl:'https://api.openai.com/v1',adapter:'openai',kinds:['chat','embeddings','image','asr','tts','video'],active:true},
  {id:'deepseek',name:'DeepSeek',description:'官方 OpenAI 兼容对话接口。',baseUrl:'https://api.deepseek.com',adapter:'openai',kinds:['chat'],active:true},
  {id:'siliconflow',name:'硅基流动',description:'多类型兼容接口；具体模型与参数以实际服务为准。',baseUrl:'https://api.siliconflow.cn/v1',adapter:'openai',kinds:['chat','embeddings','rerank','image','asr','tts'],active:true},
  {id:'cohere',name:'Cohere',description:'原生 Rerank 接口。',baseUrl:'https://api.cohere.com/v2',adapter:'cohere',kinds:['rerank'],active:true},
  {id:'jina',name:'Jina AI',description:'Embedding 与 Rerank 接口。',baseUrl:'https://api.jina.ai/v1',adapter:'openai',kinds:['embeddings','rerank'],active:true},
  {id:'xai',name:'xAI',description:'对话、图像和异步 Grok 视频接口。',baseUrl:'https://api.x.ai/v1',adapter:'xai',kinds:['chat','image','video'],active:true},
  {id:'volcengine',name:'火山方舟',description:'兼容对话、Embedding 与原生异步视频任务。',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',adapter:'volcengine',kinds:['chat','embeddings','video'],active:true},
];
export function modelProviders(supplied:ModelProvider[]|null=[]):ModelProvider[]{const custom=supplied??[];return [...BUILTIN_PROVIDERS.filter(p=>!custom.some(c=>c.id===p.id)),...custom];}
export const ROUTING_STRATEGIES={stable:'稳定分流',weighted:'加权分流',least_busy:'低并发优先',usage:'低容量占用优先',latency:'低延迟优先',priority:'主备优先'} as const;
export interface PoolRouting {strategy:keyof typeof ROUTING_STRATEGIES;failureThreshold:number;cooldownSeconds:number}
