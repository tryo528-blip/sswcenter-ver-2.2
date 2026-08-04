[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$script:Total = 0
$script:Passed = 0
$script:Failed = 0
$script:Failures = New-Object System.Collections.Generic.List[string]
$runner = Join-Path $PSScriptRoot 'invoke-deepseek-workspace.ps1'
$workspaceParent = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$testRoot = Join-Path $workspaceParent ('.sswcenter-runner-contract-' + [guid]::NewGuid().ToString('N'))
$checkpoint = ''
$script:ExternalCheckpoints = New-Object System.Collections.Generic.List[string]

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Name
    )
    $script:Total++
    if ($Condition) {
        $script:Passed++
    }
    else {
        $script:Failed++
        [void]$script:Failures.Add($Name)
    }
}

function Assert-Equal {
    param(
        [object]$Actual,
        [object]$Expected,
        [string]$Name
    )
    Assert-True ([string]$Actual -eq [string]$Expected) ($Name + ' expected=' + $Expected + ' actual=' + $Actual)
}

function Write-TestText {
    param(
        [string]$Path,
        [string]$Text
    )
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Read-TestText {
    param([string]$Path)
    return [System.IO.File]::ReadAllText($Path)
}

function New-ExternalCheckpoint {
    param([string]$Label)
    $path = Join-Path $workspaceParent ('.sswcenter-runner-' + $Label + '-' + [guid]::NewGuid().ToString('N') + '.json')
    [void]$script:ExternalCheckpoints.Add($path)
    return $path
}

function New-ToolCall {
    param(
        [string]$Id,
        [string]$Name,
        [object]$Arguments
    )
    $fn = [ordered]@{
        name = $Name
        arguments = (ConvertTo-Json $Arguments -Depth 20 -Compress)
    }
    return [ordered]@{
        id = $Id
        type = 'function'
        function = $fn
    }
}

function New-Response {
    param(
        [object]$Message,
        [int]$PromptTokens = 100,
        [int]$CompletionTokens = 10,
        [switch]$WithoutUsage,
        [string]$FinishReason = 'tool_calls'
    )
    $response = [ordered]@{
        choices = @([ordered]@{
            message = $Message
            finish_reason = $FinishReason
        })
    }
    if (-not $WithoutUsage) {
        $response.usage = [ordered]@{
            prompt_tokens = $PromptTokens
            completion_tokens = $CompletionTokens
        }
    }
    return $response
}

function Save-Responses {
    param(
        [string]$Path,
        [object[]]$Responses
    )
    Write-TestText $Path (($Responses | ConvertTo-Json -Depth 50))
}

function Invoke-Runner {
    param(
        [string]$Root,
        [ValidateSet('ReadOnly', 'Writer')]
        [string]$RunMode = 'ReadOnly',
        [string[]]$Allow = @(),
        [string]$PromptText = 'contract test',
        [string]$ResponsesPath = '',
        [string]$Checkpoint = '',
        [string]$Resume = '',
        [string]$Task = '',
        [int]$Turns = 48,
        [switch]$Offline,
        [switch]$WithoutJson,
        [switch]$Dry
    )
    $processArgs = @(
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $runner,
        '-RepositoryRoot',
        $Root,
        '-Mode',
        $RunMode,
        '-Prompt',
        $PromptText,
        '-MaxTurns',
        [string]$Turns
    )
    if ($Allow.Count -gt 0) {
        $processArgs += '-AllowPath'
        $processArgs += $Allow
    }
    if (-not $WithoutJson) {
        $processArgs += '-JsonOutput'
    }
    if ($Offline) {
        $processArgs += '-OfflineConfig'
    }
    if ($Dry) {
        $processArgs += '-DryRun'
    }
    if (-not [string]::IsNullOrWhiteSpace($ResponsesPath)) {
        $processArgs += '-TestMode'
        $processArgs += '-MockResponsesPath'
        $processArgs += $ResponsesPath
    }
    if (-not [string]::IsNullOrWhiteSpace($Checkpoint)) {
        $processArgs += '-CheckpointPath'
        $processArgs += $Checkpoint
    }
    if (-not [string]::IsNullOrWhiteSpace($Resume)) {
        $processArgs += '-Resume'
        $processArgs += $Resume
    }
    if (-not [string]::IsNullOrWhiteSpace($Task)) {
        $processArgs += '-TaskId'
        $processArgs += $Task
    }
    $output = @(& powershell.exe @processArgs)
    $rc = $LASTEXITCODE
    $raw = ($output | ForEach-Object { [string]$_ }) -join ([Environment]::NewLine)
    $json = $null
    if (-not $WithoutJson) {
        try {
            $json = $raw | ConvertFrom-Json
        }
        catch {
            $json = $null
        }
    }
    return [pscustomobject]@{
        rc = $rc
        raw = $raw
        json = $json
    }
}

try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $allowedFile = Join-Path $testRoot 'allowed.txt'
    $leadFile = Join-Path $testRoot 'leading.txt'
    $usageFile = Join-Path $testRoot 'usage.txt'
    $resumeFile = Join-Path $testRoot 'resume.txt'
    $patchFile = Join-Path $testRoot 'patch.txt'
    $checkpoint = Join-Path $workspaceParent ('.sswcenter-runner-checkpoint-' + [guid]::NewGuid().ToString('N') + '.json')
    [void]$script:ExternalCheckpoints.Add($checkpoint)
    $seqResponses = Join-Path $testRoot 'seq-responses.json'
    $extensionResponses = Join-Path $testRoot 'extension-responses.json'
    $leadingResponses = Join-Path $testRoot 'leading-responses.json'
    $usageResponses = Join-Path $testRoot 'usage-responses.json'
    $progressResponses = Join-Path $testRoot 'progress-responses.json'
    $resumeResponses = Join-Path $testRoot 'resume-responses.json'
    $contextResponses = Join-Path $testRoot 'context-responses.json'
    $duplicateResponses = Join-Path $testRoot 'duplicate-responses.json'
    $patchResponses = Join-Path $testRoot 'patch-responses.json'
    $defaultTaskId = 'contract-default-checkpoint'
    $defaultCheckpointRoot = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
    $defaultCheckpoint = Join-Path $defaultCheckpointRoot ('SSWCenter\deepseek-runner\' + $defaultTaskId + '.checkpoint.json')
    [void]$script:ExternalCheckpoints.Add($defaultCheckpoint)

    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($runner, [ref]$tokens, [ref]$parseErrors) | Out-Null
    Assert-Equal $parseErrors.Count 0 'runner PowerShell AST'
    $runnerSource = Read-TestText $runner
    Assert-True (-not $runnerSource.Contains('run_commands')) 'no arbitrary shell tool'
    Assert-True (-not $runnerSource.Contains('Invoke-Expression')) 'no dynamic shell evaluation'
    Assert-True (-not $runnerSource.Contains('final_sha')) 'no commit-style final sha'

    $offline = Invoke-Runner -Root $testRoot -Offline
    Assert-Equal $offline.rc 0 'offline exit'
    Assert-True ($null -ne $offline.json) 'offline JSON'
    Assert-Equal $offline.json.status 'OFFLINE_CONFIG' 'offline status'
    Assert-Equal $offline.json.max_turns 48 'default 48 turns'
    Assert-Equal $offline.json.extension_size 8 'extension size'
    Assert-Equal $offline.json.checkpoint_turn 64 'checkpoint turn'
    Assert-Equal $offline.json.soft_turn 80 'soft turn'
    Assert-Equal $offline.json.hard_turn_limit 96 'hard turn'
    Assert-Equal $offline.json.provider_context_limit 1000000 'provider one million context'
    Assert-Equal $offline.json.context_soft_limit 600000 'context soft limit'
    Assert-Equal $offline.json.context_hard_limit 800000 'context hard limit'
    Assert-Equal $offline.json.output_reserve_tokens 128000 'output reserve'
    Assert-Equal $offline.json.base_head 'GIT_METADATA_UNAVAILABLE' 'git metadata unavailable marker'
    Assert-True ($null -eq $offline.json.workspace_diff_sha256) 'git diff unavailable is null'
    Assert-True ($offline.json.PSObject.Properties.Name -contains 'extensions_used') 'offline extensions field'
    Assert-True ($offline.json.PSObject.Properties.Name -contains 'no_progress_rounds') 'offline no progress field'
    Assert-True ($offline.json.PSObject.Properties.Name -contains 'latest_prompt_tokens') 'offline latest usage field'
    Assert-True ($offline.json.PSObject.Properties.Name -contains 'checkpoint_round') 'offline checkpoint field'
    Assert-Equal $offline.json.committed $false 'offline committed false'

    $missingEnv = Invoke-Runner -Root $testRoot -Allow @('allowed.txt') -PromptText 'pre-network' -Turns 1
    Assert-Equal $missingEnv.rc 1 'missing env exit'
    Assert-Equal $missingEnv.json.status 'FAIL' 'missing env status'
    Assert-True ($missingEnv.json.errors.code -contains 'DEEPSEEK_API_KEY_MISSING') 'missing env no network'
    Assert-Equal $missingEnv.json.request_count 0 'missing env request count'

    $writerNoAllow = Invoke-Runner -Root $testRoot -RunMode Writer -PromptText 'writer allowlist'
    Assert-Equal $writerNoAllow.rc 1 'writer allowlist exit'
    Assert-True ($writerNoAllow.json.errors.code -contains 'WRITER_ALLOWLIST_REQUIRED') 'writer allowlist required'

    $sensitive = Invoke-Runner -Root $testRoot -RunMode Writer -Allow @('.env') -Offline
    Assert-Equal $sensitive.rc 1 'sensitive allowlist exit'
    Assert-True ($sensitive.json.errors.code -contains 'ALLOWLIST_SENSITIVE_PATH') 'sensitive allowlist denied'

    Write-TestText $allowedFile 'alpha'
    $seq = @(
        (New-Response -Message ([ordered]@{
            role = 'assistant'
            content = $null
            reasoning_content = 'reasoning stays in history'
            tool_calls = @(
                (New-ToolCall 'r1' 'read_file' ([ordered]@{ path = 'allowed.txt' })),
                (New-ToolCall 'w1' 'replace_text' ([ordered]@{ path = 'allowed.txt'; old_text = 'alpha'; new_text = 'beta' }))
            )
        })),
        (New-Response -Message ([ordered]@{ role = 'assistant'; content = 'completed'; tool_calls = @() }) -PromptTokens 200 -FinishReason 'stop')
    )
    Save-Responses $seqResponses $seq
    $seqRun = Invoke-Runner -Root $testRoot -RunMode Writer -Allow @('allowed.txt') -ResponsesPath $seqResponses -Checkpoint $checkpoint -Turns 4
    Assert-Equal $seqRun.rc 0 'sequential exit'
    Assert-Equal $seqRun.json.status 'PASS' 'sequential status'
    Assert-Equal (Read-TestText $allowedFile) 'beta' 'sequential write'
    Assert-Equal $seqRun.json.tool_calls 2 'sequential tool count'
    Assert-Equal $seqRun.json.tool_calls_by_name.read_file 1 'read tool count'
    Assert-Equal $seqRun.json.tool_calls_by_name.replace_text 1 'write tool count'
    Assert-Equal $seqRun.json.tool_call_sequence[0].name 'read_file' 'first tool order'
    Assert-Equal $seqRun.json.tool_call_sequence[1].name 'replace_text' 'second tool order'
    Assert-Equal $seqRun.json.edit_count 1 'edit count'
    Assert-Equal $seqRun.json.latest_prompt_tokens 200 'latest usage is latest response'
    Assert-Equal $seqRun.json.cumulative_prompt_tokens 300 'cumulative usage is reporting only'
    Assert-True ($seqRun.json.changed_paths -contains 'allowed.txt') 'changed path'
    Assert-True $seqRun.json.checkpoint_saved 'write checkpoint'
    $checkpointRaw = Read-TestText $checkpoint
    Assert-True ($checkpointRaw.Contains('reasoning stays in history')) 'reasoning checkpoint preservation'
    Assert-True (-not $checkpointRaw.Contains('sk-secret-token')) 'checkpoint secret redaction'
    $tempCheckpointFiles = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetDirectoryName($checkpoint)) -Filter '*.tmp' -ErrorAction SilentlyContinue)
    Assert-Equal $tempCheckpointFiles.Count 0 'checkpoint temp cleanup'

    Write-TestText $allowedFile 'alpha'
    $defaultRun = Invoke-Runner -Root $testRoot -RunMode Writer -Allow @('allowed.txt') -ResponsesPath $seqResponses -Task $defaultTaskId -Turns 4
    Assert-Equal $defaultRun.rc 0 'default checkpoint exit'
    Assert-True $defaultRun.json.checkpoint_saved 'default checkpoint saved'
    Assert-True (Test-Path -LiteralPath $defaultCheckpoint -PathType Leaf) 'default checkpoint location'

    Write-TestText $patchFile 'one'
    $patchText = [string]::Join([Environment]::NewLine, @(
        '*** Begin Patch'
        '*** Update File: patch.txt'
        '@@'
        '-one'
        '+two'
        '*** End Patch'
    ))
    $patchResponsesValue = @(
        (New-Response -Message ([ordered]@{
            role = 'assistant'
            content = $null
            tool_calls = @((New-ToolCall 'p1' 'apply_patch' ([ordered]@{ patch = $patchText })))
        })),
        (New-Response -Message ([ordered]@{ role = 'assistant'; content = 'patch complete'; tool_calls = @() }) -FinishReason 'stop')
    )
    Save-Responses $patchResponses $patchResponsesValue
    $patchRun = Invoke-Runner -Root $testRoot -RunMode Writer -Allow @('patch.txt') -ResponsesPath $patchResponses -Checkpoint (New-ExternalCheckpoint 'patch') -Turns 4
    Assert-Equal $patchRun.rc 0 'apply patch exit'
    Assert-Equal (Read-TestText $patchFile) 'two' 'apply patch write'
    Assert-Equal $patchRun.json.patch_count 1 'apply patch count'

    Write-TestText $allowedFile 'alpha'
    $extension = @(
        (New-Response -Message ([ordered]@{
            role = 'assistant'
            content = $null
            tool_calls = @((New-ToolCall 'e1' 'replace_text' ([ordered]@{ path = 'allowed.txt'; old_text = 'alpha'; new_text = 'extended' })))
        })),
        (New-Response -Message ([ordered]@{ role = 'assistant'; content = 'extended complete'; tool_calls = @() }) -FinishReason 'stop')
    )
    Save-Responses $extensionResponses $extension
    $extensionRun = Invoke-Runner -Root $testRoot -RunMode Writer -Allow @('allowed.txt') -ResponsesPath $extensionResponses -Checkpoint (New-ExternalCheckpoint 'extension') -Turns 1
    Assert-Equal $extensionRun.rc 0 'extension exit'
    Assert-Equal $extensionRun.json.extensions_used 1 'eight turn extension'
    Assert-Equal $extensionRun.json.effective_max_turns 9 'extended effective limit'

    Write-TestText $leadFile 'original'
    $leading = @(
        (New-Response -Message ([ordered]@{
            role = 'assistant'
            content = $null
            tool_calls = @(
                (New-ToolCall 'bad' 'read_file' ([ordered]@{ path = 'missing.txt' })),
                (New-ToolCall 'must-not-write' 'replace_text' ([ordered]@{ path = 'leading.txt'; old_text = 'original'; new_text = 'changed' }))
            )
        }))
    )
    Save-Responses $leadingResponses $leading
    $leadingRun = Invoke-Runner -Root $testRoot -RunMode Writer -Allow @('leading.txt') -ResponsesPath $leadingResponses -Checkpoint (New-ExternalCheckpoint 'leading') -Turns 2
    Assert-Equal $leadingRun.rc 2 'leading failure exit'
    Assert-Equal $leadingRun.json.status 'PARTIAL' 'leading failure status'
    Assert-True $leadingRun.json.leading_tool_failure 'leading failure marker'
    Assert-Equal $leadingRun.json.tool_calls 1 'leading failure stops later tool'
    Assert-True ($null -eq $leadingRun.json.tool_calls_by_name.replace_text) 'leading failure no write call'
    Assert-Equal (Read-TestText $leadFile) 'original' 'leading failure preserves file'

    Write-TestText $usageFile 'unchanged'
    $usage = @(
        (New-Response -WithoutUsage -Message ([ordered]@{
            role = 'assistant'
            content = $null
            tool_calls = @((New-ToolCall 'u1' 'replace_text' ([ordered]@{ path = 'usage.txt'; old_text = 'unchanged'; new_text = 'changed' })))
        }))
    )
    Save-Responses $usageResponses $usage
    $usageRun = Invoke-Runner -Root $testRoot -RunMode Writer -Allow @('usage.txt') -ResponsesPath $usageResponses -Checkpoint (New-ExternalCheckpoint 'usage') -Turns 2
    Assert-Equal $usageRun.rc 1 'unknown usage exit'
    Assert-True ($usageRun.json.errors.code -contains 'CONTEXT_USAGE_UNKNOWN') 'unknown usage fail closed'
    Assert-Equal $usageRun.json.edit_count 0 'unknown usage no write'
    Assert-Equal (Read-TestText $usageFile) 'unchanged' 'unknown usage preserves file'

    Write-TestText $usageFile 'context-safe'
    $context = @(
        (New-Response -PromptTokens 700000 -CompletionTokens 0 -Message ([ordered]@{
            role = 'assistant'
            content = $null
            tool_calls = @((New-ToolCall 'c1' 'replace_text' ([ordered]@{ path = 'usage.txt'; old_text = 'context-safe'; new_text = 'must-not-write' })))
        }))
    )
    Save-Responses $contextResponses $context
    $contextRun = Invoke-Runner -Root $testRoot -RunMode Writer -Allow @('usage.txt') -ResponsesPath $contextResponses -Checkpoint (New-ExternalCheckpoint 'context') -Turns 2
    Assert-Equal $contextRun.rc 1 'context hard exit'
    Assert-True ($contextRun.json.errors.code -contains 'CONTEXT_HARD_LIMIT_REACHED') 'context hard fail closed'
    Assert-Equal $contextRun.json.edit_count 0 'context hard no write'
    Assert-Equal (Read-TestText $usageFile) 'context-safe' 'context hard preserves file'

    $progressMessages = New-Object System.Collections.Generic.List[object]
    foreach ($term in @('p1', 'p2', 'p3', 'p4')) {
        [void]$progressMessages.Add((New-Response -Message ([ordered]@{
            role = 'assistant'
            content = $null
            tool_calls = @((New-ToolCall ('s-' + $term) 'search_text' ([ordered]@{ pattern = $term })))
        })))
    }
    Save-Responses $progressResponses @($progressMessages.ToArray())
    $progressRun = Invoke-Runner -Root $testRoot -Allow @('allowed.txt') -ResponsesPath $progressResponses -Checkpoint (New-ExternalCheckpoint 'progress') -Turns 8
    Assert-Equal $progressRun.rc 1 'no progress exit'
    Assert-True ($progressRun.json.errors.code -contains 'NO_PROGRESS_LIMIT_REACHED') 'no progress stop'
    Assert-True ($progressRun.json.warnings.code -contains 'NO_PROGRESS_WARNING') 'no progress warning'
    Assert-Equal $progressRun.json.no_progress_rounds 4 'no progress rounds'

    $duplicate = @(
        (New-Response -Message ([ordered]@{ role = 'assistant'; content = $null; tool_calls = @((New-ToolCall 'd1' 'search_text' ([ordered]@{ pattern = 'same' }))) })),
        (New-Response -Message ([ordered]@{ role = 'assistant'; content = $null; tool_calls = @((New-ToolCall 'd2' 'search_text' ([ordered]@{ pattern = 'same' }))) })),
        (New-Response -Message ([ordered]@{ role = 'assistant'; content = $null; tool_calls = @((New-ToolCall 'd3' 'search_text' ([ordered]@{ pattern = 'same' }))) }))
    )
    Save-Responses $duplicateResponses $duplicate
    $duplicateRun = Invoke-Runner -Root $testRoot -Allow @('allowed.txt') -ResponsesPath $duplicateResponses -Checkpoint (New-ExternalCheckpoint 'duplicate') -Turns 8
    Assert-Equal $duplicateRun.rc 1 'duplicate exit'
    Assert-True ($duplicateRun.json.warnings.code -contains 'DUPLICATE_TOOL_BATCH') 'duplicate warning'
    Assert-True ($duplicateRun.json.errors.code -contains 'DUPLICATE_TOOL_CALLS') 'duplicate stop'

    Write-TestText $resumeFile 'one'
    $resumeFirst = @(
        (New-Response -Message ([ordered]@{
            role = 'assistant'
            content = $null
            reasoning_content = 'readonly reasoning sk-secret-token-12345'
            tool_calls = @((New-ToolCall 's1' 'search_text' ([ordered]@{ pattern = 'one' })))
        }))
    )
    Save-Responses $resumeResponses $resumeFirst
    $resumeInitial = Invoke-Runner -Root $testRoot -Allow @('resume.txt') -ResponsesPath $resumeResponses -Checkpoint $checkpoint -Turns 1
    Assert-Equal $resumeInitial.rc 1 'resume checkpoint initial stop'
    Assert-True $resumeInitial.json.checkpoint_saved 'resume checkpoint saved'
    $resumeRaw = Read-TestText $checkpoint
    Assert-True ($resumeRaw.Contains('readonly reasoning')) 'ReadOnly reasoning checkpoint preservation'
    Assert-True (-not $resumeRaw.Contains('sk-secret-token-12345')) 'resume checkpoint redacts secret'
    Write-TestText $resumeFile 'changed-before-resume'
    $resumeMismatch = Invoke-Runner -Root $testRoot -Allow @('resume.txt') -ResponsesPath $resumeResponses -Resume $checkpoint -Turns 2
    Assert-Equal $resumeMismatch.rc 1 'resume fingerprint exit'
    Assert-True ($resumeMismatch.json.errors.code -contains 'CHECKPOINT_RESUME_FAILED') 'resume fingerprint fail closed'
    Write-TestText $resumeFile 'one'
    $resumeSecond = @(
        (New-Response -Message ([ordered]@{ role = 'assistant'; content = 'resumed complete'; tool_calls = @() }) -FinishReason 'stop')
    )
    Save-Responses $resumeResponses $resumeSecond
    $resumeOk = Invoke-Runner -Root $testRoot -Allow @('resume.txt') -ResponsesPath $resumeResponses -Resume $checkpoint -Turns 2
    Assert-Equal $resumeOk.rc 0 'resume success exit'
    Assert-Equal $resumeOk.json.status 'PASS' 'resume success status'
    Assert-Equal $resumeOk.json.turns_used 2 'resume next turn'

    $tampered = $resumeRaw.Replace('"no_progress_rounds":  1', '"no_progress_rounds":  2')
    Write-TestText $checkpoint $tampered
    $hashMismatch = Invoke-Runner -Root $testRoot -Allow @('resume.txt') -ResponsesPath $resumeResponses -Resume $checkpoint -Turns 2
    Assert-Equal $hashMismatch.rc 1 'checkpoint hash exit'
    Assert-True ($hashMismatch.json.errors.code -contains 'CHECKPOINT_HASH_MISMATCH') 'checkpoint hash fail closed'
    Write-TestText $checkpoint $resumeRaw

    Write-TestText $checkpoint 'not-json'
    $corrupt = Invoke-Runner -Root $testRoot -Allow @('resume.txt') -ResponsesPath $resumeResponses -Resume $checkpoint -Turns 2
    Assert-Equal $corrupt.rc 1 'corrupt checkpoint exit'
    Assert-True ($corrupt.json.errors.code -contains 'CHECKPOINT_RESUME_FAILED') 'corrupt checkpoint fail closed'

    $textRun = Invoke-Runner -Root $testRoot -Offline -WithoutJson
    Assert-Equal $textRun.rc 0 'text output exit'
    Assert-True $textRun.raw.Contains('DEEPSEEK_WORKSPACE_RUNNER=OFFLINE_CONFIG') 'text compatibility summary'
}
catch {
    $script:Failed++
    [void]$script:Failures.Add('harness exception: ' + $_.Exception.Message)
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        try {
            Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction Stop
        }
        catch {
            $script:Failed++
            [void]$script:Failures.Add('test cleanup: ' + $_.Exception.Message)
        }
    }
    foreach ($checkpointPath in @($script:ExternalCheckpoints)) {
        if (Test-Path -LiteralPath $checkpointPath) {
            try {
                Remove-Item -LiteralPath $checkpointPath -Force -ErrorAction Stop
            }
            catch {
                $script:Failed++
                [void]$script:Failures.Add('checkpoint cleanup: ' + $_.Exception.Message)
            }
        }
    }
    Write-Output ('RUNNER_CONTRACT total={0} passed={1} failed={2}' -f $script:Total, $script:Passed, $script:Failed)
    foreach ($failure in $script:Failures) {
        Write-Output ('FAIL: ' + $failure)
    }
    if ($script:Failed -gt 0) {
        exit 1
    }
    exit 0
}
