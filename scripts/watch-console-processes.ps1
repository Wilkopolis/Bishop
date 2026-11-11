<#
Logs new console processes with their parent process and command line.
Use it to find what opens cmd windows while Bishop runs.

  powershell -ExecutionPolicy Bypass -File scripts\watch-console-processes.ps1
  powershell -ExecutionPolicy Bypass -File scripts\watch-console-processes.ps1 -All -LogFile C:\temp\procs.log

By default only console-subsystem programs (cmd.exe, powershell.exe, claude.exe, ...) are logged.
Use -All to log every new process. Stop with Ctrl+C.
Run as administrator for event mode, which catches very short-lived processes.
Without admin it polls every -IntervalMs, so a process that lives less than that can be missed.
#>
param(
    [switch]$All,
    [int]$IntervalMs = 30,
    [string]$LogFile = (Join-Path $env:TEMP 'bishop-console-processes.log')
)

$ErrorActionPreference = 'SilentlyContinue'

# PE subsystem 3 = console, 2 = GUI.
function Get-Subsystem([string]$path) {
    if (-not $path) { return $null }
    try {
        $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
        try {
            $br = New-Object IO.BinaryReader($fs)
            $fs.Position = 0x3C
            $pe = $br.ReadInt32()
            $fs.Position = $pe + 24 + 68
            return [int]$br.ReadUInt16()
        } finally { $fs.Dispose() }
    } catch { return $null }
}

$known = @{}   # pid -> @{ Name; Cmd; ParentPid } for parent lookups after exit

function Write-Entry($procId, $parentId, $name, $cmd, $path) {
    $sub = Get-Subsystem $path
    if (-not $All -and $sub -ne 3) { return }
    $parent = $known[[int]$parentId]
    if (-not $parent) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId"
        if ($p) { $parent = @{ Name = $p.Name; Cmd = $p.CommandLine; ParentPid = $p.ParentProcessId } }
    }
    $pName = if ($parent) { $parent.Name } else { '(exited)' }
    $pCmd = if ($parent) { $parent.Cmd } else { '' }
    $grand = if ($parent) { $known[[int]$parent.ParentPid] } else { $null }
    $lines = @(
        ('{0}  pid={1}  {2}' -f (Get-Date -Format 'HH:mm:ss.fff'), $procId, $name),
        ('    cmd:    {0}' -f $cmd),
        ('    parent: {0} (pid {1}) {2}' -f $pName, $parentId, $pCmd)
    )
    if ($grand) { $lines += ('    grandparent: {0} (pid {1})' -f $grand.Name, $parent.ParentPid) }
    $text = $lines -join [Environment]::NewLine
    Write-Host $text
    Add-Content -Path $LogFile -Value $text
}

function Remember($procId, $parentId, $name, $cmd) {
    $known[[int]$procId] = @{ Name = $name; Cmd = $cmd; ParentPid = $parentId }
}

Write-Host "Logging to $LogFile. Ctrl+C to stop."

# Seed with running processes so parents are known and old ones are not reported.
$seen = @{}
foreach ($p in Get-CimInstance Win32_Process) {
    $seen[[int]$p.ProcessId] = $p.CreationDate
    Remember $p.ProcessId $p.ParentProcessId $p.Name $p.CommandLine
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
    Write-Host 'Event mode (administrator).'
    Register-CimIndicationEvent -Query 'SELECT * FROM Win32_ProcessStartTrace' -SourceIdentifier BishopProcStart | Out-Null
    try {
        while ($true) {
            $ev = Wait-Event -SourceIdentifier BishopProcStart
            Remove-Event -EventIdentifier $ev.EventIdentifier
            $t = $ev.SourceEventArgs.NewEvent
            # The command line is not in the event; query it right away (may be gone already).
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($t.ProcessID)"
            $cmd = if ($p) { $p.CommandLine } else { '(exited before it could be read)' }
            $path = if ($p) { $p.ExecutablePath } else { $null }
            if (-not $path -and $t.ProcessName) { $path = (Get-Command $t.ProcessName -ErrorAction SilentlyContinue).Source }
            Write-Entry $t.ProcessID $t.ParentProcessID $t.ProcessName $cmd $path
            Remember $t.ProcessID $t.ParentProcessID $t.ProcessName $cmd
        }
    } finally {
        Unregister-Event -SourceIdentifier BishopProcStart
    }
} else {
    Write-Host "Polling mode every $IntervalMs ms (run as administrator to catch very short-lived processes)."
    while ($true) {
        $now = @{}
        foreach ($p in Get-CimInstance Win32_Process) {
            $id = [int]$p.ProcessId
            $now[$id] = $true
            if (-not $seen.ContainsKey($id) -or $seen[$id] -ne $p.CreationDate) {
                $seen[$id] = $p.CreationDate
                Write-Entry $id $p.ParentProcessId $p.Name $p.CommandLine $p.ExecutablePath
                Remember $id $p.ParentProcessId $p.Name $p.CommandLine
            }
        }
        foreach ($id in @($seen.Keys)) { if (-not $now.ContainsKey($id)) { $seen.Remove($id) } }
        Start-Sleep -Milliseconds $IntervalMs
    }
}
