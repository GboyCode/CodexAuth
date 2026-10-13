const path = require("node:path");

// Shared by the preflight and the final check immediately before desktop exit.
const WINDOWS_DESKTOP_SCAN = `
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
$installRoot = if ($package -and $package.InstallLocation) { [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\\') } else { $null }
function Get-CodexAppProcesses {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try {
      $processPath = $_.Path
      if (-not $processPath) { return $false }
      $fullPath = [IO.Path]::GetFullPath($processPath)
      if ($installRoot -and $fullPath.StartsWith($installRoot + '\\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
      return ($_.ProcessName -in @('ChatGPT', 'Codex')) -and ($fullPath -like '*\\OpenAI\\Codex\\*')
    } catch { return $false }
  }
}
$targets = @(Get-CodexAppProcesses)
$all = @(Get-CimInstance Win32_Process)
$owned = @($targets | ForEach-Object { $_.Id })
do {
  $children = @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned })
  $owned += @($children | ForEach-Object { $_.ProcessId })
} while ($children.Count -gt 0)
$servers = @($all | Where-Object { $_.Name -ieq 'codex.exe' -and $_.ProcessId -in $owned } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
$conflicts = @($all | Where-Object {
  $_.ProcessId -notin $owned -and ($_.Name -ieq 'codex.exe' -or ($_.Name -ieq 'ChatGPT.exe' -and (
    -not $_.ExecutablePath -or $_.ExecutablePath -match '[\\\\/]OpenAI[.\\\\/]Codex')))
})
`;

const WINDOWS_WRITERS_SCAN = `
$ErrorActionPreference = 'Stop'
$conflicts = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq 'codex.exe' -or ($_.Name -ieq 'ChatGPT.exe' -and (
    -not $_.ExecutablePath -or $_.ExecutablePath -match '[\\\\/]OpenAI[.\\\\/]Codex'))
})
`;

const WINDOWS_CONFLICT_OUTPUT = `
$records = @($conflicts | ForEach-Object {
  $entry = $_
  $executable = $entry.ExecutablePath
  $startedAt = $null
  try {
    $live = Get-Process -Id $entry.ProcessId -ErrorAction Stop
    if (($live.ProcessName + '.exe') -ieq $entry.Name) {
      $executable = $live.Path
      $startedAt = $live.StartTime.ToUniversalTime().Ticks.ToString()
    }
  } catch {}
  [pscustomobject]@{ id = [int]$entry.ProcessId; name = $entry.Name; path = $executable; startedAt = $startedAt }
})
ConvertTo-Json -InputObject $records -Compress
`;

function parseProcessRecords(output) {
  const records = JSON.parse(output);
  if (!Array.isArray(records) || records.some((p) => !Number.isSafeInteger(p.id) || p.id <= 0
    || !["codex.exe", "chatgpt.exe"].includes(p.name?.toLowerCase())
    || (p.path != null && typeof p.path !== "string")
    || (p.startedAt != null && !/^\d+$/.test(p.startedAt)))) throw new Error("Invalid Codex process snapshot.");
  return records;
}

function canStopConflicts(records) {
  return records.length > 0 && records.every((p) => p.name.toLowerCase() === "codex.exe"
    && p.path && path.win32.isAbsolute(p.path) && /^\d+$/.test(p.startedAt ?? ""));
}

function stopConflictsScript(records) {
  if (!canStopConflicts(parseProcessRecords(JSON.stringify(records)))) throw new Error("Unverifiable Codex processes.");
  const encoded = Buffer.from(JSON.stringify(records), "utf8").toString("base64");
  return `
$ErrorActionPreference = 'Stop'
$approved = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$confirmed = @()
try {
  foreach ($entry in $approved) {
    $live = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if (-not $live) { continue }
    # Open the process handle before checking identity; Kill uses this same handle.
    $null = $live.Handle
    $confirmed += $live
    if ($live.ProcessName -ine 'codex' -or $live.Path -ine $entry.path -or $live.StartTime.ToUniversalTime().Ticks.ToString() -ne $entry.startedAt) {
      throw 'CODEXAUTH_PROCESS_CHANGED'
    }
  }
  foreach ($live in $confirmed) { if (-not $live.HasExited) { $live.Kill() } }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  foreach ($live in $confirmed) {
    $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $live.WaitForExit($remaining)) { throw 'CODEXAUTH_PROCESS_EXIT_TIMEOUT' }
  }
} finally { foreach ($live in $confirmed) { $live.Dispose() } }
`;
}

module.exports = { WINDOWS_DESKTOP_SCAN, WINDOWS_WRITERS_SCAN, WINDOWS_CONFLICT_OUTPUT,
  parseProcessRecords, canStopConflicts, stopConflictsScript };
