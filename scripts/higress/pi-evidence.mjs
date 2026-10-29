/** Interpret completed SSE events; content markers can span multiple JSON events. */
export function completedSse(raw){
  let content='',done=false,finishReason=null,usage=null;
  for(const line of raw.split(/\r?\n/)){
    if(!line.startsWith('data:'))continue;
    const data=line.slice(5).trim();if(data==='[DONE]'){done=true;continue;}
    let value;try{value=JSON.parse(data);}catch{continue;}
    if(value.usage)usage=value.usage;
    for(const choice of value.choices??[]){if(choice.index!==undefined&&choice.index!==0)continue;if(typeof choice.delta?.content==='string')content+=choice.delta.content;if(choice.finish_reason)finishReason=choice.finish_reason;}
  }
  return {content,done,finishReason,usage};
}
