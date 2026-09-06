param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

$ErrorActionPreference = "Stop"
$resolvedExe = (Resolve-Path -LiteralPath $ExecutablePath).Path
if ((Split-Path -Leaf $resolvedExe) -ne "CodexAuth Switch.exe") {
  throw "Expected the installed CodexAuth Switch.exe."
}

# Launch through the Windows process service instead of the maintenance host.
# Break away from the provider's job where supported; do not inherit a Codex
# terminal/session lifetime. This does not stop or restart Codex itself.
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow = [uint16]0
  CreateFlags = [uint32]0x01000000
}
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"' + $resolvedExe + '"'
  CurrentDirectory = Split-Path -Parent $resolvedExe
  ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) {
  throw "Independent launch failed with Windows status $($result.ReturnValue)."
}
[pscustomobject]@{ ProcessId = $result.ProcessId; ExecutablePath = $resolvedExe }
