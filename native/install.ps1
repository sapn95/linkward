# Install the native messaging helper for linkward on Windows.
#
# A Firefox extension cannot start another application. This registers a small
# node script with Firefox so the picker can hand a link to a browser that is
# not Firefox. Nothing else goes through it.
#
# Windows differs from macOS and Linux in two ways, and both are the reason this
# is a separate script rather than a branch in install.sh:
#
#   1. Firefox finds the manifest through the REGISTRY, not a directory.
#   2. The manifest must point at something Windows can execute. A .mjs is not,
#      so a .cmd wrapper is written beside it and that is what gets registered.
#
# Safe to run again. It rewrites the manifest, the wrapper and the key.

$ErrorActionPreference = 'Stop'

$Name  = 'ch.sapn.linkward'
$ExtId = 'linkward@sapn95.github.io'
$Here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Host_ = Join-Path $Here 'host.mjs'

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { Write-Error 'node is not on PATH; the helper is a node script' }
if (-not (Test-Path $Host_)) { Write-Error "missing $Host_" }

# The wrapper. %* forwards nothing today, and is there because Firefox is
# entitled to pass arguments and a wrapper that swallowed them would be a bug
# waiting for the first time it does.
$Wrapper = Join-Path $Here 'host.cmd'
# node by ABSOLUTE path. Firefox starts the helper with a minimal environment,
# so a bare `node` is not found wherever it actually lives — measured on macOS,
# where Firefox has PATH=/usr/bin:/bin:/usr/sbin:/sbin and node does not.
"@echo off`r`n`"$Node`" `"$Host_`" %*" | Set-Content -Path $Wrapper -Encoding ASCII

$Manifest = Join-Path $Here "$Name.json"
@{
  name               = $Name
  description        = 'Opens a link in another browser for linkward'
  path               = $Wrapper
  type               = 'stdio'
  allowed_extensions = @($ExtId)
} | ConvertTo-Json -Depth 3 | Set-Content -Path $Manifest -Encoding UTF8

# HKCU, so no administrator is needed and the helper belongs to the user whose
# Firefox profile it serves.
$Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$Name"
New-Item -Path $Key -Force | Out-Null
Set-ItemProperty -Path $Key -Name '(Default)' -Value $Manifest

Write-Host "installed $Manifest"
Write-Host "  wrapper: $Wrapper"
Write-Host "  key:     $Key"
Write-Host ''
Write-Host 'Now switch it on in linkward''s settings. Firefox asks for the'
Write-Host '"nativeMessaging" permission at that point, not at install.'
