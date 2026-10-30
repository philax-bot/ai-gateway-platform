import {Field,Tabs} from './components';
import {gatewayBaseUrl,openAiBaseUrl} from './client';

type Protocol='chat'|'responses'|'messages';
const protocols:{id:Protocol;label:string;path:string;help:string}[]=[
  {id:'chat',label:'Chat Completions',path:'/chat/completions',help:'在工具中选择 OpenAI Chat Completions 或 OpenAI 兼容协议。'},
  {id:'responses',label:'OpenAI Responses',path:'/responses',help:'在工具中选择 Responses 协议。OpenAI SDK 使用此 Base URL；支持 wire_api 配置的工具选择 responses。'},
  {id:'messages',label:'Anthropic Messages',path:'/messages',help:'在工具中选择 Anthropic Messages。Anthropic SDK / ANTHROPIC_BASE_URL 填此根地址，不带 /v1，客户端会补上 /v1/messages。'},
];
function example(protocol:Protocol,endpoint:string,model:string){
  const headers=protocol==='messages'?`$headers = @{ 'x-api-key' = $env:AI_API_KEY; 'anthropic-version' = '2023-06-01' }`:`$headers = @{ Authorization = "Bearer $env:AI_API_KEY" }`;
  const body=protocol==='responses'?{model,input:'你好',max_output_tokens:32,store:false}:{model,messages:[{role:'user',content:'你好'}],max_tokens:32};
  return [headers,"$body = @'",JSON.stringify(body,null,2),"'@",`Invoke-RestMethod -Method Post -Uri '${endpoint.replace(/'/g,"''")}' -Headers $headers -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body))`].join('\n');
}

export function ProtocolConnectionGuide({models,selected,onSelect}:{models:{modelId:string;name:string}[];selected:string;onSelect:(value:string)=>void}){
  const ready=models.some(m=>m.modelId===selected);
  return <section aria-label="三协议接入指引">
    <h3>编程工具接入</h3>
    <p>三种协议共用本平台签发的完整密钥和本用途开放的模型标识。按客户端使用的协议选择下方指引，填写平台网关地址。</p>
    {models.length>0?<Field spec={{key:'connection-model',label:'本密钥可见模型',type:'select',options:models.map(m=>({value:m.modelId,label:`${m.name} · ${m.modelId}`}))}} value={selected} onChange={v=>onSelect(String(v))}/>:<p className="notice warning">当前没有开放模型。请检查用途权益及模型服务，追加金额不能解决模型不可用。</p>}
    <Tabs labels={protocols.map(p=>p.label)}>{protocols.map(p=>{
      const baseUrl=p.id==='messages'?gatewayBaseUrl:openAiBaseUrl,endpoint=openAiBaseUrl+p.path;
      return <section key={p.id} aria-label={`${p.label} 接入配置`}>
        <dl className="detail-list">
          <div><dt>Base URL</dt><dd><code>{baseUrl}</code></dd></div>
          <div><dt>完整 POST 地址</dt><dd><code>{endpoint}</code></dd></div>
          <div><dt>请求认证</dt><dd><code>{p.id==='messages'?'x-api-key: 完整平台密钥':'Authorization: Bearer 完整平台密钥'}</code></dd></div>
          {p.id==='messages'&&<div><dt>API 版本请求头</dt><dd><code>anthropic-version: 2023-06-01</code></dd></div>}
        </dl>
        <p>{p.help}</p>
        <p className="secondary">Base URL 用于 SDK / 工具配置，完整 POST 地址用于直接 HTTP 请求。以上地址属于当前环境；从另一台电脑接入时需改用可访问的平台域名。</p>
        {ready?<><p className="secondary">将签发时保存的完整值放入本机 AI_API_KEY 环境变量。下方 PowerShell 示例读取该变量，不展示密钥；修改“本密钥可见模型”会同步更新示例。</p><pre className="code-example">{example(p.id,endpoint,selected)}</pre></>:models.length>0&&<p className="notice warning">请先选择本密钥可见模型，再查看对应请求示例。</p>}
      </section>;
    })}</Tabs>
    <p className="secondary">先发送一次简短请求，再按请求编号核对调用与费用。网关根据该来源已保存的协议测试结果选择原生透传或 Chat 适配；接入地址保持一致，具体客户端能力仍需实际验证。</p>
  </section>;
}
