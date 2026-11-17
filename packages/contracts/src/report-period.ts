export const usagePeriods=[['today','今天'],['yesterday','昨天'],['last7','近7天'],['last30','近30天'],['month','本月至今'],['previousMonth','上月']] as const;
export type UsagePeriod=typeof usagePeriods[number][0];
const offset=8*3600000,day=86400000;
/** Workspace uses Asia/Shanghai. Resolve all shortcuts against one instant. */
export function usagePeriodWindow(period:UsagePeriod,now=new Date()):{from:string;to:string}{
  const local=new Date(now.getTime()+offset),today=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-offset;
  let from:number,to=now.getTime();
  switch(period){
    case 'today':from=today;break;
    case 'yesterday':from=today-day;to=today;break;
    case 'last7':from=today-6*day;break;
    case 'last30':from=today-29*day;break;
    case 'month':from=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),1)-offset;break;
    case 'previousMonth':from=Date.UTC(local.getUTCFullYear(),local.getUTCMonth()-1,1)-offset;to=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),1)-offset;break;
    default:throw new Error('unknown report period');
  }
  return {from:new Date(from).toISOString(),to:new Date(to).toISOString()};
}
export const reportLocalTime=(value:Date)=>new Date(value.getTime()+offset).toISOString().slice(0,16);
export const reportIsoTime=(value:string)=>value?new Date(`${value}:00+08:00`).toISOString():undefined;
