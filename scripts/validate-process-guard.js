const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { WINDOWS_DESKTOP_SCAN, WINDOWS_CONFLICT_OUTPUT, parseProcessRecords,
  canStopConflicts, stopConflictsScript } = require("../src/codex-process-guard");

const daemon = { id: 36644, name: "codex.exe", path: "C:\\Users\\测试\\.codex\\packages\\app-server-daemon\\bin\\codex.exe", startedAt: "639000000000000000" };
assert.deepEqual(parseProcessRecords(JSON.stringify([daemon])), [daemon]);
assert.equal(canStopConflicts([daemon]), true);
for (const patch of [{ path: null }, { path: "relative.exe" }, { startedAt: null }, { name: "ChatGPT.exe" }]) {
  assert.equal(canStopConflicts([{ ...daemon, ...patch }]), false);
  assert.throws(() => stopConflictsScript([{ ...daemon, ...patch }]));
}
for (const value of ["", "{}", "null", '[{"id":0,"name":"codex.exe"}]', '[{"id":1,"name":"other.exe"}]']) {
  assert.throws(() => parseProcessRecords(value));
}

if (process.platform === "win32") {
  const run = script => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from("$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);\n" + script, "utf16le").toString("base64")],
  { windowsHide: true, encoding: "utf8", timeout: 15000 }));
  // Every OS process command below is replaced by an inert fixture. No live
  // Codex processes, credentials, or desktop windows are touched by these tests.
  const scanFixture = `
$fixture = @(
  [pscustomobject]@{ ProcessId=100; ParentProcessId=1; Name='ChatGPT.exe'; ExecutablePath='C:\\Apps\\Codex\\ChatGPT.exe' },
  [pscustomobject]@{ ProcessId=101; ParentProcessId=100; Name='ChatGPT.exe'; ExecutablePath='C:\\Apps\\Codex\\ChatGPT.exe' },
  [pscustomobject]@{ ProcessId=102; ParentProcessId=101; Name='codex.exe'; ExecutablePath='C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe' },
  [pscustomobject]@{ ProcessId=36644; ParentProcessId=14420; Name='codex.exe'; ExecutablePath='C:\\Users\\测试\\.codex\\packages\\app-server-daemon\\bin\\codex.exe' },
  [pscustomobject]@{ ProcessId=13368; ParentProcessId=14420; Name='codex.exe'; ExecutablePath='C:\\Users\\测试\\.codex\\packages\\app-server-daemon\\bin\\codex.exe' },
  [pscustomobject]@{ ProcessId=999; ParentProcessId=1; Name='ChatGPT.exe'; ExecutablePath='C:\\OtherApp\\ChatGPT.exe' }
)
function Get-AppxPackage { param($Name) [pscustomobject]@{ InstallLocation='C:\\Apps\\Codex'; Version='1.0' } }
function Get-CimInstance { param($ClassName) $fixture }
function Get-Process {
  [CmdletBinding()] param([int]$Id)
  $fixture | Where-Object { -not $Id -or $_.ProcessId -eq $Id } | ForEach-Object {
    [pscustomobject]@{ Id=$_.ProcessId; ProcessName=[IO.Path]::GetFileNameWithoutExtension($_.Name); Path=$_.ExecutablePath; StartTime=[DateTime]::new(639000000000000000, [DateTimeKind]::Utc) }
  }
}
`;
  const found = run(scanFixture + WINDOWS_DESKTOP_SCAN + WINDOWS_CONFLICT_OUTPUT);
  assert.deepEqual(found.map(p => p.id).sort(), [13368, 36644], "detached daemons conflict; desktop descendants and unrelated ChatGPT do not");
  assert.equal(found[0].path.includes("测试"), true);
  const stopFixture = `
$script:killed = @()
$script:disposed = @()
$script:liveProcesses = @{}
function New-FakeProcess($Id, $Path, $Ticks) {
  $p = [pscustomobject]@{ Id=$Id; ProcessName='codex'; Path=$Path; StartTime=[DateTime]::new([long]$Ticks, [DateTimeKind]::Utc); Handle=0; HasExited=$false }
  $p | Add-Member ScriptMethod Kill { $script:killed += $this.Id; $this.HasExited=$true }
  $p | Add-Member ScriptMethod WaitForExit { param($timeout) $true }
  $p | Add-Member ScriptMethod Dispose { $script:disposed += $this.Id }
  $script:liveProcesses[$Id] = $p
}
function Get-Process { [CmdletBinding()] param([int]$Id) $script:liveProcesses[$Id] }
New-FakeProcess 36644 'C:\\Users\\测试\\.codex\\packages\\app-server-daemon\\bin\\codex.exe' 639000000000000000
New-FakeProcess 999 'C:\\unrelated\\codex.exe' 639000000000000000
`;
  const finish = `
[pscustomobject]@{ killed=@($script:killed); disposed=@($script:disposed); error=$failure } | ConvertTo-Json -Compress
`;
  for (const [setup, expected, reason] of [
    ["", [36644], "stop exactly the confirmed process"],
    ["$script:liveProcesses.Remove(36644)", [], "an exited process is harmless"],
    ["$script:liveProcesses[36644].Path='C:\\replaced\\codex.exe'", [], "changed executable cannot be killed"],
    ["$script:liveProcesses[36644].StartTime=$script:liveProcesses[36644].StartTime.AddSeconds(1)", [], "PID reuse cannot be killed"],
  ]) {
    const result = run(stopFixture + setup + "\n$failure=$null; try {\n" + stopConflictsScript([daemon]) + "\n} catch { $failure=$_.Exception.Message }\n" + finish);
    assert.deepEqual(result.killed, expected, reason);
    if (setup.includes(".Path=") || setup.includes(".StartTime=")) assert.equal(result.error, "CODEXAUTH_PROCESS_CHANGED");
  }
  const second = { ...daemon, id: 999, path: "C:\\unrelated\\codex.exe", startedAt: "639000000000000001" };
  const changedBatch = run(stopFixture + "\n$failure=$null; try {\n" + stopConflictsScript([daemon, second]) + "\n} catch { $failure=$_.Exception.Message }\n" + finish);
  assert.deepEqual(changedBatch.killed, [], "validate the complete approved set before terminating any process");
  assert.equal(changedBatch.error, "CODEXAUTH_PROCESS_CHANGED");
  const raced = run(scanFixture + WINDOWS_DESKTOP_SCAN + `
if ($conflicts.Count -gt 0) { ${WINDOWS_CONFLICT_OUTPUT}; exit 0 }
throw 'The desktop stop branch must not run with external conflicts'
`);
  assert.equal(raced.length, 2, "a conflict found at the final preflight preserves desktop windows");
}
console.log("Process guard validation passed: desktop ownership, detached daemons, Unicode, exact consent targets, PID reuse and preflight races.");
