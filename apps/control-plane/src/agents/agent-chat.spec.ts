import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AgentChatService,type AgentChatEvent} from './agent-chat.service';
import type {AgentInstancesService} from './agent-instances.service';
import type {LocalOctopRuntime} from './local-octop.runtime';
import type {AuthService} from '../platform/auth.service';

class Socket extends EventTarget {
  send=vi.fn();close=vi.fn();
  open(){this.dispatchEvent(new Event('open'));}
  frame(value:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
}
describe('platform session to Octop chat bridge',()=>{
  let socket:Socket,instances:any,runtime:any,auth:any,service:AgentChatService,events:AgentChatEvent[],disconnect:AbortController,logout:()=>void;
  beforeEach(()=>{
    socket=new Socket();events=[];disconnect=new AbortController();logout=()=>{};
    instances={get:vi.fn(async()=>({enabled:true,instance:{id:'owned-instance',status:'running',generation:1,key:{status:'active'}}})),suspend:vi.fn(async()=>{})};
    instances.release=vi.fn();instances.beginChat=vi.fn(async()=>({release:instances.release,suspend:instances.suspend}));
    runtime={conversation:vi.fn(async()=>({socket:socket as unknown as WebSocket,threadId:'owned-thread'}))};
    auth={authenticate:vi.fn(async()=>({id:'alice'})),onLogout:vi.fn((_token:string,listener:()=>void)=>{logout=listener;return vi.fn();})};
    service=new AgentChatService(instances as AgentInstancesService,runtime as LocalOctopRuntime,auth as AuthService);
  });
  afterEach(()=>vi.useRealTimers());
  const start=async()=>{const calls=runtime.conversation.mock.calls.length;const result=service.stream('alice','platform-cookie',{text:'hello'},{signal:disconnect.signal,emit:e=>events.push(e)});await vi.waitFor(()=>expect(runtime.conversation).toHaveBeenCalledTimes(calls+1));socket.open();return {result};};
  it('keeps native state, tool payloads, credentials and native errors out of the browser',async()=>{
    const {result}=await start();socket.frame({type:'state_snapshot',password:'native-secret'});socket.frame({type:'tool_result',content:'native-secret'});socket.frame({type:'tool_call_chunk',args:'native-secret'});socket.frame({type:'token',content:'hello browser'});socket.frame({type:'done'});await result;
    expect(events.map(e=>e.type)).toEqual(['session','tool','token','done']);expect(JSON.stringify(events)).not.toContain('native-secret');expect(socket.send.mock.calls[0][0]).toContain('owned-thread');expect(socket.send.mock.calls[0][0]).not.toContain('platform-cookie');
  });
  it('cancels the native turn immediately on platform logout and waits for acknowledgement',async()=>{
    const {result}=await start();logout();expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({type:'cancel',thread_id:'owned-thread'});expect(socket.close).not.toHaveBeenCalled();socket.frame({type:'done'});await result;expect(events.at(-1)).toEqual({type:'done',cancelled:true});
  });
  it('explicitly cancels on browser disconnect; disconnect alone is insufficient',async()=>{
    const {result}=await start();disconnect.abort();expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({type:'cancel',thread_id:'owned-thread'}));socket.frame({type:'done'});await result;expect(instances.suspend).not.toHaveBeenCalled();
  });
  it('detects expired or disabled platform sessions during a turn',async()=>{
    const {result}=await start();auth.authenticate.mockRejectedValue(Error('disabled'));await vi.waitFor(()=>expect(socket.send).toHaveBeenCalledTimes(2),{timeout:2000});socket.frame({type:'done'});await result;expect(events.at(-1)).toMatchObject({cancelled:true});
  });
  it('revokes and stops only the server-selected instance when cancel is unacknowledged',async()=>{
    const {result}=await start();vi.useFakeTimers();disconnect.abort();await vi.advanceTimersByTimeAsync(2600);await result;expect(instances.beginChat).toHaveBeenCalledExactlyOnceWith('alice','owned-instance',1);expect(instances.suspend).toHaveBeenCalledExactlyOnceWith();expect(instances.release).toHaveBeenCalledOnce();expect(events.at(-1)?.type).toBe('error');
  });
  it('holds the lifecycle lease through cleanup even if a late done frame arrives',async()=>{
    let release!:()=>void;instances.suspend.mockImplementation(()=>new Promise<void>(r=>release=r));
    const {result}=await start();vi.useFakeTimers();disconnect.abort();await vi.advanceTimersByTimeAsync(2600);
    expect(instances.suspend).toHaveBeenCalledOnce();socket.frame({type:'done'});await Promise.resolve();expect(instances.release).not.toHaveBeenCalled();
    release();await result;expect(instances.release).toHaveBeenCalledOnce();expect(events.some(e=>e.type==='done')).toBe(false);
  });
  it('releases the lifecycle lease when runtime conversation setup fails',async()=>{
    runtime.conversation.mockRejectedValue(Error('setup failed'));await service.stream('alice','platform-cookie',{text:'hello'},{signal:disconnect.signal,emit:e=>events.push(e)});
    expect(instances.release).toHaveBeenCalledOnce();expect(instances.suspend).not.toHaveBeenCalled();
  });
  it('rejects concurrent turns, then releases the slot after completion',async()=>{
    const {result}=await start();await expect(service.stream('alice','platform-cookie',{text:'second'},{signal:disconnect.signal,emit:()=>{}})).rejects.toThrow('仍在进行');socket.frame({type:'done'});await result;
    const next=await start();socket.frame({type:'done'});await next.result;
  });
  it('rejects caller-selected owner, URL, agent and invalid text before opening a runtime',async()=>{
    for(const body of [{text:''},{text:'a'.repeat(16001)},{text:'hello',ownerId:'bob'},{text:'hello',url:'http://external'},{text:'hello',agentId:'foreign'},{text:'hello',threadId:'../foreign'}])await expect(service.stream('alice','platform-cookie',body,{signal:disconnect.signal,emit:()=>{}})).rejects.toThrow();expect(runtime.conversation).not.toHaveBeenCalled();
  });
  it('never exposes errors from a foreign or missing Octop conversation',async()=>{
    runtime.conversation.mockRejectedValue(Error('native token and URL'));await service.stream('alice','platform-cookie',{text:'hello',threadId:'foreign-thread'},{signal:disconnect.signal,emit:e=>events.push(e)});expect(JSON.stringify(events)).not.toContain('native token');expect(events[0].type).toBe('error');
  });
  it('refuses stopped instances and session/actor mismatches',async()=>{
    auth.authenticate.mockResolvedValue({id:'bob'});await expect(service.stream('alice','platform-cookie',{text:'hello'},{signal:disconnect.signal,emit:()=>{}})).rejects.toThrow('session changed');auth.authenticate.mockResolvedValue({id:'alice'});instances.get.mockResolvedValue({enabled:true,instance:{status:'stopped'}});await expect(service.stream('alice','platform-cookie',{text:'hello'},{signal:disconnect.signal,emit:()=>{}})).rejects.toThrow('先启动');expect(runtime.conversation).not.toHaveBeenCalled();
  });
});
