import type {ReactNode} from 'react';
import {MODEL_KINDS,type CapacityMetric,type ModelKind} from '@ai-gateway/contracts';

/* 模型身份标：每种模型类型一个固定浅底方标，五套壳层通用（组件契约 §3.21）。
   标记只表达“这是哪类模型”，不表达可用状态；状态一律交给 Status。 */
const KIND_MARKS:Record<ModelKind,{label:string;color:string}>={
  chat:{label:'文',color:'#3f6ad8'},
  embeddings:{label:'向',color:'#0e7490'},
  rerank:{label:'排',color:'#39594d'},
  image:{label:'图',color:'#b45309'},
  asr:{label:'识',color:'#a1332a'},
  tts:{label:'合',color:'#8a5a12'},
  video:{label:'视',color:'#5b4bc4'},
};

export function ModelMark({kind,size}:{kind:ModelKind;size?:'sm'}){
  const mark=KIND_MARKS[kind];
  return <span className={`model-mark${size==='sm'?' is-sm':''}`} style={{background:`${mark.color}1f`,color:mark.color}} aria-hidden="true">{mark.label}</span>;
}

export function ModelIdentity({name,modelId,kind,vendor,onCopy}:{name:ReactNode;modelId:string;kind:ModelKind;vendor?:ReactNode;onCopy?:()=>void}){
  return <div className="model-identity">
    <ModelMark kind={kind}/>
    <div className="model-identity-text">
      <b>{name}</b>
      <span className="model-identity-code"><code>{modelId}</code>{onCopy&&<button type="button" className="link-button" onClick={onCopy}>复制</button>}</span>
      {vendor&&<small>{vendor}</small>}
    </div>
  </div>;
}

export type CapabilityState='verified'|'declared'|'unsupported';
export interface CapabilityRow {name:string;states:Partial<Record<ModelKind,CapabilityState>>}
const capabilityLabels:Record<CapabilityState,string>={verified:'已确认',declared:'已登记未验证',unsupported:'未登记或不支持'};

/* 能力矩阵（§3.22）：只在对象页使用，列表页用标签 + 计数。
   宽屏用表格；≤760px 降级为“类型 + 三态文字”的行列表，不横向滚动。 */
export function CapabilityMatrix({rows,label,kinds=Object.keys(MODEL_KINDS) as ModelKind[]}:{rows:CapabilityRow[];label:string;kinds?:ModelKind[]}){
  return <>
    <div className="capability-matrix-wrap">
      <table className="capability-matrix">
        <caption className="sr-only">{label}</caption>
        <thead><tr><th scope="col">接入</th>{kinds.map(kind=><th scope="col" key={kind}>{MODEL_KINDS[kind]}</th>)}</tr></thead>
        <tbody>{rows.map(row=><tr key={row.name}>
          <th scope="row">{row.name}</th>
          {kinds.map(kind=>{
            const state=row.states[kind]??'unsupported';
            return <td key={kind}>
              <span className="capability-cell" data-state={state} title={capabilityLabels[state]} aria-hidden="true">{state==='verified'?'✓':state==='declared'?'·':'–'}</span>
              <span className="sr-only">{MODEL_KINDS[kind]}：{capabilityLabels[state]}</span>
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="capability-list" aria-label={label}>{rows.map(row=><div className="capability-list-group" key={row.name}>
      {rows.length>1&&<p className="capability-list-name">{row.name}</p>}
      <ul>{kinds.map(kind=>{const state=row.states[kind]??'unsupported';return <li key={kind}><span>{MODEL_KINDS[kind]}</span><em data-state={state}>{capabilityLabels[state]}</em></li>;})}</ul>
    </div>)}</div>
    <p className="capability-legend"><span data-state="verified">✓ 已确认接入</span><span data-state="declared">· 已登记未验证</span><span data-state="unsupported">– 未登记或不支持</span></p>
  </>;
}

export type TicketState='allow'|'deny'|'pending'|'unknown'|'settled';
const ticketLabels:Record<TicketState,string>={allow:'可调用',deny:'不可调用',pending:'等待预估',unknown:'结果未确认',settled:'已结算'};
export interface TicketRow {label:ReactNode;value:ReactNode;emphasis?:boolean}

/* 准入小票（§3.23）：在线使用、多模态工作台与模型详情共用。
   允许/拒绝、来源、预占、价格版本、估算与结算回执在同一块里，不再散落到 notice 与折叠区。 */
export function AdmissionTicket({state,headline,rows=[],note,actions,children,title='本次准入'}:{state:TicketState;headline?:ReactNode;rows?:TicketRow[];note?:ReactNode;actions?:ReactNode;children?:ReactNode;title?:string}){
  return <section className="admission-ticket" data-state={state} aria-label={title}>
    <header className="admission-ticket-head"><span className="admission-ticket-state">{ticketLabels[state]}</span>{headline&&<strong>{headline}</strong>}</header>
    {rows.length>0&&<dl className="admission-ticket-rows">{rows.map((row,index)=><div key={index} className={row.emphasis?'is-emphasis':undefined}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
    {children}
    {note&&<p className="admission-ticket-note">{note}</p>}
    {actions&&<div className="admission-ticket-actions">{actions}</div>}
  </section>;
}

const capacityParts=(metric:CapacityMetric,unit:string,unknown:boolean)=>{
  if(unknown)return {text:'未知',value:null,unit};
  if(metric.limit===null)return {text:`${metric.used.toLocaleString('zh-CN')}`,value:null,unit};
  return {text:`${metric.used.toLocaleString('zh-CN')} / ${metric.limit.toLocaleString('zh-CN')}`,value:metric.percent,unit};
};

/* 容量条（§3.24）：RPM / TPM / 并发是三个口径，不相加；无上限不画百分比。 */
export function CapacityMeter({rpm,tpm,concurrency,unknown=false,collectedAt}:{rpm:CapacityMetric;tpm:CapacityMetric;concurrency:CapacityMetric;unknown?:boolean;collectedAt?:string}){
  const rows:[string,CapacityMetric,string][]=[['RPM',rpm,'次 / 分钟'],['TPM',tpm,'Token / 分钟'],['并发',concurrency,'个']];
  return <div className="capacity-meter">
    {rows.map(([label,metric,unit])=>{const part=capacityParts(metric,unit,unknown);return <div className="capacity-meter-row" key={label}>
      <span className="capacity-meter-label">{label}</span>
      <span className="capacity-meter-track" aria-hidden="true">{part.value!==null&&<i style={{width:`${Math.min(100,Math.max(0,part.value))}%`}}/>}</span>
      <span className="capacity-meter-value">{part.text}<small>{part.value===null?(unknown?'采集失败或过期':'无上限'):unit}</small></span>
    </div>;})}
    <p className="capacity-meter-note">{unknown?'采集失败或读数过期，不使用上一次结果。':collectedAt?`采集于 ${collectedAt}。百分比按有效上限计算，可超过 100%。`:'百分比按有效上限计算，可超过 100%；无上限不计算百分比。'}</p>
  </div>;
}
