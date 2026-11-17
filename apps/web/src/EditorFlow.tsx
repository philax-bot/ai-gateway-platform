import {useEffect,useRef,useState} from 'react';
import {hasPermission,type PlatformSnapshot} from '@ai-gateway/contracts';
import {api} from './client';
import {EditorDialog,Modal,type Editor,type FieldSpec,type FormValues} from './components';
import {makeEditors,type RunCommand} from './editors';

interface Frame {id:number;editor:Editor;draft:FormValues;parentField?:FieldSpec;openedRevision:number}
export function EditorFlow({editor,data,run,refresh,onClose}:{editor:Editor;data:PlatformSnapshot;run:RunCommand;refresh:()=>Promise<boolean>;onClose:()=>void}){
  const sequence=useRef(1),[frames,setFrames]=useState<Frame[]>([{id:1,editor,draft:editor.initial,openedRevision:data.revision}]);
  const [returning,setReturning]=useState<{result?:unknown;verify:boolean}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=frames[frames.length-1],parent=frames[frames.length-2];
  function create(field:FieldSpec,draft:FormValues){
    if(!field.create)return;
    const permission=field.create.kind==='upstreamCredential'?'credentials.write':['definition','service','pool'].includes(field.create.kind)?'models.write':'administration.manage';
    if(!hasPermission(data.actor,permission))return;
    const open=(child:Editor)=>setFrames(previous=>[...previous.slice(0,-1),{...previous[previous.length-1],draft},{id:++sequence.current,editor:child,draft:child.initial,parentField:field,openedRevision:data.revision}]);
    const next=makeEditors(data,run,open);
    if(field.create.kind==='service')next.service(undefined,field.create.definitionId);else if(field.create.kind==='upstreamCredential')next.upstreamCredential(undefined,String(draft.providerId));else next[field.create.kind]();
  }
  function finish(result?:unknown){
    setError('');
    if(frames.length===1){onClose();return;}
    if(result&&current.editor.commandType==='save.service'&&(result as {verification?:string}).verification!=='passed'){setReturning({result,verify:true});return;}
    setReturning({result,verify:false});
  }
  useEffect(()=>{
    if(!returning||returning.verify)return;
    // A successful creation must be reflected in the refreshed workspace before rebuilding the parent.
    if(returning.result&&data.revision<=current.openedRevision)return;
    if(!parent){onClose();return;}
    try{
      const rebuilt=parent.editor.rebuild?.(data)??parent.editor,draft={...rebuilt.initial,...parent.draft},field=current.parentField;
      const result=returning.result as {id?:unknown}|undefined;
      if(field&&result&&typeof result.id==='string'){
        draft[field.key]=field.type==='multiple'||field.person?.multiple?[...new Set([...(Array.isArray(draft[field.key])?draft[field.key] as string[]:[]),result.id])]:result.id;
        if(field.create?.kind==='service'&&data.services.find(s=>s.id===result.id)?.verification!=='passed')draft[`open:${field.create.definitionId}`]='no';
      }
      setFrames(previous=>[...previous.slice(0,-2),{...parent,editor:rebuilt,draft}]);setReturning(null);setError('');
    }catch(e){setError(e instanceof Error?e.message:'返回原表单失败');}
  },[returning,data]);
  async function verify(){
    const result=returning?.result as {id?:string}|undefined;if(!result?.id)return;
    setBusy(true);setError('');
    try{const verified=await api<{verification:string;verificationMessage:string}>(`/api/v1/platform/services/${encodeURIComponent(result.id)}/verify`,{});if(!await refresh())throw new Error('连接验证已结束，但工作空间刷新失败，请重试读取。');if(verified.verification!=='passed')throw new Error(verified.verificationMessage||'连接未通过验证，请检查服务地址、模型标识和凭据引用。');setReturning({result,verify:false});}
    catch(e){setError(e instanceof Error?e.message:'连接验证未通过');}finally{setBusy(false);}
  }
  if(returning?.verify){
    const result=returning.result as {id:string;name?:string},service=data.services.find(s=>s.id===result.id),unknownPrices=service?.mappings.some(m=>!m.meter&&[m.inputPrice,m.outputPrice,m.cachedInputPrice].some(price=>price===null));
    return <Modal title="模型服务已保存，下一步验证连接" onClose={()=>{if(!busy)setReturning({result,verify:false});}} footer={<><button className="ghost" disabled={busy} onClick={()=>setReturning({result,verify:false})}>稍后验证{parent?'，返回上一步':''}</button><button className="primary" disabled={busy} onClick={()=>void verify()}>{busy?'正在验证…':parent?'验证连接并返回上一步':'验证连接'}</button></>}><p>{result.name} 已保存。验证通过后，才能作为已开放模型的来源。</p>{parent&&<p className="secondary">验证完成后返回“{parent.editor.title}”，已填写的内容保留。</p>}{unknownPrices&&<p className="notice warning">还有模型价格未确认。配置可以保留，确认完整价格后才能开通相应模型的调用。</p>}{error&&<><div className="notice danger" role="alert">连接尚未确认可用。请检查服务地址、模型标识与凭据引用，再重新验证；已保存的服务和父表单草稿保留。</div><details className="disclosure"><summary>错误详情</summary><p className="request-reason">{error}</p></details></>}{error&&<button className="ghost" disabled={busy} onClick={()=>{if(service){makeEditors(data,run,next=>setFrames(previous=>[...previous.slice(0,-1),{...current,editor:next,draft:next.initial}])).service(service);setReturning(null);setError('');}}}>修改服务配置</button>}</Modal>;
  }
  if(returning)return <Modal title={error?'暂时无法恢复原表单':'正在返回原表单'} onClose={onClose}><p role="status">{error||'正在更新选项并恢复已填写的内容…'}</p><button className="ghost" disabled={busy} onClick={()=>{setBusy(true);void refresh().finally(()=>setBusy(false));}}>重新读取并返回</button>{error&&<p className="secondary">补充创建的对象已经保存。原对象删除或权限变化时不能继续编辑；关闭任务会放弃尚未保存的父表单草稿。</p>}</Modal>;
  return <EditorDialog key={current.id} editor={{...current.editor,initial:current.draft}} returnTo={parent?.editor.title} onCreate={create} onClose={finish}/>;
}
