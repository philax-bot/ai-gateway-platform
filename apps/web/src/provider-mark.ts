/* Provider identity marks: one tinted square + short label per provider.
   Built-in vendors carry their brand colour; custom providers derive a stable
   colour from the id so the same provider always looks the same. */
export interface ProviderMark {label:string;color:string}

const BUILTIN_MARKS:Record<string,ProviderMark>={
  'openai-compatible':{label:'自',color:'#64748b'},
  openai:{label:'AI',color:'#10a37f'},
  deepseek:{label:'DS',color:'#4d6bfe'},
  siliconflow:{label:'硅',color:'#6e29f7'},
  cohere:{label:'Co',color:'#39594d'},
  jina:{label:'J',color:'#1f4fd8'},
  xai:{label:'X',color:'#0b0b0b'},
  volcengine:{label:'火',color:'#1664ff'},
};

function hueOf(seed:string){let hash=0;for(const char of seed)hash=(hash*31+char.codePointAt(0)!)%360;return hash;}

function shortLabel(name:string){
  const trimmed=name.trim();
  if(!trimmed)return '?';
  /* Latin names keep two letters, CJK names keep one character. */
  return /^[\x20-\x7e]+$/.test(trimmed)?trimmed.slice(0,2).toUpperCase():[...trimmed].slice(0,1).join('');
}

export function providerMark(id:string,name=id):ProviderMark{
  return BUILTIN_MARKS[id]??{label:shortLabel(name),color:`hsl(${hueOf(id)} 46% 40%)`};
}

export function markTint(color:string){return `${color}1f`;}

export function providerHost(baseUrl:string){
  if(!baseUrl)return '';
  try{return new URL(baseUrl).host;}catch{return baseUrl.replace(/^https?:\/\//,'').replace(/\/.*$/,'');}
}
