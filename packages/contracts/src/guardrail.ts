export type GuardrailCategory='custom_word'|'phone'|'identity_card'|'api_key';
export interface GuardrailPolicy {version:number;mode:'off'|'observe'|'block';modelIds:string[]|null;presets:Exclude<GuardrailCategory,'custom_word'>[];words:string[];updatedAt:string|null;updatedBy:string|null}
export interface GuardrailAssessment {version:number;matches:{ruleId:string;category:GuardrailCategory}[];error?:'scan_limit'}
export interface SafetyEvent {id:string;requestId:string;subjectId:string;purpose:string;projectId:string|null;modelId:string;policyVersion:number;action:'observe'|'block';matches:GuardrailAssessment['matches'];createdAt:string}
export interface SafetyQuery {before?:string;from?:string;to?:string;modelId?:string;subjectId?:string;requestId?:string;category?:GuardrailCategory;action?:'observe'|'block';limit?:number}
export const defaultGuardrailPolicy=():GuardrailPolicy=>({version:0,mode:'off',modelIds:null,presets:[],words:[],updatedAt:null,updatedBy:null});
export function guardrailPolicy(value?:GuardrailPolicy|null):GuardrailPolicy{return value??defaultGuardrailPolicy();}
export const guardrailApplies=(p:GuardrailPolicy,model:string)=>p.mode!=='off'&&(p.modelIds===null||p.modelIds.includes(model));
export function prepareGuardrailPolicy(current:GuardrailPolicy,value:Record<string,unknown>,actorId:string):GuardrailPolicy{
  const fail=()=>{throw Error('invalid guardrail policy');};
  if(value.expectedVersion!==current.version)throw Error('guardrail policy changed; reload before saving');
  if(!['off','observe','block'].includes(String(value.mode))||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>1000)fail();
  if(value.modelIds!==null&&(!Array.isArray(value.modelIds)||value.modelIds.length>200||!value.modelIds.length||value.modelIds.some(v=>typeof v!=='string'||!v||v.length>160)))fail();
  if(!Array.isArray(value.presets)||value.presets.some(v=>!['phone','identity_card','api_key'].includes(v)))fail();
  if(!Array.isArray(value.words)||value.words.length>200||value.words.some(v=>typeof v!=='string'))fail();
  const words=[...new Set((value.words as string[]).map(w=>w.trim().normalize('NFC').toLowerCase()).filter(Boolean))];
  if(words.some(w=>w.length<2||w.length>128)||new TextEncoder().encode(words.join('\n')).length>16384)fail();
  if(value.mode!=='off'&&!words.length&&!(value.presets as unknown[]).length)fail();
  return {version:current.version+1,mode:value.mode as GuardrailPolicy['mode'],modelIds:value.modelIds===null?null:[...new Set(value.modelIds as string[])],presets:[...new Set(value.presets as GuardrailPolicy['presets'])],words,updatedAt:new Date().toISOString(),updatedBy:actorId};
}
function identityCard(text:string){
  return [...text.matchAll(/(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[012])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g)].some(([s])=>{
    const year=+s.slice(6,10),month=+s.slice(10,12),day=+s.slice(12,14),date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day&&'10X98765432'[[...s.slice(0,17)].reduce((n,c,i)=>n+Number(c)*[7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2][i],0)%11]===s.at(-1)!.toUpperCase();
  });
}
/** Text never leaves this pure checker. All matches contain identifiers only. */
export function checkGuardrail(policy:GuardrailPolicy,model:string,body:unknown):GuardrailAssessment{
  const result:GuardrailAssessment={version:policy.version,matches:[]};if(!guardrailApplies(policy,model))return result;
  const found=new Map<string,GuardrailAssessment['matches'][number]>();let nodes=0,characters=0;
  const add=(ruleId:string,category:GuardrailCategory)=>found.set(ruleId,{ruleId,category});
  const scan=(value:unknown,depth:number,key='')=>{
    if(depth>32||++nodes>50000)throw Error('scan_limit');
    if(typeof value==='string'){
      characters+=value.length;if(characters>2097152)throw Error('scan_limit');
      const text=value.normalize('NFC');const folded=text.toLowerCase();
      policy.words.forEach((word,i)=>{if(folded.includes(word))add(`word-${i+1}`,'custom_word');});
      if(policy.presets.includes('phone')&&/(?<!\d)1[3-9](?:[ -]?\d){9}(?!\d)/.test(text))add('preset-phone','phone');
      if(policy.presets.includes('identity_card')&&identityCard(text))add('preset-identity-card','identity_card');
      if(policy.presets.includes('api_key')&&/(?<![\w-])(?:sa_|sk-)[A-Za-z0-9_-]{20,}(?![\w-])/.test(text))add('preset-api-key','api_key');
      if(key==='arguments'){try{const parsed=JSON.parse(value);if(parsed!==value)scan(parsed,depth+1);}catch(error){if(error instanceof Error&&error.message==='scan_limit')throw error;}}
    }else if(Array.isArray(value))value.forEach(v=>scan(v,depth+1));
    else if(value&&typeof value==='object')for(const [k,v]of Object.entries(value)){
      // Only the validated top-level routing identifier is excluded. Unknown
      // forwarded fields, tool descriptions/results and all roles are scanned.
      if(depth===0&&k==='model')continue;scan(k,depth+1);scan(v,depth+1,k);
    }
  };
  try{scan(body,0);}catch{result.error='scan_limit';}
  result.matches=[...found.values()];return result;
}
