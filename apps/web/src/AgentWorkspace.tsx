import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {ManagedAgentView} from '@ai-gateway/contracts';
import {api,ApiError,controlPlaneBaseUrl} from './client';
import {Field,Modal,Panel} from './components';

const endpoint='/api/v1/platform/agent-instances';
const statuses:Record<string,string>={running:'可使用',stopped:'已停止',provisioning:'正在启动',stopping:'正在停止',failed:'需要恢复'};
interface Message {role:'user'|'assistant';text:string}
export function AgentWorkspace({refreshWorkspace,setPage}:{refreshWorkspace:()=>Promise<boolean>;setPage:(page:string)=>void}){
  const [view,setView]=useState<ManagedAgentView|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[chatting,setChatting]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [text,setText]=useState(''),[threadId,setThreadId]=useState<string>(),[messages,setMessages]=useState<Message[]>([]),[confirm,setConfirm]=useState<'stop'|'rotate-key'|null>(null);
  const abort=useRef<AbortController|null>(null),alive=useRef(true);
  const instance=view?.instance,ready=view?.enabled&&instance?.status==='running'&&instance.key?.status==='active';
  async function failed(error:unknown){if(!alive.current)return;setError(error instanceof Error?error.message:'操作暂时无法完成，请重试。');if(error instanceof ApiError&&[401,403].includes(error.status))await refreshWorkspace();}
  async function load(){setLoading(true);setError('');try{const next=await api<ManagedAgentView>(`${endpoint}/self`);if(alive.current)setView(next);}catch(e){await failed(e);}finally{if(alive.current)setLoading(false);}}
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;abort.current?.abort();};},[]);
  async function change(action:'ensure'|'stop'|'rotate-key'){
    if(busy||chatting)return;setBusy(true);setError('');setNotice('');
    try{const path=action==='ensure'?'self/ensure':`${instance!.id}/${action}`,next=await api<ManagedAgentView>(`${endpoint}/${path}`,{idempotencyKey:crypto.randomUUID()});if(alive.current){setView(next);setNotice(action==='stop'?'Agent 已停止，专用密钥已吊销。':action==='rotate-key'?'专用密钥已更新。':'Agent 已就绪，可以发送任务。');}}
    catch(e){await failed(e);try{const next=await api<ManagedAgentView>(`${endpoint}/self`);if(alive.current)setView(next);}catch{/* preserve the action error */}}
    finally{if(alive.current){setBusy(false);setConfirm(null);}}
  }
  async function send(event:FormEvent){
    event.preventDefault();if(!ready||chatting||busy||!text.trim())return;
    const controller=new AbortController();abort.current=controller;setChatting(true);setError('');setNotice('');const input=text;setText('');setMessages(m=>[...m.slice(-48),{role:'user',text:input},{role:'assistant',text:''}]);
    let done=false;
    try{
      const r=await fetch(`${controlPlaneBaseUrl}${endpoint}/self/chat`,{method:'POST',credentials:'include',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({text:input,...(threadId?{threadId}:{})})});
      if(!r.ok){if([401,403].includes(r.status))await refreshWorkspace();const data=await r.json().catch(()=>null);throw Error(r.status===409?'Agent 状态已变化或任务仍在进行，请刷新后重试。':r.status===401?'登录已过期，请重新登录。':r.status===403?'当前账号无法使用 Agent，请联系管理员。':typeof data?.message==='string'&&/[\u4e00-\u9fff]/.test(data.message)?data.message:'任务暂时无法发送，请稍后重试。');}
      if(!r.body)throw Error('响应流不可用，请刷新后重试。');
      const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';
        for(const line of lines){if(!line.startsWith('data:'))continue;const f=JSON.parse(line.slice(5));if(!alive.current)continue;
          if(f.type==='session')setThreadId(f.threadId);
          else if(f.type==='token'){setNotice('');setMessages(m=>m.map((message,i)=>i===m.length-1?{...message,text:message.text+f.content}:message));}
          else if(f.type==='tool')setNotice('Agent 正在使用工具…');
          else if(f.type==='error')setError(f.message);
          else if(f.type==='done'){done=true;setNotice(f.cancelled?'任务已取消，已产生的用量仍会结算。':'任务已结束，费用请查看调用记录。');}
        }
      }
      if(!done&&!controller.signal.aborted)throw Error('响应已中断，请刷新状态并查看调用记录。');
    }catch(e){if(alive.current)setError(controller.signal.aborted?'已请求取消。已产生的用量仍会结算，用量不完整时进入待核对。':e instanceof Error?e.message:'任务失败，请重试。');}
    finally{abort.current=null;if(alive.current){setChatting(false);await refreshWorkspace();}}
  }
  return <>
    <Panel title="在线 Agent" actions={<button className="ghost" disabled={loading||busy||chatting} onClick={()=>void load()}>刷新状态</button>}>
      <p className="secondary">使用个人模型额度完成多步任务。每次模型调用都按平台规则预占与结算，可在调用记录中核对费用。</p>
      {loading&&<p role="status">正在读取 Agent 状态…</p>}
      {!loading&&view&&!view.enabled&&<div className="notice warning" role="status">当前环境暂未开放在线 Agent，请联系平台管理员。</div>}
      {!loading&&view?.enabled&&<>
        <p role="status"><span className={`tag ${ready?'success':'warning'}`}>{busy?'正在处理…':instance?instance.status==='running'&&!ready?'需要恢复':statuses[instance.status]??'状态待确认':'尚未启动'}</span>{instance?.key&&<span className="secondary"> · 专用密钥 {instance.key.masked}</span>}</p>
        {instance?.status==='failed'&&<div className="notice warning">Agent 未就绪，请重新启动；启动失败时专用密钥会被吊销，可恢复后重试。</div>}
        <div className="actions">{!ready&&<button className="primary" disabled={busy||loading} onClick={()=>void change('ensure')}>{busy?'正在启动…':instance?'重新启动':'启动 Agent'}</button>}
          {ready&&<><button className="danger-button" disabled={busy||chatting} onClick={()=>setConfirm('stop')}>停止 Agent</button><button className="danger-button" disabled={busy||chatting} onClick={()=>setConfirm('rotate-key')}>轮换专用密钥</button></>}
          <button className="ghost" onClick={()=>setPage('quota')}>查看个人额度</button><button className="ghost" onClick={()=>setPage('calls')}>查看调用记录</button>
        </div>
      </>}
      {error&&<div className="notice danger" role="alert">{error}</div>}{notice&&<p className="notice" role="status">{notice}</p>}
    </Panel>
    {ready&&<Panel title="当前会话" actions={<button className="ghost" disabled={busy||chatting||!messages.length} onClick={()=>{setThreadId(undefined);setMessages([]);setNotice('已开始新会话。');setError('');}}>新建会话</button>}>
      {!messages.length&&<p className="secondary">描述你的目标，Agent 会分步处理。当前页面保留本次会话，刷新后可开始新会话。</p>}
      {messages.map((m,i)=><div key={i}><p className="secondary">{m.role==='user'?'你':'Agent'}</p><div className="reply">{m.text|| (chatting&&i===messages.length-1?'正在处理…':'未收到文本回复')}</div></div>)}
      <form onSubmit={event=>void send(event)}><fieldset className="editor-fields" disabled={busy||chatting}>
        <Field spec={{key:'task',label:'任务内容',type:'textarea',required:true,help:'最多 16000 字。取消任务后，已产生的用量仍会结算。'}} value={text} onChange={v=>setText(String(v).slice(0,16000))}/>
      </fieldset><div className="actions"><button className="primary" disabled={busy||chatting||!text.trim()}>{chatting?'正在执行…':'发送任务'}</button>{chatting&&<button type="button" className="ghost" onClick={()=>abort.current?.abort()}>取消任务</button>}</div></form>
    </Panel>}
    {confirm&&<Modal title={confirm==='stop'?'停止在线 Agent':'轮换专用密钥'} onClose={()=>{if(!busy)setConfirm(null);}} footer={<><button className="ghost" disabled={busy} onClick={()=>setConfirm(null)}>返回</button><button className="danger-button" disabled={busy} onClick={()=>void change(confirm)}>{busy?'处理中…':'确认操作'}</button></>}>
      <p>{confirm==='stop'?'停止后将吊销这把专用密钥，Agent 无法继续发起模型调用。再次启动会签发新密钥。':'旧专用密钥将立即失效，随后为当前 Agent 配置新密钥。更新失败时可重新启动恢复。'}</p><p className="secondary">已产生的调用与费用会保留，其他用途的密钥不受影响。</p>
    </Modal>}
  </>;
}
