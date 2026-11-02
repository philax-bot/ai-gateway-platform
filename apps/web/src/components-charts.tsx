import type { ReactNode } from 'react';

/**
 * Chart primitives registered in docs/product/ui-component-contract-v1.md §3.18–3.19.
 * They take only semantic tokens (`--action`, `--line`, `--text`, `--muted`), so the
 * five shells render them without a per-theme rule. Every chart is `role="img"` with a
 * text label; the readable numbers always exist as text next to the graphic, never as
 * a colour or a length the reader has to measure.
 */

export interface ShareBarProps { ratio:number; label:string; tone?:'action'|'warn'|'danger' }

/** Table-cell proportion bar. The bar is decorative: `label` carries the number. */
export function ShareBar({ratio,label,tone='action'}:ShareBarProps){
  const width=Math.max(0,Math.min(100,ratio*100));
  return <span className="share-cell">
    <span className={`share-bar is-${tone}`} aria-hidden="true"><i style={{width:`${width.toFixed(1)}%`}}/></span>
    <b>{label}</b>
  </span>;
}

export interface DonutSegment { label:string; value:string; ratio:number; detail?:string }
export interface DonutChartProps { segments:DonutSegment[]; center:string; centerLabel:string; label:string }

const fallbackTones=['var(--action)','var(--blue, var(--action))','var(--warn)','var(--line-strong)'];

const seriesTones=['var(--action)','var(--warn)','var(--danger)','var(--line-strong)'];

/** Ring built from one conic-gradient; segments share the four semantic series tones. */
export function DonutChart({segments,center,centerLabel,label}:DonutChartProps){
  let cursor=0;
  const stops:string[]=[];
  segments.forEach((segment,index)=>{
    const start=cursor;
    const end=Math.min(100,cursor+Math.max(0,segment.ratio)*100);
    cursor=end;
    if(end>start)stops.push(`${seriesTones[index%seriesTones.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
  });
  if(cursor<99.99)stops.push(`var(--surface3) ${cursor.toFixed(2)}% 100%`);
  return <div className="donut-chart">
    <div className="donut-ring" role="img" aria-label={label} style={{background:`conic-gradient(from -90deg, ${stops.join(',')})`}}>
      <span className="donut-hole"><b>{center}</b><small>{centerLabel}</small></span>
    </div>
    <ul className="donut-legend">
      {segments.map((segment,index)=><li key={segment.label}>
        <i aria-hidden="true" style={{background:seriesTones[index%seriesTones.length]}}/>
        <span className="donut-name">{segment.label}</span>
        <span className="donut-value">{segment.value}{segment.detail&&<small>{segment.detail}</small>}</span>
      </li>)}
    </ul>
  </div>;
}

export interface GaugeChartProps { ratio:number; value:string; unit:string; label:string; caption:string; boxes?:{label:string;value:string}[] }

/** Single-value ring: the number sits in the middle, the arc only shows the ratio. */
export function GaugeChart({ratio,value,unit,label,caption,boxes=[]}:GaugeChartProps){
  const clamped=Math.max(0,Math.min(1,ratio)),radius=82,circumference=2*Math.PI*radius;
  return <div className="gauge-chart">
    <div className="gauge-visual">
    <svg viewBox="0 0 200 200" role="img" aria-label={`${label} ${value}${unit}，占比 ${(clamped*100).toFixed(1)}%`}>
      <title>{`${label} ${value}${unit}，占比 ${(clamped*100).toFixed(1)}%`}</title>
      <circle cx="100" cy="100" r="94" fill="none" stroke="var(--line)" strokeWidth="1" strokeDasharray="2 7"/>
      <circle cx="100" cy="100" r={radius} fill="none" stroke="var(--surface3)" strokeWidth="9"/>
      <circle cx="100" cy="100" r={radius} fill="none" stroke="var(--action)" strokeWidth="9" strokeLinecap="round"
        strokeDasharray={`${(circumference*clamped).toFixed(1)} ${circumference.toFixed(1)}`}
        transform="rotate(-90 100 100)"/>
    </svg>
    <span className="gauge-center"><b>{value}</b><small>{unit}</small><em>{label}</em></span>
    </div>
    {boxes.length>0&&<div className="gauge-boxes">{boxes.map(box=><span key={box.label}>{box.label}<b>{box.value}</b></span>)}</div>}
    <p className="gauge-caption">{caption}</p>
  </div>;
}

export interface TrendPoint { label:string; primary:number; secondary:number }
export interface TrendChartProps { points:TrendPoint[]; primaryLabel:string; secondaryLabel:string; ariaLabel:string; formatPrimary:(value:number)=>string; formatSecondary:(value:number)=>string }

function niceMax(value:number){
  if(!Number.isFinite(value)||value<=0)return 1;
  const magnitude=10**Math.floor(Math.log10(value)),normalized=value/magnitude;
  const step=normalized<=1?1:normalized<=2?2:normalized<=5?5:10;
  return step*magnitude;
}

/** Two-series line chart on a shared plot; the left axis is the primary series. */
export function TrendChart({points,primaryLabel,secondaryLabel,ariaLabel,formatPrimary,formatSecondary}:TrendChartProps){
  const width=900,height=240,left=52,right=812,top=18,bottom=200;
  const primaryMax=niceMax(Math.max(...points.map(point=>point.primary),1));
  const secondaryMax=niceMax(Math.max(...points.map(point=>point.secondary),1));
  const stepX=points.length>1?(right-left)/(points.length-1):0;
  const x=(index:number)=>left+stepX*index;
  const yPrimary=(value:number)=>bottom-(value/primaryMax)*(bottom-top);
  const ySecondary=(value:number)=>bottom-(value/secondaryMax)*(bottom-top);
  const line=(values:number[],scale:(value:number)=>number)=>values.map((value,index)=>`${x(index).toFixed(1)},${scale(value).toFixed(1)}`).join(' ');
  const primaries=points.map(point=>point.primary),secondaries=points.map(point=>point.secondary);
  const ticks=[0,1,2,3,4];
  return <div className="trend-chart">
    <div className="trend-legend">
      <span><i className="is-secondary"/>{primaryLabel}（左轴）</span>
      {secondaries.some(value=>value>0)&&<span><i className="is-primary"/>{secondaryLabel}（右轴）</span>}
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      <title>{ariaLabel}</title>
      {ticks.map(tick=>{
        const ratio=tick/4,lineY=bottom-ratio*(bottom-top);
        return <g key={tick}>
          <line x1={left} y1={lineY} x2={right} y2={lineY} stroke="var(--line)" strokeWidth="1" strokeDasharray={tick===0?'0':'2 4'}/>
          <text x={left-8} y={lineY+4} textAnchor="end" fill="var(--muted)" fontSize="12" fontFamily="var(--v2-mono, monospace)">{formatPrimary(primaryMax*ratio)}</text>
          {secondaries.some(value=>value>0)&&<text x={right+8} y={lineY+4} textAnchor="start" fill="var(--muted)" fontSize="12" fontFamily="var(--v2-mono, monospace)">{formatSecondary(secondaryMax*ratio)}</text>}
        </g>;
      })}
      {points.map((point,index)=><text key={point.label} x={x(index)} y={bottom+24} textAnchor="middle" fill="var(--muted)" fontSize="12" fontFamily="var(--v2-mono, monospace)">{point.label.slice(5)}</text>)}
      {secondaries.some(value=>value>0)&&<polyline points={line(secondaries,ySecondary)} fill="none" stroke="var(--action)" strokeWidth="2" strokeLinejoin="round"/>}
      <polyline points={line(primaries,yPrimary)} fill="none" stroke="var(--text)" strokeWidth="2" strokeLinejoin="round"/>
      {points.map((point,index)=><g key={`${point.label}-primary`}>
        <circle cx={x(index)} cy={yPrimary(point.primary)} r="2.6" fill="var(--text)"/>
        {secondaries.some(value=>value>0)&&<circle cx={x(index)} cy={ySecondary(point.secondary)} r="2.6" fill="var(--action)"/>}
      </g>)}
    </svg>
  </div>;
}

export function ChartEmpty({children}:{children:ReactNode}){
  return <p className="secondary chart-empty">{children}</p>;
}
