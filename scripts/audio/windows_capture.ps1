# SPDX-License-Identifier: AGPL-3.0-or-later
# Seminar modifications, 2026-09-16: native WASAPI bridge.
param([string]$Mode = 'list', [string]$Target = 'default')
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowsCapture.cs')
    if ($Mode -eq 'list') { [WboAudio.Capture]::List() }
    else { [WboAudio.Capture]::Run($Mode, $Target) }
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
