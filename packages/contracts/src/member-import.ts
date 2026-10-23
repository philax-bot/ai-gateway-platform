import type { PlatformSnapshot } from './platform.js';

// CSV/TSV is deliberately parsed before submission: unknown/ambiguous columns fail closed.
function table(source:string):string[][]{
  const text=source.replace(/^\uFEFF/,'');
  if(!text.trim())throw new Error('请先选择文件或粘贴成员表格');
  if(text.length>1048576)throw new Error('成员表格最多 1 MiB');
  let quoted=false,delimiter=',';
  for(let i=0;i<text.length;i++){if(text[i]==='"')quoted=!quoted;if(!quoted&&text[i]==='\t'){delimiter='\t';break;}if(!quoted&&/[\r\n]/.test(text[i]))break;}
  const rows:string[][]=[];let row:string[]=[],cell='',inside=false,closed=false;
  const push=()=>{row.push(cell.trim());cell='';closed=false;};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inside){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{inside=false;closed=true;}}else cell+=c;continue;}
    if(c===delimiter){push();continue;}
    if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;push();if(row.some(Boolean))rows.push(row);row=[];continue;}
    if(c==='"'){if(cell.trim()||closed)throw new Error('引号必须位于单元格起始处');inside=true;cell='';continue;}
    if(closed&&!/\s/.test(c))throw new Error('引号结束后只能是分隔符或换行');
    cell+=c;
  }
  if(inside)throw new Error('表格引号未闭合');push();if(row.some(Boolean))rows.push(row);
  return rows;
}
const headers:Record<string,string>={directoryId:'directoryId','登录账号':'directoryId','登录标识':'directoryId','目录标识':'directoryId',name:'name','姓名':'name',organizationId:'organizationId','组织':'organizationId','主要组织':'organizationId',category:'category','人员类别':'category',tags:'tags','业务标签':'tags',active:'active','状态':'active',validUntil:'validUntil','有效日期':'validUntil',sponsorId:'sponsorId','责任人登录账号':'sponsorId','责任人登录标识':'sponsorId'};
const columnLabels:Record<string,string>={directoryId:'登录账号',name:'姓名',organizationId:'组织'};
export function parseMemberImport(source:string,context:Pick<PlatformSnapshot,'organizations'|'members'>):Record<string,unknown>[] {
  const [first,...rows]=table(source);if(!first||!rows.length)throw new Error('表格需要表头和至少一行成员');
  const columns=first.map(h=>{if(!Object.hasOwn(headers,h))throw new Error(`不支持的列：${h}。导入不接受密码和职责列`);return headers[h];});
  if(new Set(columns).size!==columns.length)throw new Error('表头包含重复字段');
  for(const required of ['directoryId','name','organizationId'])if(!columns.includes(required))throw new Error(`缺少必填列：${columnLabels[required]}`);
  if(rows.length>1000)throw new Error('每次最多导入 1000 名成员');
  const seen=new Set<string>();
  return rows.map((cells,index)=>{
    const fail=(message:string):never=>{throw new Error(`第 ${index+2} 行：${message}`);};
    if(cells.length!==columns.length)fail('列数与表头不一致');
    const raw=Object.fromEntries(columns.map((key,i)=>[key,cells[i]])),row:Record<string,unknown>={...raw};
    for(const required of ['directoryId','name','organizationId'])if(!raw[required])fail(`${columnLabels[required]} 不能为空`);
    if(seen.has(raw.directoryId))fail('登录账号重复');seen.add(raw.directoryId);
    const organizations=context.organizations.filter(o=>o.id===raw.organizationId||o.name===raw.organizationId);
    if(organizations.length!==1)fail('组织不存在或同名，请填写准确的组织 ID');row.organizationId=organizations[0].id;
    if('category' in raw){const categories:Record<string,string>={employee:'employee','员工':'employee',contractor:'contractor','外包':'contractor','外部协作':'contractor'};if(!Object.hasOwn(categories,raw.category))fail('人员类别应为员工或外部协作');row.category=categories[raw.category];}
    if('active' in raw){const statuses:Record<string,boolean>={'启用':true,'停用':false,true:true,false:false,'1':true,'0':false};if(!Object.hasOwn(statuses,raw.active))fail('状态应为启用或停用');row.active=statuses[raw.active];}
    if('tags' in raw)row.tags=raw.tags.split(/[,;；、]/).map(t=>t.trim()).filter(Boolean);
    if('validUntil' in raw){const value=raw.validUntil;if(!value)row.validUntil=null;else if(/^\d{4}-\d{2}-\d{2}$/.test(value)){
      const timestamp=`${value}T23:59:59.999+08:00`,parsed=new Date(timestamp);if(!Number.isFinite(parsed.getTime())||new Date(parsed.getTime()+8*3600000).toISOString().slice(0,10)!==value)fail('无效日期');row.validUntil=timestamp;
    }else{if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))fail('有效日期应为 YYYY-MM-DD 或带时区的时间');row.validUntil=value;}}
    if('sponsorId' in raw){if(!raw.sponsorId)row.sponsorId=null;else{const sponsor=context.members.find(m=>m.directoryId===raw.sponsorId);if(!sponsor)fail('责任人登录账号不存在');row.sponsorId=sponsor!.id;}}
    return row;
  });
}
