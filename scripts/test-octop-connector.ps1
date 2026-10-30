param([string]$HelperPath=(Join-Path $PSScriptRoot '../apps/web/public/octop-connector.ps1'))
$ErrorActionPreference='Stop'
$directory=Join-Path ([IO.Path]::GetTempPath()) ('octop-connector-test-'+[Guid]::NewGuid())
New-Item -ItemType Directory -Path $directory|Out-Null
$helper=Join-Path $directory 'helper.ps1'
[IO.File]::WriteAllText($helper,[IO.File]::ReadAllText((Resolve-Path $HelperPath)),(New-Object Text.UTF8Encoding($true)))
$checks=0
function Check([bool]$Value,[string]$Message){if(!$Value){throw $Message};$script:checks++}
function Reject([scriptblock]$Action){try{& $Action|Out-Null}catch{$script:checks++;return};throw 'Expected validation rejection'}
try {
  . $helper -LibraryOnly
  $ticket='a'*43
  Check ((Get-ImportTicket ('signal-octop://import?v=1&ticket='+$ticket)) -eq $ticket) 'ticket parser'
  foreach($uri in @(('https://import?v=1&ticket='+$ticket),('signal-octop://other?v=1&ticket='+$ticket),'signal-octop://import?v=1&ticket=short',('signal-octop://import?v=1&ticket='+$ticket+'&extra=1'),('signal-octop://import?v=1&v=1&ticket='+$ticket),('signal-octop://import:80?v=1&ticket='+$ticket))){Reject {Get-ImportTicket $uri}}
  Check ((Assert-PlatformUrl 'https://api.example.com') -eq 'https://api.example.com') 'platform HTTPS'
  foreach($url in @('http://evil.example','https://user:password@example.com','https://api.example.com?q=key','https://api.example.com/#secret')){Reject {Assert-PlatformUrl $url}}
  [IO.File]::WriteAllText((Join-Path $directory 'desktop-port'),'12345')
  Check ((Get-OctopBase $directory) -eq 'http://127.0.0.1:12345') 'desktop port discovery'
  [IO.File]::WriteAllText((Join-Path $directory 'desktop-port'),'65536');Reject {Get-OctopBase $directory}
  Remove-Item -LiteralPath (Join-Path $directory 'desktop-port')
  [IO.File]::WriteAllText((Join-Path $directory 'desktop-settings.json'),'{"port":23456}')
  Check ((Get-OctopBase $directory) -eq 'http://127.0.0.1:23456') 'desktop settings port fallback'
  Remove-Item -LiteralPath (Join-Path $directory 'desktop-settings.json')
  [IO.File]::WriteAllText((Join-Path $directory 'config.json'),'{"port":34567}')
  Check ((Get-OctopBase $directory) -eq 'http://127.0.0.1:34567') 'server config port fallback'
  Remove-Item -LiteralPath (Join-Path $directory 'config.json')
  Check ((Get-OctopBase $directory) -eq 'http://127.0.0.1:8088') 'default local port'
  $config=[PSCustomObject]@{version=1;keyId='key-test';providerName='Signal Atlas key-test';apiKey='qa-not-a-real-key';baseUrl='https://api.example.com/v1';models=@([PSCustomObject]@{id='test-model';name='Test';enabled=$true;api_mode='chat_completions';api_fallback='none'})}
  $script:calls=New-Object Collections.Generic.List[object]
  $script:providers=@([PSCustomObject]@{id=1;name='existing-user-provider';note='user configuration'})
  function Invoke-Json([string]$Base,[string]$Path,$Body=$null,[string]$Token='',[string]$Method='GET'){
    $script:calls.Add(@{Path=$Path;Method=$Method;Body=$Body})
    if($Method -eq 'GET'){return $script:providers};return [PSCustomObject]@{id=2}
  }
  Import-OctopProvider 'http://127.0.0.1:12345' 'qa-local-jwt' $config 'https://platform.example.com'
  Check ($script:calls.Count -eq 2 -and $script:calls[1].Method -eq 'POST') 'create only managed provider'
  Check ($script:calls[1].Body.stream_usage -and $script:calls[1].Body.models[0].api_mode -eq 'chat_completions') 'usage and protocol preserved'
  Check ($script:calls[0].Path -eq '/api/admin/providers' -and $script:providers[0].name -eq 'existing-user-provider') 'existing provider preserved'
  $script:providers=@([PSCustomObject]@{id=2;name=$config.providerName;note='signal-atlas:keyId=key-test;origin=https://platform.example.com'})
  $script:calls.Clear();Import-OctopProvider 'http://127.0.0.1:12345' 'qa-local-jwt' $config 'https://platform.example.com' $true
  Check ($script:calls[1].Method -eq 'PATCH') 'repeat import patches same owned provider'
  Check ($script:calls[2].Method -eq 'PUT' -and $script:calls[2].Body.model -eq 'test-model') 'explicit default model opt-in'
  $script:providers[0].note='belongs to user';$script:calls.Clear();Reject {Import-OctopProvider 'http://127.0.0.1:12345' 'qa-local-jwt' $config 'https://platform.example.com'}
  Check ($script:calls.Count -eq 1) 'conflicting provider never overwritten'
  Reject {Import-OctopProvider 'https://remote.example.com' 'qa-local-jwt' $config 'https://platform.example.com'}
  $protected=ConvertFrom-SecureString (ConvertTo-SecureString 'qa-local-jwt' -AsPlainText -Force)
  Check (!$protected.Contains('qa-local-jwt')) 'DPAPI output contains no plaintext token'
  Check ([Net.NetworkCredential]::new('',(ConvertTo-SecureString $protected)).Password -eq 'qa-local-jwt') 'DPAPI round trip'
  Write-Output ('PASS '+$checks+' Windows connector checks')
}finally{if(Test-Path -LiteralPath $directory){Remove-Item -LiteralPath $helper -Force;Remove-Item -LiteralPath (Join-Path $directory 'desktop-port') -Force -ErrorAction SilentlyContinue;Remove-Item -LiteralPath $directory -Force}}
