import {isPermanentQuota} from '@ai-gateway/contracts';
import { Children, useEffect, useLayoutEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { PlatformSnapshot,PersonSummary } from '@ai-gateway/contracts';
import {ApiError} from './client';
import {DateField} from './date-field';
import {PasswordInput} from './password-field';
import {PersonPicker,type PersonSource} from './PersonPicker';

export interface RelatedResource {kind:'definition'|'service'|'pool'|'plan'|'organization'|'member'|'upstreamCredential';label:string;definitionId?:string}

export interface FieldSpec {
  key:string;label:string;type?:'choice'|'text'|'number'|'date'|'datetime'|'select'|'multiple'|'person'|'textarea'|'password'|'import'|'file';required?:boolean;help?:string;
  person?:PersonSource&{multiple?:boolean;initialPeople?:PersonSummary[]};
  accept?:string;maxBytes?:number;onFile?:(file:File|null)=>void;
  options?:{value:string;label:string}[];show?:(values:FormValues)=>boolean;
  optionsWhen?:(values:FormValues)=>{value:string;label:string}[];
  onChange?:(value:string|string[],values:FormValues)=>FormValues;
  step?:string;
  requiredWhen?:(values:FormValues)=>boolean;
  group?:string;
  create?:RelatedResource;
}
export type FormValues=Record<string,string|string[]>;
export interface Editor {title:string;description?:string;context?:(values:FormValues)=>ReactNode;danger?:boolean;fields:FieldSpec[];initial:FormValues;submit:(values:FormValues)=>Promise<boolean>;commandType?:string;getResult?:()=>unknown;rebuild?:(data:PlatformSnapshot)=>Editor;submitLabel?:string}
export interface ProcessStep {label:string;detail?:string;state:'done'|'current'|'waiting'|'error'|'stopped'}
export function ProcessPath({label,steps}:{label:string;steps:ProcessStep[]}){
  return <ol className="process-path" aria-label={label}>{steps.map((step,i)=><li key={i} data-state={step.state} aria-current={step.state==='current'||step.state==='error'?'step':undefined}><span className="process-mark" aria-hidden="true">{step.state==='done'?'✓':step.state==='error'?'!':step.state==='stopped'?'−':i+1}</span><div><strong>{step.label}</strong>{step.detail&&<small>{step.detail}</small>}</div></li>)}</ol>;
}
export function ChangeSummary({label,items,beforeLabel='申请',afterLabel='批准'}:{label:string;items:{label:string;before?:ReactNode;after:ReactNode;detail?:string}[];beforeLabel?:string;afterLabel?:string}){
  return <dl className="change-summary" aria-label={label}>{items.map((item,i)=><div className="change-row" key={i}><dt>{item.label}</dt><dd>{item.before!==undefined&&<><span className="change-value"><small>{beforeLabel}</small><strong>{item.before}</strong></span><span className="change-arrow" aria-hidden="true">→</span></>}<span className="change-value is-target"><small>{afterLabel}</small><strong>{item.after}</strong>{item.detail&&<small>{item.detail}</small>}</span></dd></div>)}</dl>;
}
export function Modal({title,onClose,children,footer,className}:{title:string;onClose:()=>void;children:ReactNode;footer?:ReactNode;className?:string}){
  const ref=useRef<HTMLDialogElement>(null),titleId=useId();
  useLayoutEffect(()=>{
    const dialog=ref.current!,opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialog.showModal();
    return()=>{dialog.close();if(opener?.isConnected)opener.focus({preventScroll:true});};
  },[]);
  function keepFocus(event:ReactKeyboardEvent<HTMLDialogElement>){
    if((event.target as Element).closest('dialog')!==event.currentTarget)return;
    if(event.key!=='Tab'||event.defaultPrevented)return;
    const dialog=event.currentTarget,items=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')].filter(item=>item.tabIndex>=0&&item.getClientRects().length>0);
    const first=items[0],last=items.at(-1),active=document.activeElement;
    if(event.shiftKey&&(active===first||active===dialog||!dialog.contains(active))){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(active===last||active===dialog||!dialog.contains(active))){event.preventDefault();first?.focus();}
  }
  return <dialog className={`modal ${className??''}`} ref={ref} aria-labelledby={titleId} onKeyDown={keepFocus} onCancel={event=>{event.preventDefault();event.stopPropagation();onClose();}}>
    <div className="modal-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
    <div className="modal-body">{children}</div>{footer&&<div className="modal-footer">{footer}</div>}
  </dialog>;
}
export function EditorDialog({editor,onClose,onCreate,returnTo}:{editor:Editor;onClose:(result?:unknown)=>void;onCreate?:(field:FieldSpec,values:FormValues)=>void;returnTo?:string}){
  const [values,setValues]=useState(editor.initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[denied,setDenied]=useState(false),formId=useId();
  async function save(event:FormEvent){event.preventDefault();if(busy||denied)return;setBusy(true);setError('');try{if(await editor.submit(values))onClose(editor.getResult?.());}catch(error){setError(error instanceof Error?error.message:'保存失败');setDenied(error instanceof ApiError&&error.status===403);}finally{setBusy(false);}}
  const visible=editor.fields.filter(field=>!field.show||field.show(values)),groups=[...new Set(visible.map(f=>f.group).filter((value):value is string=>!!value))];
  const field=(spec:FieldSpec)=><div key={spec.key} className={['textarea','import','multiple','person'].includes(spec.type??'')?'wide-field':undefined}><Field spec={{...spec,options:spec.optionsWhen?.(values)??spec.options,required:spec.required||spec.requiredWhen?.(values)}} value={values[spec.key]??(spec.type==='multiple'?[]:'')} onChange={value=>setValues(previous=>({...previous,...spec.onChange?.(value,previous),[spec.key]:value}))}/>{spec.create&&onCreate&&<button className="link-button field-create" type="button" disabled={busy} onClick={()=>onCreate(spec,values)}>{spec.create.label}</button>}</div>;
  return <Modal title={editor.title} onClose={()=>{if(!busy)onClose();}} footer={denied?<button className="primary" type="button" onClick={()=>onClose()}>{returnTo?'返回上一步':'关闭并返回'}</button>:<><button className="ghost" type="button" disabled={busy} onClick={()=>onClose()}>{returnTo?'返回上一步':'取消'}</button><button className={editor.danger?'danger-button':'primary'} disabled={busy} type="submit" form={formId}>{busy?'处理中…':editor.submitLabel??'继续'}</button></>}><form id={formId} onSubmit={event=>void save(event)}>
    {returnTo&&<p className="notice">完成后返回“{returnTo}”，此前填写的内容已保留。</p>}{editor.description&&<p className="secondary">{editor.description}</p>}
    {editor.context?.(values)}<fieldset className="editor-fields" disabled={busy}><div className="form-grid">{visible.filter(f=>!f.group).map(field)}</div>{groups.map(group=><details className="disclosure" key={group} open={!!error||visible.some(f=>f.group===group&&(f.required||f.requiredWhen?.(values)||f.key.endsWith(':mode')&&values[f.key]!=='inherit'))||undefined}><summary>{group}</summary><div className="form-grid">{visible.filter(f=>f.group===group).map(field)}</div></details>)}</fieldset>
    {error&&<div className="notice danger" role="alert">{error}</div>}{denied&&<p className="secondary">已填写内容保留在当前窗口，返回后不会提交这次操作。</p>}
  </form></Modal>;
}
export function Field({spec,value,onChange}:{spec:FieldSpec;value:string|string[];onChange:(value:string|string[])=>void}){
  const id=useId(),labelId=`${id}-label`,helpId=spec.help?`${id}-help`:undefined,[fileError,setFileError]=useState(''),common={id,required:spec.required,'aria-describedby':helpId};
  const multiple=Array.isArray(value)?value:[];
  return <div className={`form-field ${['textarea','import','multiple','person'].includes(spec.type??'')?'wide':''}`}>
    {spec.type==='choice'?<span id={labelId}>{spec.label}{spec.required&&' *'}</span>:spec.type==='multiple'?<label id={labelId} htmlFor={id} className="field-label">{spec.label}{spec.required&&<span className="required"> *</span>}</label>:<label htmlFor={id}>{spec.label}{spec.required&&<span className="required"> *</span>}</label>}
    {spec.type==='person'?<PersonPicker id={id} label={`选择${spec.label}`} value={spec.person?.multiple?multiple:typeof value==='string'&&value?[value]:[]} multiple={spec.person?.multiple} required={spec.required} source={{scope:spec.person?.scope??'directory',projectId:spec.person?.projectId,excludeIds:spec.person?.excludeIds}} initialPeople={spec.person?.initialPeople} onChange={ids=>onChange(spec.person?.multiple?ids:ids[0]??'')}/>:spec.type==='choice'?<div role="radiogroup" aria-labelledby={labelId} aria-describedby={helpId}>{spec.options?.map(option=><label className="plan-choice" key={option.value}><input type="radio" name={id} required={spec.required} checked={value===option.value} value={option.value} onChange={()=>onChange(option.value)}/><span>{option.label}</span></label>)}</div>:spec.type==='multiple'?<MultiSelect id={id} labelId={labelId} helpId={helpId} options={spec.options??[]} value={multiple} onChange={onChange} required={spec.required}/>:spec.type==='select'?<select id={id} required={spec.required} aria-describedby={helpId} value={String(value)} onChange={event=>onChange(event.target.value)}>
      {!spec.options?.some(option=>option.value==='')&&<option value="">请选择</option>}{spec.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
    </select>:spec.type==='file'?<><input {...common} type="file" accept={spec.accept} onChange={event=>{const file=event.target.files?.[0]??null;setFileError('');if(file&&spec.maxBytes&&file.size>spec.maxBytes){setFileError(`文件最多 ${Math.floor(spec.maxBytes/1048576)} MiB`);event.target.value='';spec.onFile?.(null);onChange('');return;}spec.onFile?.(file);onChange(file?.name??'');}}/>{fileError&&<small role="alert">{fileError}</small>}</>:spec.type==='import'?<><input type="file" aria-label="选择 CSV 或 TSV 成员文件" accept=".csv,.tsv,.txt" onChange={event=>{const file=event.target.files?.[0];if(!file)return;setFileError('');if(file.size>1048576){setFileError('文件最多 1 MiB');return;}void file.text().then(onChange).catch(()=>setFileError('读取文件失败，请使用 UTF-8 文本'));}}/><textarea {...common} rows={8} value={String(value)} onChange={event=>onChange(event.target.value)}/>{fileError&&<small role="alert">{fileError}</small>}</>:spec.type==='textarea'?<textarea {...common} rows={3} value={String(value)} onChange={event=>onChange(event.target.value)}/>:spec.type==='password'?<PasswordInput id={id} value={String(value)} required={spec.required} describedBy={helpId} autoComplete="new-password" onChange={value=>onChange(value)}/>:spec.type==='date'||spec.type==='datetime'?<DateField id={id} helpId={helpId} value={String(value)} mode={spec.type} required={spec.required} onChange={value=>onChange(value)}/>:<input {...common} type={spec.type??'text'} step={spec.type==='number'?spec.step??'0.000001':undefined} value={String(value)} onChange={event=>onChange(event.target.value)}/>}
    {spec.help&&<small id={helpId}>{spec.help}</small>}
  </div>;
}
function MultiSelect({id,labelId,helpId,options,value,onChange,required}:{
  id:string;labelId:string;helpId?:string;options:{value:string;label:string}[];value:string[];onChange:(value:string[])=>void;required?:boolean;
}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(-1),[dropUp,setDropUp]=useState(false),[listMax,setListMax]=useState(232);
  const rootRef=useRef<HTMLDivElement>(null),triggerRef=useRef<HTMLButtonElement>(null),searchRef=useRef<HTMLInputElement>(null),listRef=useRef<HTMLDivElement>(null),valueRef=useRef(value);
  const listId=`${id}-list`,summaryId=`${id}-summary`,optionId=(index:number)=>`${id}-option-${index}`;
  const selected=new Set(value),selectedOptions=options.filter(option=>selected.has(option.value));
  const filtered=options.filter(option=>option.label.toLowerCase().includes(query.trim().toLowerCase()));
  const withSearch=options.length>5,allFilteredSelected=filtered.length>0&&filtered.every(option=>selected.has(option.value));
  useEffect(()=>{valueRef.current=value;},[value]);
  useEffect(()=>{if(!open)return;const frame=requestAnimationFrame(()=>{(withSearch?searchRef.current:listRef.current)?.focus();});return()=>cancelAnimationFrame(frame);},[open,withSearch]);
  useEffect(()=>{if(!open)return;const first=filtered.findIndex(option=>selected.has(option.value));setActive(filtered.length?(first>=0?first:0):-1);},[open,query]);
  useEffect(()=>{if(!open)return;const onPointer=(event:PointerEvent)=>{if(!rootRef.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',onPointer,true);return()=>document.removeEventListener('pointerdown',onPointer,true);},[open]);
  useEffect(()=>{if(!open)return;const root=rootRef.current;if(!root)return;const onFocusOut=(event:FocusEvent)=>{if(!root.contains(event.relatedTarget as Node|null))setOpen(false);};root.addEventListener('focusout',onFocusOut);return()=>root.removeEventListener('focusout',onFocusOut);},[open]);
  useEffect(()=>{if(!open||active<0)return;document.getElementById(optionId(active))?.scrollIntoView({block:'nearest'});},[active,open]);
  function close(refocus=false){setOpen(false);if(refocus)requestAnimationFrame(()=>triggerRef.current?.focus());}
  function commit(next:string[]){valueRef.current=next;onChange(next);}
  function toggle(next:string){const current=valueRef.current;commit(current.includes(next)?current.filter(item=>item!==next):[...current,next]);}
  function openList(){
    if(open){close();return;}
    const rect=triggerRef.current?.getBoundingClientRect(),boundary=triggerRef.current?.closest('.modal-body')?.getBoundingClientRect();
    if(rect){const top=boundary?Math.max(boundary.top,0):0,bottom=boundary?Math.min(boundary.bottom,window.innerHeight):window.innerHeight,below=bottom-rect.bottom,above=rect.top-top,drop=below<300&&above>below,space=drop?above:below;setDropUp(drop);setListMax(Math.max(80,Math.min(232,space-(withSearch?150:106))));}
    setQuery('');setOpen(true);
  }
  function keyDown(event:ReactKeyboardEvent){
    if(!open){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openList();}return;}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(current=>filtered.length?(event.key==='ArrowDown'?(current+1)%filtered.length:(current<=0?filtered.length-1:current-1)):-1);return;}
    if((event.key==='Enter'||event.key===' ')&&!(event.target instanceof HTMLInputElement&&event.key===' ')){const option=filtered[active];if(option){event.preventDefault();toggle(option.value);}}
  }
  return <div className="multi-select" ref={rootRef} onKeyDown={keyDown}>
    <button type="button" id={id} ref={triggerRef} className="multi-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-labelledby={`${labelId} ${summaryId}`} aria-describedby={helpId} onClick={openList}>
      <span className="multi-select-value" aria-hidden="true">{selectedOptions.length?<>{selectedOptions.slice(0,2).map(option=><span className="multi-select-chip" key={option.value}>{option.label}</span>)}{selectedOptions.length>2&&<span className="multi-select-chip multi-select-more">+{selectedOptions.length-2}</span>}</>:<span className="multi-select-placeholder">请选择</span>}</span>
      <span id={summaryId} className="sr-only" aria-live="polite">{selectedOptions.length?`已选 ${selectedOptions.length} 项`:'未选择'}</span>
      <span className="multi-select-caret" aria-hidden="true"/>
    </button>
    {selectedOptions.length>0&&<button type="button" className="multi-select-clear" aria-label="清除全部选择" onClick={()=>commit([])}>×</button>}
    {open&&<div className={`multi-select-popover ${dropUp?'is-up':''}`}>
      {withSearch&&<input ref={searchRef} className="multi-select-search" type="search" value={query} placeholder="搜索选项" aria-label="搜索选项" role="combobox" aria-autocomplete="list" aria-expanded={true} aria-controls={listId} aria-activedescendant={active>=0?optionId(active):undefined} onChange={event=>setQuery(event.target.value)}/>}
      <div ref={listRef} id={listId} className="multi-select-list" style={{maxHeight:listMax}} role="listbox" aria-multiselectable="true" aria-labelledby={labelId} aria-required={required||undefined} aria-activedescendant={active>=0?optionId(active):undefined} tabIndex={withSearch?-1:0}>
        {filtered.map((option,index)=>{const checked=selected.has(option.value);return <div key={option.value} id={optionId(index)} role="option" aria-selected={checked} className={`multi-select-option ${checked?'selected':''} ${index===active?'active':''}`} onMouseDown={event=>event.preventDefault()} onClick={()=>toggle(option.value)}><span className="multi-select-check" aria-hidden="true"/><span>{option.label}</span></div>;})}
        {!filtered.length&&<div className="multi-select-empty" role="status">{options.length?'没有匹配的选项':'暂无可选项'}</div>}
      </div>
      <div className="multi-select-footer"><span>已选 {selectedOptions.length} 项</span>{options.length>0&&<div><button type="button" className="multi-select-action" onMouseDown={event=>event.preventDefault()} disabled={!filtered.length||allFilteredSelected} onClick={()=>commit([...new Set([...valueRef.current,...filtered.map(option=>option.value)])])}>{query.trim()?'全选结果':'全选'}</button><button type="button" className="multi-select-action" disabled={!selectedOptions.length} onMouseDown={event=>event.preventDefault()} onClick={()=>commit([])}>清空</button></div>}</div>
    </div>}
  </div>;
}
const statusLabels:Record<string,string>={active:'已启用',paused:'已暂停',ended:'已结束',expired:'已到期',pending:'待审批',approved:'已批准待生效',effective:'已生效',failed:'执行失败',rejected:'已驳回',withdrawn:'已撤回',closed:'已关闭',passed:'验证通过',unverified:'未验证',disabled:'已停用',revoked:'已吊销',confirmed:'已结算',pending_review:'待核对',not_billable:'不计费',completed:'完成',upstream_error:'上游失败',client_cancelled:'已取消',timeout:'超时',partial:'响应中断',rejected_before_upstream:'生成前拒绝',running:'进行中',interrupted:'已中断'};
/* `label` only overrides the wording: some resources share a state code but not its name
   (`active` is 已启用 for members and keys, 进行中 for projects). Tone still follows the code. */
export function Status({value,label}:{value:string;label?:string}){return <span className={`tag ${['active','effective','passed','confirmed','completed'].includes(value)?'success':['failed','rejected','revoked','upstream_error'].includes(value)?'danger':'warning'}`}>{label??statusLabels[value]??value}</span>;}
export function Panel({title,eyebrow,actions,children}:{title:string;eyebrow?:string;actions?:ReactNode;children:ReactNode}){
  return <section className="panel"><div className="section-head"><div>{eyebrow&&<span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><div className="actions compact">{actions}</div></div>{children}</section>;
}
export function Tabs({labels,initialIndex=0,children}:{labels:string[];initialIndex?:number;children:ReactNode}){
  const [index,setIndex]=useState(initialIndex),id=useId();
  return <><div className="section-tabs" aria-label="选择配置步骤">{labels.map((label,i)=><button type="button" key={label} aria-pressed={index===i} aria-controls={`${id}-content`} className={index===i?'selected':''} onClick={()=>setIndex(i)}>{label}</button>)}</div><div id={`${id}-content`}>{Children.toArray(children)[index]}</div></>;
}
export function Table({headers,rows,empty='暂无记录'}:{headers:string[];rows:ReactNode[][];empty?:ReactNode}){
  return <div className="tablewrap" tabIndex={0}><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{rows.length?rows.map((row,index)=><tr key={index}>{row.map((cell,column)=><td key={column}>{cell}</td>)}</tr>):<tr><td colSpan={headers.length} className="empty">{empty}</td></tr>}</tbody></table></div>;
}
export function useNarrow(maxWidth=760){
  const [narrow,setNarrow]=useState(()=>typeof window!=='undefined'&&window.matchMedia(`(max-width: ${maxWidth}px)`).matches);
  useEffect(()=>{const query=window.matchMedia(`(max-width: ${maxWidth}px)`),sync=()=>setNarrow(query.matches);sync();query.addEventListener('change',sync);return()=>query.removeEventListener('change',sync);},[maxWidth]);
  return narrow;
}
export const money=(value:number)=>`¥ ${value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6})}`;
export const date=(value:string|null|undefined)=>value&&!isPermanentQuota(value)?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'长期有效';
export const toDateInput=(value?:string|null)=>value&&!isPermanentQuota(value)?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value)):'';
export const endOfDay=(value:string|string[])=>`${String(value)}T23:59:59.999+08:00`;
