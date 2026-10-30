import {BadRequestException,ConflictException,Injectable} from '@nestjs/common';
import {AuthService} from '../platform/auth.service';
import {AgentInstancesService} from './agent-instances.service';
import {LocalOctopRuntime} from './local-octop.runtime';

export type AgentChatEvent={type:'session';threadId:string}|{type:'token';content:string}|{type:'tool';message:string}|{type:'done';cancelled:boolean}|{type:'error';message:string};
export interface ChatSink {signal:AbortSignal;emit:(event:AgentChatEvent)=>void}
/** Platform cookies terminate here. Only a server-owned runtime can receive the turn. */
@Injectable()
export class AgentChatService {
  private active=new Set<string>();
  constructor(private readonly instances:AgentInstancesService,private readonly runtime:LocalOctopRuntime,private readonly auth:AuthService){}
  async stream(actorId:string,session:string,body:Record<string,unknown>,sink:ChatSink){
    if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!['text','threadId'].includes(k))||typeof body.text!=='string'||!body.text.trim()||body.text.length>16000||body.threadId!==undefined&&(typeof body.threadId!=='string'||!/^[-A-Za-z0-9_:]{1,200}$/.test(body.threadId)))throw new BadRequestException('请输入 1–16000 字的任务，并使用当前账号的会话。');
    const actor=await this.auth.authenticate(session);if(actor.id!==actorId)throw new ConflictException('session changed');
    const view=await this.instances.get(actorId),instance=view.instance;
    if(!view.enabled||instance?.status!=='running'||instance.key?.status!=='active')throw new ConflictException('请先启动在线 Agent。');
    if(this.active.has(instance.id))throw new ConflictException('当前任务仍在进行，请等待或取消后再发送。');
    const lease=await this.instances.beginChat(actorId,instance.id,instance.generation);
    this.active.add(instance.id);const abort=new AbortController();let validating=false;
    const cancel=()=>abort.abort();sink.signal.addEventListener('abort',cancel,{once:true});if(sink.signal.aborted)cancel();
    const unsubscribe=this.auth.onLogout(session,cancel);
    const timer=setInterval(()=>{if(validating||abort.signal.aborted)return;validating=true;void (async()=>{try{await this.auth.authenticate(session);const current=(await this.instances.get(actorId)).instance;if(current?.status!=='running'||current.generation!==instance.generation||current.key?.status!=='active')cancel();}catch{cancel();}finally{validating=false;}})();},1000);
    const timeout=setTimeout(cancel,180000);
    try{
      const conversation=await this.runtime.conversation(instance.id,body.threadId as string|undefined,abort.signal);
      await this.relay(conversation.socket,conversation.threadId,body.text,abort.signal,sink.emit,lease.suspend);
    }catch{
      sink.emit({type:'error',message:abort.signal.aborted?'任务已取消或登录状态已变化。已产生的用量仍会结算。':'Agent 暂时无法完成任务，请刷新状态后重试。'});
    }finally{clearInterval(timer);clearTimeout(timeout);unsubscribe();sink.signal.removeEventListener('abort',cancel);this.active.delete(instance.id);lease.release();}
  }
  private relay(socket:WebSocket,threadId:string,text:string,signal:AbortSignal,emit:ChatSink['emit'],suspend:()=>Promise<void>){
    return new Promise<void>((resolve,reject)=>{
      let finished=false,sent=false,cancelling=false,failing=false,size=0,cancelTimer:NodeJS.Timeout|undefined;
      const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(cancelTimer);signal.removeEventListener('abort',cancel);socket.close();error?reject(error):resolve();};
      const failClosed=()=>{if(finished||failing)return;failing=true;void suspend().then(()=>finish(Error('cancel unacknowledged')),()=>finish(Error('runtime stop failed')));};
      const cancel=()=>{if(finished||cancelling)return;cancelling=true;if(!sent){finish();return;}try{socket.send(JSON.stringify({type:'cancel',thread_id:threadId}));cancelTimer=setTimeout(failClosed,2500);}catch{failClosed();}};
      signal.addEventListener('abort',cancel,{once:true});
      socket.addEventListener('open',()=>{if(finished)return;if(signal.aborted){finish();return;}emit({type:'session',threadId});socket.send(JSON.stringify({type:'user_turn',text,thread_id:threadId,skills:[],knowledge_base_ids:[],mcp_servers:[],conversation_mode:'ask'}));sent=true;});
      socket.addEventListener('message',event=>{
        if(finished||failing)return;
        try{
          if(typeof event.data!=='string'||event.data.length>1048576)throw Error('invalid frame');const f=JSON.parse(event.data);
          if(f.type==='done'){emit({type:'done',cancelled:cancelling});finish();}
          else if(f.type==='error'){emit({type:'error',message:'任务执行失败，请查看调用记录中的结果与费用。'});if(!cancelling)cancel();}
          else if(!cancelling&&f.type==='token'&&typeof f.content==='string'){size+=f.content.length;if(size>1048576)cancel();else emit({type:'token',content:f.content});}
          else if(!cancelling&&f.type==='tool_call_chunk')emit({type:'tool',message:'Agent 正在使用工具…'});
          // State, tool arguments/results, Provider config and native errors stay server-side.
        }catch{cancel();}
      });
      socket.addEventListener('error',()=>{if(sent)failClosed();else finish(Error('transport failed'));});
      socket.addEventListener('close',()=>{if(!finished){if(sent)failClosed();else finish(Error('transport closed'));}});
      if(signal.aborted)cancel();
    });
  }
}
