param([string]$ImportUri,[switch]$LibraryOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($PSVersionTable.PSEdition -eq 'Desktop'){$env:PSModulePath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'}

function Assert-PlatformUrl([string]$Value) {
  $u=[Uri]$Value
  if(!$u.IsAbsoluteUri -or $u.UserInfo -or $u.Query -or $u.Fragment -or !($u.Scheme -eq 'https' -or ($u.Scheme -eq 'http' -and $u.Host -in @('127.0.0.1','localhost','[::1]')))){throw 'Invalid platform URL'}
  return $u.AbsoluteUri.TrimEnd('/')
}
function Get-ImportTicket([string]$Value) {
  if($Value.Length -gt 512){throw 'Invalid import link'}
  $u=[Uri]$Value
  if($u.Scheme -ne 'signal-octop' -or $u.Host -ne 'import' -or $u.Port -ne -1 -or $u.AbsolutePath -notin @('','/') -or $u.UserInfo -or $u.Fragment){throw 'Invalid import link'}
  $parameters=@{}
  foreach($part in $u.Query.TrimStart('?').Split('&')){$pair=$part.Split('=',2);if($pair.Count -ne 2 -or $parameters.ContainsKey($pair[0])){throw 'Invalid import link'};$parameters[$pair[0]]=[Uri]::UnescapeDataString($pair[1])}
  if($parameters.Count -ne 2 -or $parameters['v'] -ne '1' -or $parameters['ticket'] -cnotmatch '^[A-Za-z0-9_-]{43}$'){throw 'Invalid import link'}
  return $parameters['ticket']
}
function Invoke-Json([string]$Base,[string]$Path,$Body=$null,[string]$Token='',[string]$Method='GET') {
  $headers=@{};if($Token){$headers.Authorization='Bearer '+$Token}
  $args=@{Uri=($Base+$Path);Method=$Method;Headers=$headers;TimeoutSec=20;MaximumRedirection=0;ErrorAction='Stop'}
  if($null -ne $Body){$args.ContentType='application/json; charset=utf-8';$args.Body=[Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 15 -Compress))}
  $response=Invoke-RestMethod @args
  return $response
}
function Get-OctopBase([string]$OctopHome) {
  $port=8088
  foreach($candidate in @('desktop-port','desktop-settings.json','config.json')){
    $path=Join-Path $OctopHome $candidate
    if(Test-Path -LiteralPath $path){
      $raw=[IO.File]::ReadAllText($path)
      if($candidate -eq 'desktop-port'){$value=$raw.Trim()}else{$settings=$raw|ConvertFrom-Json;if(!$settings.PSObject.Properties['port']){continue};$value=[string]$settings.port}
      if($value -notmatch '^\d{1,5}$' -or [int]$value -lt 1 -or [int]$value -gt 65535){throw 'Invalid local Octop port'}
      $port=[int]$value;break
    }
  }
  return 'http://127.0.0.1:'+$port
}
function Assert-ImportConfig($Config) {
  if($Config.version -ne 1 -or $Config.keyId -cnotmatch '^[A-Za-z0-9_-]{1,150}$' -or $Config.providerName -ne ('Signal Atlas '+$Config.keyId) -or !$Config.apiKey -or $Config.apiKey.Length -gt 512){throw 'Invalid import configuration'}
  $null=Assert-PlatformUrl $Config.baseUrl
  if(([Uri]$Config.baseUrl).AbsolutePath -notmatch '/v1$'){throw 'Unsupported API format'}
  $models=@($Config.models);if($models.Count -lt 1 -or $models.Count -gt 200){throw 'Invalid model list'}
  foreach($m in $models){if(!$m.id -or $m.id.Length -gt 200 -or $m.api_mode -ne 'chat_completions' -or $m.api_fallback -ne 'none' -or !$m.enabled){throw 'Unsupported model configuration'}}
}
function Import-OctopProvider([string]$Base,[string]$Token,$Config,[string]$Platform,[bool]$MakeDefault=$false) {
  Assert-ImportConfig $Config
  if($Base -cnotmatch '^http://127\.0\.0\.1:\d{1,5}$'){throw 'Octop must use loopback'}
  $note='signal-atlas:keyId='+$Config.keyId+';origin='+$Platform
  $providers=@(Invoke-Json $Base '/api/admin/providers' $null $Token)
  $found=@($providers|Where-Object {$_.name -eq $Config.providerName})
  if($found.Count -gt 1 -or ($found.Count -eq 1 -and $found[0].note -ne $note)){throw 'Provider name conflict; existing configuration was preserved'}
  $body=@{kind='openai';base_url=$Config.baseUrl;api_key=$Config.apiKey;models=@($Config.models);stream_usage=$true;purpose='chat';note=$note}
  if($found.Count -eq 1){$id=[string]$found[0].id;if($id -notmatch '^\d+$'){throw 'Invalid provider identity'};$null=Invoke-Json $Base ('/api/admin/providers/'+$id) $body $Token 'PATCH'}
  else{$body.name=$Config.providerName;$null=Invoke-Json $Base '/api/admin/providers' $body $Token 'POST'}
  if($MakeDefault){$null=Invoke-Json $Base '/api/providers/active-model' @{provider_name=$Config.providerName;model=$Config.models[0].id} $Token 'PUT'}
}
function Show-OctopLogin([string]$Base) {
  $form=New-Object Windows.Forms.Form;$form.Text='登录本机 Octop';$form.ClientSize=New-Object Drawing.Size(480,260);$form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false
  $caption=New-Object Windows.Forms.Label;$caption.Text="本机地址：$Base`n请输入有模型服务管理权限的 Octop 账号，凭据仅发送到本机。";$caption.SetBounds(18,15,444,45);$form.Controls.Add($caption)
  $nameLabel=New-Object Windows.Forms.Label;$nameLabel.Text='Octop 用户名';$nameLabel.SetBounds(18,70,110,25);$form.Controls.Add($nameLabel)
  $name=New-Object Windows.Forms.TextBox;$name.SetBounds(135,67,320,27);$name.Text='admin';$form.Controls.Add($name)
  $passLabel=New-Object Windows.Forms.Label;$passLabel.Text='Octop 密码';$passLabel.SetBounds(18,108,110,25);$form.Controls.Add($passLabel)
  $password=New-Object Windows.Forms.TextBox;$password.UseSystemPasswordChar=$true;$password.SetBounds(135,105,320,27);$form.Controls.Add($password)
  $show=New-Object Windows.Forms.CheckBox;$show.Text='显示密码';$show.SetBounds(135,140,120,25);$show.Add_CheckedChanged({$password.UseSystemPasswordChar=!$show.Checked});$form.Controls.Add($show)
  $remember=New-Object Windows.Forms.CheckBox;$remember.Text='记住本机登录（Windows 加密保存登录令牌）';$remember.Checked=$true;$remember.SetBounds(18,175,440,25);$form.Controls.Add($remember)
  $cancel=New-Object Windows.Forms.Button;$cancel.Text='取消';$cancel.DialogResult='Cancel';$cancel.SetBounds(235,215,105,30);$form.Controls.Add($cancel);$form.CancelButton=$cancel
  $ok=New-Object Windows.Forms.Button;$ok.Text='登录';$ok.DialogResult='OK';$ok.SetBounds(350,215,105,30);$form.Controls.Add($ok);$form.AcceptButton=$ok
  $result=$form.ShowDialog();if($result -ne 'OK'){$form.Dispose();return $null}
  $value=@{username=$name.Text;password=$password.Text;remember=$remember.Checked};$password.Clear();$form.Dispose();return $value
}
function Show-ImportConfirmation($Config,[string]$Base) {
  $form=New-Object Windows.Forms.Form;$form.Text='导入到本机 Octop';$form.ClientSize=New-Object Drawing.Size(560,360);$form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false
  $summary=New-Object Windows.Forms.Label;$summary.SetBounds(20,15,520,225);$summary.Text="Octop：$Base`n`n服务商：$($Config.providerName)`nAPI 地址：$($Config.baseUrl)`n模型：$((@($Config.models)|Select-Object -First 5|ForEach-Object {if($_.PSObject.Properties['context_window']){$_.id+' ('+$_.context_window+' Token)'}else{$_.id}}) -join ', ')（共 $(@($Config.models).Count) 个）`n`n将添加平台服务商，保留其他服务商配置。`n该 Octop 实例内的其他账号也可能使用这把 Key，请用于个人实例。";$form.Controls.Add($summary)
  $default=New-Object Windows.Forms.CheckBox;$default.Text='设为 Octop 全局默认模型（不覆盖 Agent 自己的模型选择）';$default.SetBounds(20,250,520,30);$form.Controls.Add($default)
  $cancel=New-Object Windows.Forms.Button;$cancel.Text='取消';$cancel.DialogResult='Cancel';$cancel.SetBounds(310,305,105,32);$form.Controls.Add($cancel);$form.CancelButton=$cancel
  $ok=New-Object Windows.Forms.Button;$ok.Text='导入配置';$ok.DialogResult='OK';$ok.SetBounds(430,305,105,32);$form.Controls.Add($ok);$form.AcceptButton=$ok
  $result=$form.ShowDialog();$value=@{confirmed=($result -eq 'OK');makeDefault=$default.Checked};$form.Dispose();return $value
}
function Start-OctopImport([string]$Value,[string]$Directory) {
  Add-Type -AssemblyName System.Windows.Forms
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  $claim=$null;$platform=$null;$completed=$false;$lock=$null;$locked=$false
  try {
    $lock=New-Object Threading.Mutex($false,('Local\SignalAtlasOctopConnector-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
    try{$locked=$lock.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
    if(!$locked){$null=[Windows.Forms.MessageBox]::Show('另一项 Octop 导入正在进行，请完成后再点击导入。','Octop 接入','OK','Information');return}
    $settings=Get-Content -LiteralPath (Join-Path $Directory 'connector.json') -Raw|ConvertFrom-Json
    $platform=Assert-PlatformUrl $settings.platformUrl;$ticket=Get-ImportTicket $Value
    $octopHome=if($env:OCTOP_HOME){$env:OCTOP_HOME}else{Join-Path $env:USERPROFILE '.octop'}
    $base=Get-OctopBase $octopHome
    $null=Invoke-Json $base '/api/health'
    $claim=Invoke-Json $platform '/api/v1/platform/local-octop/imports/claim' @{ticket=$ticket} '' 'POST'
    Assert-ImportConfig $claim.config
    $confirmation=Show-ImportConfirmation $claim.config $base
    if(!$confirmation.confirmed){return}
    $cache=Join-Path $Directory 'local-login.json';$token=''
    if(Test-Path -LiteralPath $cache){try{$saved=Get-Content -LiteralPath $cache -Raw|ConvertFrom-Json;if($saved.base -eq $base){$secret=ConvertTo-SecureString $saved.token;$token=[Net.NetworkCredential]::new('',$secret).Password;$null=Invoke-Json $base '/api/admin/providers' $null $token}}catch{$token=''}}
    if(!$token){
      $credentials=Show-OctopLogin $base;if(!$credentials){return}
      try{$login=Invoke-Json $base '/api/auth/login' @{username=$credentials.username;password=$credentials.password} '' 'POST';$token=$login.access_token;$null=Invoke-Json $base '/api/admin/providers' $null $token}
      finally{$credentials.password=''}
      if($credentials.remember){$encrypted=ConvertFrom-SecureString (ConvertTo-SecureString $token -AsPlainText -Force);@{base=$base;token=$encrypted}|ConvertTo-Json|Set-Content -LiteralPath $cache -Encoding UTF8}
    }
    if([DateTimeOffset]::Parse($claim.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'Import expired'}
    Import-OctopProvider $base $token $claim.config $platform $confirmation.makeDefault
    $completed=$true
    try{$null=Invoke-Json $platform '/api/v1/platform/local-octop/imports/complete' @{id=$claim.id;receipt=$claim.receipt;status='completed'} '' 'POST';$message='已导入本机 Octop。可在模型服务中选择平台模型。'}catch{$message='配置已导入本机 Octop，但网页未收到回执。请在 Octop 模型服务中核对，避免重复操作。'}
    $null=[Windows.Forms.MessageBox]::Show($message,'导入完成','OK','Information')
  }catch{$null=[Windows.Forms.MessageBox]::Show('导入未完成。请确认 Octop 桌面版已启动、账号有模型服务管理权限，且网页兑换码未过期；刷新网页后可重新发起。已有其他服务商配置会保留。','Octop 接入','OK','Warning')}
  finally{if($claim -and !$completed -and $platform){try{$null=Invoke-Json $platform '/api/v1/platform/local-octop/imports/complete' @{id=$claim.id;receipt=$claim.receipt;status='failed'} '' 'POST'}catch{}};if($claim){$claim.config.apiKey=''};$token='';if($locked){$lock.ReleaseMutex()};if($lock){$lock.Dispose()}}
}
if(!$LibraryOnly){Start-OctopImport $ImportUri $PSScriptRoot}
