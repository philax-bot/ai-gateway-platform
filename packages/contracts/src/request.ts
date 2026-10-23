/** Conservative transport-size estimate, not a model-specific tokenizer or proof of provider-added tokens. */
export function estimateChatInput(request:Record<string,unknown>):number {
  return new TextEncoder().encode(JSON.stringify({messages:request.messages,tools:request.tools,tool_choice:request.tool_choice,response_format:request.response_format})).length;
}
export function chatCompletionsUrl(baseUrl:string):string{
  const url=new URL(baseUrl),path=url.pathname.replace(/\/+$/,'');
  url.pathname=path.endsWith('/chat/completions')?path:path.endsWith('/v1')?`${path}/chat/completions`:`${path}/v1/chat/completions`;
  return url.toString();
}
