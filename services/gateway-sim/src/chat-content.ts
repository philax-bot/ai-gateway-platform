import {ProtocolInputError} from './protocol-input.js';

/** Images stay provider-owned: never fetch URLs or flatten image parts into text. */
export function validateChatContent(body:Record<string,unknown>):void {
  const reject=(message:string):never=>{throw new ProtocolInputError(message,'unsupported_content');};
  if(body.audio!=null||(body.modalities!==undefined&&(!Array.isArray(body.modalities)||body.modalities.some(v=>v!=='text'))))reject('audio output requires separate metering support');
  for(const message of body.messages as unknown[]){
    if(!message||typeof message!=='object'||Array.isArray(message))reject('message must be an object');
    const content=(message as Record<string,unknown>).content;
    if(content===undefined||content===null||typeof content==='string')continue;
    if(!Array.isArray(content))reject('message content must be text or an array of text/image_url parts');
    for(const value of content as unknown[]){
      if(!value||typeof value!=='object'||Array.isArray(value))reject('content part must be an object');
      const part=value as Record<string,unknown>;
      if(part.type==='text'&&typeof part.text==='string')continue;
      if(part.type==='image_url'){
        // The upstream validates URL, MIME, detail and model-specific image constraints.
        if(part.image_url&&typeof part.image_url==='object'&&!Array.isArray(part.image_url)&&typeof (part.image_url as Record<string,unknown>).url==='string')continue;
        reject('image_url must contain a URL string');
      }
      reject('unsupported content part '+String(part.type)+'; text and image_url input are supported, audio/video require separate metering support');
    }
  }
}
