import {useEffect,useId,useState} from 'react';
import {api,ApiError,controlPlaneBaseUrl} from './client';
import {PasswordInput} from './password-field';

const endpoint='/api/v1/platform/local-octop/imports';
async function downloadInstaller(){
  const base=new URL(controlPlaneBaseUrl);if(base.username||base.password||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)))throw Error('平台接入地址需要 HTTPS，本地开发可使用回环地址。');
  const response=await fetch(`${import.meta.env.BASE_URL}octop-connector.ps1`,{cache:'no-store'});if(!response.ok)throw Error('接入器下载失败，请稍后重试。');const connector=await response.text();
  if(!connector.trimStart().startsWith('param(')||!connector.includes('function Start-OctopImport'))throw Error('接入器文件不完整，请联系平台管理员。');
  const platform=base.toString().replace(/\/$/,''),encoded=btoa(String.fromCharCode(...new TextEncoder().encode(connector)));
  const script=`param([switch]$ValidateOnly)
$ErrorActionPreference='Stop'
$windowsPowerShell=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
if($PSVersionTable.PSEdition -eq 'Core'){& $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @PSBoundParameters;exit $LASTEXITCODE}
$env:PSModulePath=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules'
$helperSource=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$null=[ScriptBlock]::Create($helperSource)
if($ValidateOnly){Write-Output 'VALID Octop connector installer';exit}
Add-Type -AssemblyName System.Windows.Forms
$choice=[Windows.Forms.MessageBox]::Show('此接入器只为当前 Windows 用户注册 signal-octop 导入入口，并连接到 ${platform.replace(/'/g,"''")}。保留官方 Octop 安装。是否继续？','安装 Octop 接入器','YesNo','Question')
if($choice -ne 'Yes'){exit}
$directory=Join-Path $env:LOCALAPPDATA 'SignalAtlas\\OctopConnector'
$handler=Join-Path $directory 'octop-connector.ps1'
$key='HKCU:\\Software\\Classes\\signal-octop'
$command='"'+$windowsPowerShell+'" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$handler+'" "%1"'
if(Test-Path -LiteralPath $key){$existing=(Get-ItemProperty -LiteralPath ($key+'\\shell\\open\\command') -ErrorAction SilentlyContinue).'(default)';if($existing -and $existing -ne $command){throw 'signal-octop is registered by another application'}}
New-Item -ItemType Directory -Path $directory -Force|Out-Null
$utf8=New-Object Text.UTF8Encoding($true)
[IO.File]::WriteAllText($handler,$helperSource,$utf8)
[IO.File]::WriteAllText((Join-Path $directory 'connector.json'),(@{version=1;platformUrl='${platform.replace(/'/g,"''")}'}|ConvertTo-Json),$utf8)
$acl=Get-Acl -LiteralPath $directory
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.SetAccessRule($rule);Set-Acl -LiteralPath $directory -AclObject $acl
New-Item -Path ($key+'\\shell\\open\\command') -Force|Out-Null
Set-Item -LiteralPath $key -Value 'URL:Signal Atlas Octop Connector'
New-ItemProperty -LiteralPath $key -Name 'URL Protocol' -Value '' -Force|Out-Null
Set-Item -LiteralPath ($key+'\\shell\\open\\command') -Value $command
[Windows.Forms.MessageBox]::Show('安装完成。请启动官方 Octop，然后回到网页点击导入。','Octop 接入器')|Out-Null
`;
  const url=URL.createObjectURL(new Blob(['\uFEFF',script],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='安装-Octop-接入器.ps1';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function LocalOctopConnect({keyId,issuedSecret,canImport=true}:{keyId:string;issuedSecret?:string;canImport?:boolean}){
  const [secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[handoff,setHandoff]=useState<{id:string;expiresAt:string}|null>(null),id=useId();
  useEffect(()=>{
    if(!handoff)return;let disposed=false,checking=false;const check=async()=>{if(checking)return;checking=true;try{const value=await api<{status:string}>(`${endpoint}/${handoff.id}`);if(disposed)return;if(value.status==='completed'){setNotice('本机接入器已确认配置导入完成，可在 Octop 中选择平台模型。');setHandoff(null);}else if(value.status==='failed'){setError('本机导入未完成或已取消。请确认 Octop 已启动并重新发起。');setHandoff(null);}else if(Date.now()>Date.parse(handoff.expiresAt)){setError('导入已过期，请重新发起。');setHandoff(null);}}catch(e){if(!disposed&&e instanceof ApiError&&[401,403,404].includes(e.status)){setError('登录状态或导入记录已失效，请刷新后重试。');setHandoff(null);}}finally{checking=false;}};
    const timer=setInterval(()=>void check(),1500);return()=>{disposed=true;clearInterval(timer);};
  },[handoff]);
  async function launch(){
    setBusy(true);setError('');setNotice('');try{const result=await api<{id:string;expiresAt:string;url:string}>(endpoint,{keyId,apiKey:(issuedSecret??secret).trim()});const url=new URL(result.url);if(url.protocol!=='signal-octop:'||url.hostname!=='import')throw Error('导入地址无效。');setHandoff({id:result.id,expiresAt:result.expiresAt});setNotice('已请求打开本机接入器，请在浏览器选择允许打开，并在本机确认导入。');window.location.assign(result.url);}catch(e){setError(e instanceof ApiError&&e.status===409?'暂时无法创建导入，请刷新确认密钥和模型状态；频繁操作时请稍后重试。':e instanceof Error?e.message:'导入未发起，请重试。');}finally{setBusy(false);}
  }
  return <div>
    <h3>导入本地 Octop</h3><p className="secondary">将这把密钥、接入地址和可用模型交给本机 Octop。首次安装接入器后，启动官方 Octop，再点击导入。模型调用仍按本密钥用途扣费。</p>
    {!issuedSecret&&<label className="form-field" htmlFor={id}>本次导入使用的完整密钥<PasswordInput id={id} value={secret} onChange={setSecret} autoComplete="off"/></label>}
    {!canImport&&<p className="notice warning">当前密钥不是本人所有或已失效，请使用本人的有效密钥。</p>}
    <div className="actions"><button type="button" className="ghost" disabled={busy} onClick={()=>{setBusy(true);void downloadInstaller().then(()=>{setNotice('已下载安装脚本。首次在 Windows 下载目录中运行它，完成后回到此处导入。');setError('');}).catch(e=>setError(e instanceof Error?e.message:'下载失败，请重试。')).finally(()=>setBusy(false));}}>首次安装接入器</button><button type="button" className="ghost" disabled={busy||!canImport||!(issuedSecret??secret).trim()} onClick={()=>void launch()}>{busy?'正在准备导入…':handoff?'重新发起导入':'导入本地 Octop'}</button></div>
    <p className="secondary">没有反应时，请确认接入器已安装并允许浏览器打开应用。导入码 5 分钟有效；本机 Octop 登录凭据只在本机使用。完整 Key 不会放入唤起链接。</p>
    {notice&&<p className="notice" role="status">{notice}</p>}{error&&<p className="notice danger" role="alert">{error}</p>}
  </div>;
}
