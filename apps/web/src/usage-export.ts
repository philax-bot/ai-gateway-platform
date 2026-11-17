import type { UsageAnalytics, UsageAnalyticsQuery, UsageBucket } from '@ai-gateway/contracts';
import {reportLocalTime} from '@ai-gateway/contracts';
import type { UsageNames } from './usage-shared';

type Cell=string|number|null;
export function usageExportTables(report:UsageAnalytics,names:UsageNames,query:UsageAnalyticsQuery={}){
  const withCost=!!report.totals.cost;
  const headers=['主体','主体标识','请求数','未知用量记录','输入Token（含缓存）','输出Token','缓存输入Token','已确认计费（元）','待核对记录','待核对预占（元）',...(withCost?['已知估算成本（元）','成本未知记录','可比计费（元）','可比成本（元）','可比差额（元）']:[]),'异常','已转发','上游故障'];
  const cells=(row:UsageBucket,label:string):Cell[]=>[label,row.key,row.requests,row.unknownUsage,row.inputTokens,row.outputTokens,row.cachedInputTokens,row.confirmedAmount,row.pendingReview,row.pendingReview>0&&row.pendingAmount===0?null:row.pendingAmount,...(withCost?[row.cost&&row.cost.unknownRequests<row.requests||row.requests===0?row.cost?.knownAmount??0:null,row.cost?.unknownRequests??row.requests,row.cost?.comparableRequests?row.cost.comparableBilledAmount:null,row.cost?.comparableRequests?row.cost.comparableCostAmount:null,row.cost?.comparableRequests?row.cost.differenceAmount:null]:[]),row.errors,row.forwarded,row.upstreamFailures];
  const groups:[string,UsageBucket[],(key:string)=>string][]=[
    ['汇总',[{...report.totals,key:'',lastActiveAt:null}],()=> '全部'],
    ['逐日',report.days,key=>key],['组织',report.organizations,names.organization],['项目',report.projects,names.project],
    ['应用',report.applications,key=>names.application(key)??'未识别应用'],['人员',report.people,names.subject],['模型',report.models,names.model],['服务来源',report.services,names.service],
  ];
  const metadata:Cell[][]=[['统计起始（含）',report.from],['统计截止（不含）',report.to],['统计时区',report.timezone],['数据生成时间',report.collectedAt],['筛选条件',JSON.stringify(query)],['统计口径','按已结束调用的完成时间；Token只计完整usage，缓存是输入子集；待核对预占不计入已确认计费。'],['成本口径','配置价格估算，非供应商账单；未知留空，成本列为已知部分。平台连接验证独立，不在此表。'],['差额口径','只比较同一批已确认计费且成本已知的调用，非财务利润。'],['维度口径','人员与应用合计覆盖全部主体；其他完整维度各自汇总。不同Sheet不可相加。']];
  return {metadata,tables:groups.map(([name,rows,label])=>({name,rows:[headers,...rows.map(row=>cells(row,label(row.key)))]}))};
}

/** Neutralize spreadsheet formula interpretation only for CSV text; XLSX cells are typed. */
export const csvCell=(value:Cell)=>{
  const raw=value===null?'':typeof value==='string'&&/^[\s]*[=+\-@]/.test(value)?`'${value}`:String(value);
  return /[",\r\n]/.test(raw)?`"${raw.replaceAll('"','""')}"`:raw;
};
function download(data:Blob,filename:string){
  const url=URL.createObjectURL(data),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const filename=(report:UsageAnalytics,extension:string)=>`用量计费报表-${reportLocalTime(new Date(report.from)).slice(0,10)}-${reportLocalTime(new Date(Date.parse(report.to)-1)).slice(0,10)}.${extension}`;
export function exportUsageCsv(report:UsageAnalytics,names:UsageNames,query:UsageAnalyticsQuery={}){
  const {metadata,tables}=usageExportTables(report,names,query);
  const rows:Cell[][]=[...metadata,[],['维度',...tables[0].rows[0]],...tables.flatMap(table=>table.rows.slice(1).map(row=>[table.name,...row]))];
  download(new Blob(['\ufeff',rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),filename(report,'csv'));
  return `已导出 ${rows.length-metadata.length-2} 行 CSV，范围与当前查询一致。`;
}
export async function exportUsageExcel(report:UsageAnalytics,names:UsageNames,query:UsageAnalyticsQuery={}){
  const ExcelJS=await import('exceljs'),workbook=new ExcelJS.default.Workbook();
  workbook.creator='AI Gateway Platform';workbook.created=new Date(report.collectedAt);
  const {metadata,tables}=usageExportTables(report,names,query);
  const notes=workbook.addWorksheet('报表说明');notes.addRows(metadata);notes.getColumn(1).width=24;notes.getColumn(2).width=110;notes.getColumn(2).alignment={wrapText:true,vertical:'top'};
  for(const table of tables){
    const sheet=workbook.addWorksheet(table.name,{views:[{state:'frozen',ySplit:1}]});sheet.addRows(table.rows);
    sheet.columns.forEach((column,index)=>{column.width=index===0?26:index===1?40:20;if(index>=2)column.numFmt='#,##0.######;[Red]-#,##0.######';});
    sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF353344'}};
    sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:table.rows[0].length}};
  }
  const data=await workbook.xlsx.writeBuffer();
  download(new Blob([new Uint8Array(data)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),filename(report,'xlsx'));
  return `已导出 Excel，共 ${tables.length} 个统计 Sheet 和报表说明，范围与当前查询一致。`;
}
