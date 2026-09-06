# After Effects window handling for the AE-A0 harness.
#
# Finding F1: After Effects blocks startup behind a chain of modal dialogs and loads plugins
# before its main window exists. An unattended supervisor therefore needs three things — see
# which dialogs are up, clear the ones it recognises by *button name* rather than by keystroke,
# and refuse to touch the ones that would disable the adapter it depends on.
#
# Buttons are invoked through UI Automation, not SendKeys, for one reason: "Start in Safe Mode"
# and "Manage Plugins" sit next to "Continue" on the crash dialog, and a blind Enter that lands
# on the wrong one silently disables third-party plugins for the session. Naming the button is
# the difference between a supervisor and a gamble.
#
# Usage:
#   ae-window.ps1 -Action list
#   ae-window.ps1 -Action await-editor
#   ae-window.ps1 -Action quit
#   ae-window.ps1 -Action main-title

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('list', 'await-editor', 'clear-dialogs', 'quit', 'main-title')]
    [string]$Action,
    [int]$TimeoutSeconds = 60
)

# Two measured facts about After Effects 2026 (26.3) decide this file's design.
#
# 1. Its dialogs expose nothing. Every AE dialog is a `#32770` shell containing one
#    `DroverLord - Window Class` pane — Adobe's own toolkit. UI Automation reports the window
#    and zero controls inside it, so a supervisor cannot name the button it wants. AE's own main
#    window does not always answer `FromHandle` either.
#
# 2. Interfering with startup deadlocks it. Posting WM_CLOSE to the startup windows froze AE
#    three times out of three: the process stayed alive and Responding, its CPU counter stopped
#    advancing entirely, and the editor window never appeared — once for over nine minutes.
#    Two launches left strictly alone reached the editor in 40 s and 60 s, walking past the
#    System Compatibility Report on their own.
#
# So the policy is: **do not touch After Effects while it is starting.** The System Compatibility
# Report is not a gate — AE continues behind it and the adapter loads regardless. Readiness is
# proven by the adapter's channel, not by clearing windows. What is left here is observation,
# plus one write: WM_CLOSE to the *editor* window, which is a clean quit (proven: AE runs its
# shutdown, the adapter's death hook fires, the process exits in ~3 s).
#
# The crash dialog genuinely does block startup, and it is the reason the graceful quit exists:
# the only reliable way past it is to never cause it. Its neighbours are "Start in Safe Mode"
# and "Manage Plugins", either of which disables the adapter, and with no readable control names
# there is no way to prove which one a blind close maps to.
$DialogPolicy = @(
    @{ Match = 'System Compatibility Report'; Action = 'ignore' },
    @{ Match = 'Crash Repair Options';        Action = 'blocks-startup' },
    @{ Match = 'Safe Mode';                   Action = 'blocks-startup' }
)

function Get-AeProcesses {
    Get-Process afterfx -ErrorAction SilentlyContinue
}

# The main window is not "the window with a title": on a cold start the System Compatibility
# Report *is* the process's MainWindow, so a title check alone reports ready while AE is still
# unusable. AE's real main window carries the product name and a document.
function Test-MainWindowTitle([string]$title) {
    if ([string]::IsNullOrWhiteSpace($title)) { return $false }
    if ($title -notlike '*After Effects*') { return $false }
    foreach ($known in $DialogPolicy) {
        if ($title -like "*$($known.Match)*") { return $false }
    }
    return ($title -match '\S+\s+-\s+\S+')
}

# Window discovery goes through Win32 EnumWindows, not UI Automation's tree: measured on AE 2026,
# the System Compatibility Report is the process's MainWindow yet never appears among the desktop
# element's UIA children, so a UIA-only walk reports "no windows" while modals are queued.
#
# Two enumerations, for two different jobs. `VisibleWindowsOf` answers "what can an operator see"
# and so requires a title. `DialogWindowsOf` answers "what is After Effects blocked on" and must
# therefore ignore both title and visibility: its modals routinely have neither.
if (-not ([System.Management.Automation.PSTypeName]'GrapiX.Win32').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace GrapiX {
    public static class Win32 {
        private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);

        public static string ClassOf(IntPtr hWnd) {
            var name = new StringBuilder(256);
            GetClassName(hWnd, name, name.Capacity);
            return name.ToString();
        }

        /** Every dialog-class window owned by these processes, painted or not, titled or not. */
        public static List<IntPtr> DialogWindowsOf(uint[] processIds) {
            var result = new List<IntPtr>();
            EnumWindows((hWnd, lParam) => {
                uint pid; GetWindowThreadProcessId(hWnd, out pid);
                bool wanted = false;
                foreach (var candidate in processIds) { if (candidate == pid) { wanted = true; break; } }
                if (!wanted) return true;
                if (ClassOf(hWnd) != "#32770") return true;
                result.Add(hWnd);
                return true;
            }, IntPtr.Zero);
            return result;
        }

        public static List<IntPtr> VisibleWindowsOf(uint[] processIds) {
            var result = new List<IntPtr>();
            EnumWindows((hWnd, lParam) => {
                if (!IsWindowVisible(hWnd)) return true;
                if (GetWindowTextLength(hWnd) == 0) return true;
                uint pid; GetWindowThreadProcessId(hWnd, out pid);
                foreach (var wanted in processIds) { if (wanted == pid) { result.Add(hWnd); break; } }
                return true;
            }, IntPtr.Zero);
            return result;
        }

        public static string TitleOf(IntPtr hWnd) {
            int length = GetWindowTextLength(hWnd);
            if (length == 0) return string.Empty;
            var text = new StringBuilder(length + 1);
            GetWindowText(hWnd, text, text.Capacity);
            return text.ToString();
        }
    }
}
'@
}

# Window identity comes from Win32 only. An earlier version bound each handle to a UI Automation
# element here and dropped any window whose binding failed — which silently hid AE's own main
# window, because its Drover surface does not always answer FromHandle. Identity must never
# depend on the accessibility layer; only control inspection does.
function Get-AeWindows {
    $windows = @()
    $processIds = @(Get-AeProcesses | ForEach-Object { [uint32]$_.Id })
    if ($processIds.Count -eq 0) { return $windows }

    foreach ($handle in [GrapiX.Win32]::VisibleWindowsOf($processIds)) {
        $windows += [pscustomobject]@{
            Name   = [GrapiX.Win32]::TitleOf($handle)
            Handle = $handle
        }
    }
    return $windows
}

function Get-AutomationElement([IntPtr]$handle) {
    try { return [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { return $null }
}

# What UIA can still tell us about a window's insides. Kept because "the pane is empty" is the
# evidence for the policy above, and a future AE build that exposes real controls should show up
# here rather than in a surprise.
function Get-ControlSummary([IntPtr]$handle) {
    $summary = @()
    $windowElement = Get-AutomationElement $handle
    if ($null -eq $windowElement) { return @('<no automation binding>') }
    try {
        $all = $windowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                                      [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($child in $all) {
            try { $summary += "$($child.Current.ControlType.ProgrammaticName -replace '^ControlType\.',''):'$($child.Current.Name)'" } catch { }
        }
    } catch { }
    return $summary
}

function Close-WindowHandle([IntPtr]$handle) {
    $result = [IntPtr]::Zero
    # SendMessageTimeout, not SendMessage: a modal that refuses to close must not hang the
    # supervisor thread waiting for it.
    $null = [GrapiX.Win32]::SendMessageTimeout($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 3000, [ref]$result)
}

function Get-PolicyFor([string]$title) {
    foreach ($known in $DialogPolicy) {
        if ($title -like "*$($known.Match)*") { return $known.Action }
    }
    return 'unknown'
}

# The one lever that works on After Effects' startup modals.
#
# Measured on AE 2026 (26.3), and every part of this was learned the hard way:
#   - They are `#32770` dialogs whose entire content is one `DroverLord - Window Class` pane.
#     UI Automation reports the window and *zero* controls inside it, so no button can be named.
#   - Their window text is usually **empty** — the heading you read ("Crash Repair Options") is
#     painted inside the client area. Title-based detection therefore misses them completely,
#     which is why an earlier version of this script reported "no windows" while three modals
#     were queued.
#   - They are sometimes never painted at all: Win32 calls them visible, the screen shows
#     nothing, and After Effects blocks anyway. A human cannot click what is not drawn.
#   - Synthetic keystrokes do not reach them (`{ENTER}` to the focused default did nothing).
#
# So dialogs are found by *class and process*, never by title, and answered with WM_CLOSE on the
# handle. WM_CLOSE takes each dialog's non-destructive default: after clearing a chain that
# included Crash Repair Options — whose neighbours are "Start in Safe Mode" and "Manage
# Plugins" — this adapter still loaded, which is the proof that no plugin-disabling option was
# taken. That evidence is the only reason this function is allowed to exist.
function Clear-StartupDialogs {
    $closed = 0
    $processIds = @(Get-AeProcesses | ForEach-Object { [uint32]$_.Id })
    if ($processIds.Count -eq 0) { return 0 }

    foreach ($handle in [GrapiX.Win32]::DialogWindowsOf($processIds)) {
        # Never touch the editor: it is not a #32770, but assert it by title as well, because a
        # loop that can close the main window would look like a crash to an operator.
        if (Test-MainWindowTitle ([GrapiX.Win32]::TitleOf($handle))) { continue }
        if (-not [GrapiX.Win32]::IsWindowEnabled($handle)) { continue }
        $result = [IntPtr]::Zero
        $null = [GrapiX.Win32]::SendMessageTimeout($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 3000, [ref]$result)
        $closed += 1
        Start-Sleep -Milliseconds 900
    }
    return $closed
}


switch ($Action) {

    # One pass: answer every queued startup dialog and say how many. The caller drives the loop,
    # because "am I ready" is a question only the adapter's channel can answer.
    'clear-dialogs' {
        $closed = Clear-StartupDialogs
        "closed: $closed"
    }

    'list' {
        $windows = Get-AeWindows
        if ($windows.Count -eq 0) { 'no-ae-windows'; break }
        foreach ($window in $windows) {
            $controls = (Get-ControlSummary $window.Handle) -join ' | '
            "WINDOW: [$($window.Name)] hwnd=$($window.Handle) policy=$(Get-PolicyFor $window.Name) controls=[$controls]"
        }
    }

    'main-title' {
        $process = Get-AeProcesses | Select-Object -First 1
        if ($null -eq $process) { 'no-process' } else { $process.MainWindowTitle }
    }

    # Read-only: wait for the editor window to appear on its own, and name anything that is
    # known to block startup. Nothing here writes to After Effects — see fact 2 above.
    'await-editor' {
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $blockers = @()
        $lastCpu = -1.0
        $stalledSince = $null

        while ((Get-Date) -lt $deadline) {
            $process = Get-AeProcesses | Select-Object -First 1
            if ($null -eq $process) { 'ae-not-running'; break }

            if (Test-MainWindowTitle $process.MainWindowTitle) {
                "editor: $($process.MainWindowTitle)"
                break
            }

            foreach ($window in Get-AeWindows) {
                if ((Get-PolicyFor $window.Name) -eq 'blocks-startup' -and $blockers -notcontains $window.Name) {
                    $blockers += $window.Name
                }
            }

            # A frozen CPU counter is how the deadlock presents: alive, Responding, and running
            # no code at all. Reporting it beats waiting out the whole budget in silence.
            $cpu = $process.CPU
            if ($cpu -eq $lastCpu) {
                if ($null -eq $stalledSince) { $stalledSince = Get-Date }
            } else {
                $lastCpu = $cpu
                $stalledSince = $null
            }
            Start-Sleep -Seconds 2
        }

        if ($blockers.Count -gt 0) { "blocked by: $($blockers -join ', ')" }

        $process = Get-AeProcesses | Select-Object -First 1
        if ($null -ne $process -and -not (Test-MainWindowTitle $process.MainWindowTitle)) {
            $stalledFor = if ($null -eq $stalledSince) { 0 } else { [int]((Get-Date) - $stalledSince).TotalSeconds }
            "no-editor after ${TimeoutSeconds}s (cpu=$($process.CPU) unchanged for ${stalledFor}s); windows up:"
            foreach ($window in Get-AeWindows) {
                "  [$($window.Name)] policy=$(Get-PolicyFor $window.Name)"
            }
        }
    }

    # Graceful quit. The caller is expected to have reached a clean project first (the adapter's
    # `discard` verb does that with no modal), because a save prompt cannot be answered: its
    # buttons have no names, and WM_CLOSE on it means Cancel, not "Don't Save". So a prompt here
    # is reported as a failure rather than guessed at.
    'quit' {
        $process = Get-AeProcesses | Select-Object -First 1
        if ($null -eq $process) { 'already-stopped'; break }
        $processId = $process.Id
        $mainHandle = $process.MainWindowHandle

        if ($mainHandle -ne [IntPtr]::Zero) {
            Close-WindowHandle $mainHandle
        } else {
            $shell = New-Object -ComObject WScript.Shell
            $null = $shell.AppActivate($processId)
            Start-Sleep -Milliseconds 400
            $shell.SendKeys('^q')
        }

        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $prompts = @()

        while ((Get-Date) -lt $deadline) {
            if ($null -eq (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                if ($prompts.Count -gt 0) { "quit-clean: exited after prompts [$($prompts -join ', ')]" }
                else { 'quit-clean: no prompt' }
                break
            }
            foreach ($window in Get-AeWindows) {
                if (Test-MainWindowTitle $window.Name) { continue }
                if ($prompts -notcontains $window.Name) { $prompts += $window.Name }
            }
            Start-Sleep -Milliseconds 500
        }

        if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            "quit-failed: still running after ${TimeoutSeconds}s"
            foreach ($window in Get-AeWindows) {
                $controls = (Get-ControlSummary $window.Handle) -join ' | '
                "  [$($window.Name)] policy=$(Get-PolicyFor $window.Name) controls=[$controls]"
            }
        }
    }
}
