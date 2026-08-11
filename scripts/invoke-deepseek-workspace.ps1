[CmdletBinding()]
param(
    [string]$RepositoryRoot = '',
    [ValidateSet('ReadOnly', 'Writer')]
    [string]$Mode = 'ReadOnly',
    [ValidateSet('DeepSeek', 'OpenRouter')]
    [string]$Provider = 'DeepSeek',
    # AllowPath is the write allowlist. Every write path is also readable.
    [string[]]$AllowPath,
    # ReadPath adds read-only reference paths that write tools must reject.
    [string[]]$ReadPath,
    [string]$EnvFile = '',
    [switch]$DryRun,
    [string]$Prompt = '',
    [string]$Model = '',
    [ValidateRange(1, 96)]
    [int]$MaxTurns = 48,
    [ValidateRange(1, 64)]
    [int]$MaxReadToolCalls = 12,
    [ValidateRange(128, 32768)]
    [int]$MaxTokens = 32768,
    [ValidateSet('Auto', 'ReplaceText', 'ApplyPatch')]
    [string]$WriteStrategy = 'Auto',
    [ValidateSet('low', 'high', 'max')]
    [string]$ReasoningEffort = 'high',
    [ValidateSet('auto', 'enabled', 'disabled')]
    [string]$ThinkingMode = 'auto',
    [switch]$DirectResponse,
    [int]$RequestTimeoutSeconds = 0,
    [string]$Endpoint = '',
    [switch]$JsonOutput,
    [switch]$ShowProgress,
    [string]$TaskId = '',
    [string]$CheckpointPath = '',
    [Alias('Resume')]
    [string]$ResumeCheckpoint = '',
    [switch]$OfflineConfig,
    [switch]$TestMode,
    [string]$MockResponsesPath = '',
    [ValidateRange(0, 1048576)]
    [int]$ExpectedWriteBytes = 0,
    # Wall-clock and cumulative model-request budgets (minutes).
    [ValidateRange(1, 10080)]
    [int]$MaxElapsedMinutes = 60,
    [ValidateRange(1, 10080)]
    [int]$MaxApiElapsedMinutes = 50
)

$ErrorActionPreference = 'Stop'

$script:RunnerName = 'deepseek-workspace-runner'
$script:RunnerVersion = '2.8.0'
$script:SchemaVersion = '2.3.0'
$script:MutationAtomicityContract = 'rollback-backed exception-atomic under exclusive workspace ownership; not crash/power-loss atomic'
$script:ProviderContextLimit = 1000000
$script:ContextSoftLimit = 850000
$script:ContextHardLimit = 950000
$script:OutputReserveTokens = [int64]$MaxTokens
$script:HardTurnLimit = 96
$script:ExtensionSize = 8
$script:CheckpointTurn = 64
$script:SoftTurn = 80
$script:Mode = $Mode
$script:Provider = $Provider
$script:TimeoutSeconds = 0
$script:WriteRoots = @()
$script:ReadRoots = @()
$script:WritePathDisplay = @()
$script:ReadPathDisplay = @()
$script:ExpectedFingerprint = ''
$script:BaseHead = 'GIT_METADATA_UNAVAILABLE'
$script:FinalHead = 'GIT_METADATA_UNAVAILABLE'
$script:WorkspaceDiffHash = $null
$script:Messages = @()
$script:MockResponses = @()
$script:MockIndex = 0
$script:RequestCount = 0
$script:TurnsUsed = 0
$script:EffectiveMaxTurns = $MaxTurns
$script:ExtensionsUsed = 0
$script:NoProgressRounds = 0
$script:LastExtensionEditCount = 0
$script:LastExtensionNetChangeFingerprint = ''
$script:EditCount = 0
$script:PatchCount = 0
$script:ReadCallCount = 0
$script:ToolCallCount = 0
$script:ToolCallsByName = [ordered]@{}
$script:ToolCallSequence = @()
$script:ChangedPaths = [ordered]@{}
$script:ChangedFileHashes = [ordered]@{}
$script:BaseWriteState = [ordered]@{}
$script:Errors = @()
$script:Warnings = @()
$script:FinishReasons = @()
$script:LeadingToolFailure = $false
$script:StopReason = ''
$script:FinalResponse = ''
$script:LatestPromptTokens = 0
$script:LatestCompletionTokens = 0
$script:LatestContextTokens = 0
$script:LatestUsageKnown = $false
$script:CumulativePromptTokens = 0
$script:CumulativeCompletionTokens = 0
$script:CheckpointPathResolved = ''
$script:CheckpointSaved = $false
$script:CheckpointRound = 0
$script:LastCheckpointEditCount = 0
$script:CheckpointFailure = $false
$script:Status = 'FAIL'
$script:ExitCode = 1
$script:ApiKey = $null
$script:ThinkingModeResolved = 'provider-default'
$script:RequestDurationsMs = @()
$script:RunStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
# Elapsed restored from prior process(es) on resume; live stopwatch is only this process.
$script:ElapsedBeforeProcessMs = [int64]0
$script:ApiElapsedBeforeProcessMs = [int64]0
$script:MaxElapsedMinutes = $MaxElapsedMinutes
$script:MaxApiElapsedMinutes = $MaxApiElapsedMinutes
$script:FreshReadTokens = @{}
$script:PriorFreshTokens = $null
$script:FreshReadRecoveryTurn = $false
$script:MinimumWriterOutputTokens = 8192
$script:RequestedWriteStrategy = 'None'
$script:EffectiveWriteStrategy = 'None'
$script:EstimatedWriterOutputTokens = 0
$script:ConvergenceMode = 'none'
$script:LastExposedToolNames = @()
$script:ToolExposureHistory = @()
$script:ExpectedWriteBytes = $ExpectedWriteBytes
$script:EffectiveExpectedWriteBytes = 0
$script:WriterBudgetSource = ''

function Redact-Text {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) {
        return $null
    }
    $text = [string]$Value
    if ([string]::IsNullOrEmpty($text)) {
        return $text
    }

    # Safe markers (allowed in checkpoints/results): [REDACTED], [REDACTED_*], Bearer [REDACTED]
    # Residual fail-closed is value-shaped only. Documentation that merely names keys
    # (e.g. \"secret\": in a regex explanation) or uses secret:/password: prose must pass.
    $safeMarker = '\[REDACTED(?:_[A-Z0-9_]+)?\]'
    # Named keys include generic "token" for "token":"<long value>" while residual still
    # requires an actual non-marker value (key-only docs and short prose remain allowed).
    $secretKey = '(?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|secret|password|\btoken\b)'
    $namedKey = '(?:authorization|' + $secretKey + ')'

    # --- mask known secret value shapes ---
    $escapedJsonPattern = '(?is)(?<prefix>\\+"(?:' + $namedKey + ')\\+"\s*[:=]\s*)(?<open>\\+)"(?:(?!\\+").)*(?<close>\\+)"'
    $escapedJsonReplacement = '${prefix}${open}"[REDACTED]${close}"'
    $text = [regex]::Replace($text, $escapedJsonPattern, $escapedJsonReplacement)
    $quotedOrLineValue = '(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\r\n,;}\]]*)'
    $authorizationPrefix = '(?i)(?<prefix>["'']?authorization["'']?\s*[:=]\s*)'
    $secretPrefix = '(?i)(?<prefix>["'']?' + $secretKey + '["'']?\s*[:=]\s*)'
    $redacted = [regex]::Replace(
        $text,
        $authorizationPrefix + '(?:bearer\s+)?' + $quotedOrLineValue,
        '${prefix}"[REDACTED]"'
    )
    $redacted = [regex]::Replace(
        $redacted,
        $secretPrefix + $quotedOrLineValue,
        '${prefix}"[REDACTED]"'
    )
    $redacted = [regex]::Replace(
        $redacted,
        '(?i)\bbearer\s+(?!' + $safeMarker + ')[A-Za-z0-9._~+/=-]+',
        'Bearer [REDACTED]'
    )
    # sk- tokens: require token body (alnum/_/-) length >= 8; do not treat regex docs like sk-[A-Za-z...] as tokens
    $redacted = [regex]::Replace(
        $redacted,
        '(?i)\bsk-[A-Za-z0-9_-]{8,}\b',
        '[REDACTED]'
    )
    # compact JWT-shaped values (header.payload[.sig]); documentation "eyJ/..." without dots is ignored
    $redacted = [regex]::Replace(
        $redacted,
        '\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b',
        '[REDACTED]'
    )

    # --- residual fail-closed: require an actual non-marker *value* after a secret key ---
    # Quoted JSON/text values that are not safe markers.
    $unredactedQuoted = '(?i)["'']?' + $namedKey + '["'']?\s*[:=]\s*"(?!' + $safeMarker + ')[^"\r\n]+"'
    $unredactedSingleQuoted = "(?i)[`"']?" + $namedKey + "[`"']?\s*[:=]\s*'(?!" + $safeMarker + ")[^'\r\n]+'"
    # Bare token-shaped assignments (sk-/JWT/long token body). Short prose words after key: do not match.
    $unredactedTokenShaped = '(?i)["'']?' + $namedKey + '["'']?\s*[:=]\s*(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+|[A-Za-z0-9_-]{20,})\b'
    # Escaped JSON must include a non-marker escaped string value. Key-only docs like \"secret\": must not fail.
    $unredactedEscapedJsonValue = '(?is)\\+"(?:' + $namedKey + ')\\+"\s*[:=]\s*\\+"(?!' + $safeMarker + ')(?:(?!\\+").)+\\+"'
    # Standalone bearer/sk/JWT residuals (not already safe markers)
    $unredactedBearer = '(?i)\bbearer\s+(?!' + $safeMarker + ')[A-Za-z0-9._~+/=-]{8,}'
    $unredactedSk = '(?i)\bsk-[A-Za-z0-9_-]{8,}\b'
    $unredactedJwt = '\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b'
    if (
        [regex]::IsMatch($redacted, $unredactedEscapedJsonValue) -or
        [regex]::IsMatch($redacted, $unredactedQuoted) -or
        [regex]::IsMatch($redacted, $unredactedSingleQuoted) -or
        [regex]::IsMatch($redacted, $unredactedTokenShaped) -or
        [regex]::IsMatch($redacted, $unredactedBearer) -or
        [regex]::IsMatch($redacted, $unredactedSk) -or
        [regex]::IsMatch($redacted, $unredactedJwt)
    ) {
        throw 'REDACTION_FAILED'
    }
    return $redacted
}

function Assert-CheckpointSuccessOrDemote {
    param(
        [bool]$Saved,
        [string]$Context = 'checkpoint'
    )
    if ($Saved) {
        return
    }
    # Required checkpoint path failed: never keep PASS/exit 0.
    if ($script:Status -eq 'PASS' -or $script:ExitCode -eq 0) {
        if ($script:EditCount -gt 0) {
            $script:Status = 'PARTIAL_AFTER_EDIT'
            $script:ExitCode = 2
        }
        else {
            $script:Status = 'FAIL'
            $script:ExitCode = 1
        }
    }
    if ([string]::IsNullOrWhiteSpace($script:StopReason) -or $script:StopReason -eq 'MODEL_COMPLETED') {
        $script:StopReason = 'CHECKPOINT_WRITE_FAILED'
    }
}

function Get-WritableFiles {
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($root in $script:WriteRoots) {
        $full = Get-FullPathFromRelative $root
        if (-not (Test-Path -LiteralPath $full)) {
            continue
        }
        $item = Get-Item -LiteralPath $full
        if ($item.PSIsContainer) {
            $pending = New-Object System.Collections.Generic.Stack[string]
            $pending.Push($full)
            while ($pending.Count -gt 0) {
                $directory = $pending.Pop()
                Assert-NoRepositoryReparsePoint -FullPath $directory
                foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
                    if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                        throw 'PATH_REPARSE_POINT_FORBIDDEN'
                    }
                    $relative = Get-RelativePathFromFull $child.FullName
                    if (Test-SensitiveRelativePath $relative) {
                        continue
                    }
                    if ($child.PSIsContainer) {
                        $pending.Push($child.FullName)
                        continue
                    }
                    [void]$files.Add([pscustomobject]@{
                        relative = $relative
                        full = $child.FullName
                    })
                }
            }
        }
        elseif (-not (Test-SensitiveRelativePath $root)) {
            [void]$files.Add([pscustomobject]@{ relative = (Get-RelativePathFromFull $full); full = $full })
        }
    }
    $unique = @{}
    foreach ($file in $files) {
        $key = $file.relative.ToLowerInvariant()
        if (-not $unique.ContainsKey($key)) {
            $unique[$key] = $file
        }
    }
    return @($unique.Values | Sort-Object relative)
}

function Get-WritePathState {
    # SHA256 or MISSING for every writable path (leaf roots, files under dir roots, missing roots).
    $state = [ordered]@{}
    foreach ($file in @(Get-WritableFiles)) {
        try {
            $state[$file.relative] = Get-FileSha256 $file.full
        }
        catch {
            $state[$file.relative] = 'UNREADABLE'
        }
    }
    foreach ($root in $script:WriteRoots) {
        if (-not $state.Contains($root)) {
            $full = Get-FullPathFromRelative $root
            if (-not (Test-Path -LiteralPath $full)) {
                $state[$root] = 'MISSING'
            }
        }
    }
    return $state
}

function Seal-BaseWriteState {
    $script:BaseWriteState = Get-WritePathState
}

function Get-NetChangedPaths {
    param(
        [AllowNull()][object]$CurrentWriteState = $null
    )
    $current = if ($null -ne $CurrentWriteState) { $CurrentWriteState } else { Get-WritePathState }
    $keys = @{}
    foreach ($key in @($script:BaseWriteState.Keys)) {
        $keys[[string]$key] = $true
    }
    foreach ($key in @($current.Keys)) {
        $keys[[string]$key] = $true
    }
    $changed = New-Object System.Collections.Generic.List[string]
    foreach ($key in @($keys.Keys | Sort-Object)) {
        $baseVal = if ($script:BaseWriteState.Contains($key)) { [string]$script:BaseWriteState[$key] } else { 'MISSING' }
        $curVal = if ($current.Contains($key)) { [string]$current[$key] } else { 'MISSING' }
        if ($baseVal -ne $curVal) {
            [void]$changed.Add($key)
        }
    }
    return @($changed.ToArray())
}

function Get-NetChangedFileHashes {
    param(
        [AllowNull()][object]$CurrentWriteState = $null
    )
    $current = if ($null -ne $CurrentWriteState) { $CurrentWriteState } else { Get-WritePathState }
    $hashes = [ordered]@{}
    foreach ($path in @(Get-NetChangedPaths -CurrentWriteState $current)) {
        if ($current.Contains($path)) {
            $hashes[$path] = [string]$current[$path]
        }
        else {
            $hashes[$path] = 'MISSING'
        }
    }
    return $hashes
}

function Get-NetChangeEvidenceFingerprint {
    param(
        [AllowNull()][object]$CurrentWriteState = $null
    )
    $parts = New-Object System.Collections.Generic.List[string]
    $hashes = Get-NetChangedFileHashes -CurrentWriteState $CurrentWriteState
    foreach ($path in @($hashes.Keys | Sort-Object)) {
        [void]$parts.Add(([string]$path + '|' + [string]$hashes[$path]))
    }
    return (Get-Sha256Text ([string]::Join([Environment]::NewLine, @($parts.ToArray()))))
}

function Get-TestModeInjectedElapsedMs {
    param(
        [string]$EnvName,
        [string]$PostRequestEnvName
    )
    if (-not $TestMode) {
        return [int64]0
    }
    $raw = [System.Environment]::GetEnvironmentVariable($EnvName)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [int64]0
    }
    $postOnly = [System.Environment]::GetEnvironmentVariable($PostRequestEnvName)
    if (-not [string]::IsNullOrWhiteSpace($postOnly) -and $postOnly -ne '0') {
        # Post-request injection: apply only after at least one model request has been counted.
        if ($script:RequestCount -le 0) {
            return [int64]0
        }
    }
    try {
        return [int64]$raw
    }
    catch {
        return [int64]0
    }
}

function Get-TotalElapsedMs {
    $total = [int64]$script:ElapsedBeforeProcessMs + [int64]$script:RunStopwatch.ElapsedMilliseconds
    $inject = Get-TestModeInjectedElapsedMs -EnvName 'DEEPSEEK_RUNNER_TEST_ELAPSED_MS' -PostRequestEnvName 'DEEPSEEK_RUNNER_TEST_ELAPSED_POST_REQUEST'
    if ($inject -gt 0) {
        $total = [Math]::Max($total, $inject)
    }
    return [int64]$total
}

function Get-TotalApiElapsedMs {
    $currentSum = [int64]0
    if ($null -ne $script:RequestDurationsMs -and @($script:RequestDurationsMs).Count -gt 0) {
        $currentSum = [int64](($script:RequestDurationsMs | Measure-Object -Sum).Sum)
    }
    $total = [int64]$script:ApiElapsedBeforeProcessMs + $currentSum
    $inject = Get-TestModeInjectedElapsedMs -EnvName 'DEEPSEEK_RUNNER_TEST_API_ELAPSED_MS' -PostRequestEnvName 'DEEPSEEK_RUNNER_TEST_API_ELAPSED_POST_REQUEST'
    if ($inject -gt 0) {
        $total = [Math]::Max($total, $inject)
    }
    return [int64]$total
}

function Get-MaxElapsedBudgetMs {
    return ([int64]$script:MaxElapsedMinutes * [int64]60000)
}

function Get-MaxApiElapsedBudgetMs {
    return ([int64]$script:MaxApiElapsedMinutes * [int64]60000)
}

function Get-RemainingWallBudgetMs {
    return ([int64](Get-MaxElapsedBudgetMs) - [int64](Get-TotalElapsedMs))
}

function Get-RemainingApiBudgetMs {
    return ([int64](Get-MaxApiElapsedBudgetMs) - [int64](Get-TotalApiElapsedMs))
}

function Get-RemainingTimeBudgetMs {
    # Minimum remaining wall/API budget. Call only after a successful precheck so
    # remaining is positive; clamp to at least 1 ms for HttpClient.Timeout.
    $wall = Get-RemainingWallBudgetMs
    $api = Get-RemainingApiBudgetMs
    $remaining = $wall
    if ($api -lt $remaining) {
        $remaining = $api
    }
    if ($remaining -lt [int64]1) {
        return [int64]1
    }
    return [int64]$remaining
}

function Get-EffectiveHttpClientTimeoutMs {
    # Clamp configured request timeout to remaining wall and API budgets.
    $configuredMs = [int64]$script:TimeoutSeconds * [int64]1000
    if ($configuredMs -lt [int64]1) {
        $configuredMs = [int64]1
    }
    $remainingMs = Get-RemainingTimeBudgetMs
    if ($remainingMs -lt $configuredMs) {
        return [int64]$remainingMs
    }
    return [int64]$configuredMs
}

function Test-TimeBudgetExceeded {
    # Returns error code string when exceeded; otherwise $null.
    if ((Get-TotalElapsedMs) -ge (Get-MaxElapsedBudgetMs)) {
        return 'MAX_ELAPSED_TIME_REACHED'
    }
    if ((Get-TotalApiElapsedMs) -ge (Get-MaxApiElapsedBudgetMs)) {
        return 'MAX_API_ELAPSED_TIME_REACHED'
    }
    return $null
}

function Stop-ForTimeBudget {
    param([string]$Code)
    Add-RunnerError $Code
    $script:StopReason = $Code
    # PARTIAL vs PARTIAL_AFTER_EDIT follows current net change vs BaseWriteState, not EditCount history.
    if (@(Get-NetChangedPaths).Count -gt 0) {
        $script:Status = 'PARTIAL_AFTER_EDIT'
        $script:ExitCode = 2
    }
    else {
        $script:Status = 'PARTIAL'
        $script:ExitCode = 2
    }
    if (-not $DirectResponse) {
        $saved = Save-Checkpoint 'time_budget'
        if (-not $saved) {
            Assert-CheckpointSuccessOrDemote -Saved $false -Context 'time_budget'
        }
    }
}

function Resolve-TextFileEncoding {
    param([AllowNull()][byte[]]$Bytes)
    if ($null -eq $Bytes) {
        $Bytes = [byte[]]@()
    }
    if (
        $Bytes.Length -ge 3 -and
        $Bytes[0] -eq 0xEF -and
        $Bytes[1] -eq 0xBB -and
        $Bytes[2] -eq 0xBF
    ) {
        return (New-Object System.Text.UTF8Encoding($true))
    }
    if (
        $Bytes.Length -ge 2 -and
        $Bytes[0] -eq 0xFF -and
        $Bytes[1] -eq 0xFE
    ) {
        return (New-Object System.Text.UnicodeEncoding($false, $true))
    }
    if (
        $Bytes.Length -ge 2 -and
        $Bytes[0] -eq 0xFE -and
        $Bytes[1] -eq 0xFF
    ) {
        return (New-Object System.Text.UnicodeEncoding($true, $true))
    }
    return (New-Object System.Text.UTF8Encoding($false))
}

function Get-StringFromFileBytes {
    param(
        [AllowNull()][byte[]]$Bytes,
        [System.Text.Encoding]$Encoding
    )
    if ($null -eq $Bytes) {
        $Bytes = [byte[]]@()
    }
    if ($null -eq $Encoding) {
        $Encoding = New-Object System.Text.UTF8Encoding($false)
    }
    $preamble = $Encoding.GetPreamble()
    $offset = 0
    if ($null -ne $preamble -and $preamble.Length -gt 0 -and $Bytes.Length -ge $preamble.Length) {
        $matches = $true
        for ($i = 0; $i -lt $preamble.Length; $i++) {
            if ($Bytes[$i] -ne $preamble[$i]) {
                $matches = $false
                break
            }
        }
        if ($matches) {
            $offset = $preamble.Length
        }
    }
    if ($offset -ge $Bytes.Length) {
        return ''
    }
    return $Encoding.GetString($Bytes, $offset, ($Bytes.Length - $offset))
}

function Get-FileBytesFromString {
    param(
        [AllowNull()][string]$Text,
        [System.Text.Encoding]$Encoding
    )
    if ($null -eq $Encoding) {
        $Encoding = New-Object System.Text.UTF8Encoding($false)
    }
    if ($null -eq $Text) {
        $Text = ''
    }
    $body = $Encoding.GetBytes($Text)
    $preamble = $Encoding.GetPreamble()
    if ($null -eq $preamble -or $preamble.Length -eq 0) {
        return $body
    }
    $combined = New-Object byte[] ($preamble.Length + $body.Length)
    [System.Buffer]::BlockCopy($preamble, 0, $combined, 0, $preamble.Length)
    if ($body.Length -gt 0) {
        [System.Buffer]::BlockCopy($body, 0, $combined, $preamble.Length, $body.Length)
    }
    return $combined
}

function Test-ByteArraysEqual {
    param(
        [AllowNull()][byte[]]$Left,
        [AllowNull()][byte[]]$Right
    )
    if ($null -eq $Left -and $null -eq $Right) {
        return $true
    }
    if ($null -eq $Left -or $null -eq $Right) {
        return $false
    }
    if ($Left.Length -ne $Right.Length) {
        return $false
    }
    for ($i = 0; $i -lt $Left.Length; $i++) {
        if ($Left[$i] -ne $Right[$i]) {
            return $false
        }
    }
    return $true
}

function Convert-JsonMapToOrdered {
    param(
        [AllowNull()][object]$Value,
        [ValidateSet('string', 'int', 'bool', 'raw')]
        [string]$ValueKind = 'string'
    )
    $map = [ordered]@{}
    if ($null -eq $Value) {
        return $map
    }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            $name = [string]$key
            if ($ValueKind -eq 'int') {
                $map[$name] = [int]$Value[$key]
            }
            elseif ($ValueKind -eq 'bool') {
                $map[$name] = $true
            }
            elseif ($ValueKind -eq 'raw') {
                $map[$name] = $Value[$key]
            }
            else {
                $map[$name] = [string]$Value[$key]
            }
        }
        return $map
    }
    foreach ($property in $Value.PSObject.Properties) {
        $name = [string]$property.Name
        if ($ValueKind -eq 'int') {
            $map[$name] = [int]$property.Value
        }
        elseif ($ValueKind -eq 'bool') {
            $map[$name] = $true
        }
        elseif ($ValueKind -eq 'raw') {
            $map[$name] = $property.Value
        }
        else {
            $map[$name] = [string]$property.Value
        }
    }
    return $map
}

function Get-RunnerStateObject {
    # Structured mutable execution state persisted in checkpoints and restored on resume.
    $writeState = Get-WritePathState
    return [ordered]@{
        turns_used = [int]$script:TurnsUsed
        effective_max_turns = [int]$script:EffectiveMaxTurns
        extensions_used = [int]$script:ExtensionsUsed
        no_progress_rounds = [int]$script:NoProgressRounds
        request_count = [int]$script:RequestCount
        latest_prompt_tokens = [int64]$script:LatestPromptTokens
        latest_completion_tokens = [int64]$script:LatestCompletionTokens
        latest_context_tokens = [int64]$script:LatestContextTokens
        latest_usage_known = [bool]$script:LatestUsageKnown
        cumulative_prompt_tokens = [int64]$script:CumulativePromptTokens
        cumulative_completion_tokens = [int64]$script:CumulativeCompletionTokens
        edit_count = [int]$script:EditCount
        patch_count = [int]$script:PatchCount
        read_tool_calls = [int]$script:ReadCallCount
        tool_calls = [int]$script:ToolCallCount
        tool_calls_by_name = $script:ToolCallsByName
        tool_call_sequence = @($script:ToolCallSequence)
        changed_paths = @($script:ChangedPaths.Keys | Sort-Object)
        changed_file_hashes = $script:ChangedFileHashes
        base_write_state = $script:BaseWriteState
        net_changed_paths = @(Get-NetChangedPaths -CurrentWriteState $writeState)
        net_changed_file_hashes = (Get-NetChangedFileHashes -CurrentWriteState $writeState)
        last_extension_edit_count = [int]$script:LastExtensionEditCount
        last_extension_net_change_fingerprint = [string]$script:LastExtensionNetChangeFingerprint
        last_checkpoint_edit_count = [int]$script:LastCheckpointEditCount
        checkpoint_round = [int]$script:CheckpointRound
        convergence_mode = [string]$script:ConvergenceMode
        requested_write_strategy = [string]$script:RequestedWriteStrategy
        effective_write_strategy = [string]$script:EffectiveWriteStrategy
        expected_write_bytes = [int]$script:ExpectedWriteBytes
        effective_expected_write_bytes = [int]$script:EffectiveExpectedWriteBytes
        writer_budget_source = [string]$script:WriterBudgetSource
        finish_reasons = @($script:FinishReasons)
        leading_tool_failure = [bool]$script:LeadingToolFailure
        expected_fingerprint = [string]$script:ExpectedFingerprint
        # Totals at save time; resume loads them into *BeforeProcess* so live stopwatch is not double-counted.
        elapsed_ms = (Get-TotalElapsedMs)
        api_elapsed_ms = (Get-TotalApiElapsedMs)
        max_elapsed_minutes = [int]$script:MaxElapsedMinutes
        max_api_elapsed_minutes = [int]$script:MaxApiElapsedMinutes
    }
}

function Assert-RunnerStateComplete {
    param([AllowNull()][object]$State)
    if ($null -eq $State) {
        throw 'CHECKPOINT_RUNNER_STATE_MISSING'
    }
    $required = @(
        'turns_used',
        'effective_max_turns',
        'extensions_used',
        'no_progress_rounds',
        'request_count',
        'latest_prompt_tokens',
        'latest_completion_tokens',
        'latest_context_tokens',
        'latest_usage_known',
        'cumulative_prompt_tokens',
        'cumulative_completion_tokens',
        'edit_count',
        'patch_count',
        'read_tool_calls',
        'tool_calls',
        'tool_calls_by_name',
        'tool_call_sequence',
        'changed_paths',
        'changed_file_hashes',
        'base_write_state',
        'last_extension_edit_count',
        'last_extension_net_change_fingerprint',
        'last_checkpoint_edit_count',
        'checkpoint_round',
        'convergence_mode',
        'requested_write_strategy',
        'effective_write_strategy',
        'expected_write_bytes',
        'effective_expected_write_bytes',
        'writer_budget_source',
        'finish_reasons',
        'leading_tool_failure',
        'expected_fingerprint',
        'elapsed_ms',
        'api_elapsed_ms',
        'max_elapsed_minutes',
        'max_api_elapsed_minutes'
    )
    $names = @()
    if ($State -is [System.Collections.IDictionary]) {
        $names = @($State.Keys | ForEach-Object { [string]$_ })
    }
    else {
        $names = @($State.PSObject.Properties | ForEach-Object { [string]$_.Name })
    }
    foreach ($key in $required) {
        if ($names -notcontains $key) {
            throw ('CHECKPOINT_RUNNER_STATE_INCOMPLETE:' + $key)
        }
    }
}

function Get-RunnerStateField {
    param(
        [object]$State,
        [string]$Name
    )
    if ($State -is [System.Collections.IDictionary]) {
        if (-not $State.Contains($Name)) {
            throw ('CHECKPOINT_RUNNER_STATE_INCOMPLETE:' + $Name)
        }
        return $State[$Name]
    }
    $property = $State.PSObject.Properties | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
    if ($null -eq $property) {
        throw ('CHECKPOINT_RUNNER_STATE_INCOMPLETE:' + $Name)
    }
    return $property.Value
}

function Restore-RunnerState {
    param([object]$State)
    Assert-RunnerStateComplete $State
    $script:TurnsUsed = [int](Get-RunnerStateField -State $State -Name 'turns_used')
    $script:EffectiveMaxTurns = [Math]::Min($HardTurnLimit, [Math]::Max($MaxTurns, [int](Get-RunnerStateField -State $State -Name 'effective_max_turns')))
    $script:ExtensionsUsed = [int](Get-RunnerStateField -State $State -Name 'extensions_used')
    $script:NoProgressRounds = [int](Get-RunnerStateField -State $State -Name 'no_progress_rounds')
    $script:RequestCount = [int](Get-RunnerStateField -State $State -Name 'request_count')
    $script:LatestPromptTokens = [int64](Get-RunnerStateField -State $State -Name 'latest_prompt_tokens')
    $script:LatestCompletionTokens = [int64](Get-RunnerStateField -State $State -Name 'latest_completion_tokens')
    $script:LatestContextTokens = [int64](Get-RunnerStateField -State $State -Name 'latest_context_tokens')
    $script:LatestUsageKnown = [bool](Get-RunnerStateField -State $State -Name 'latest_usage_known')
    $script:CumulativePromptTokens = [int64](Get-RunnerStateField -State $State -Name 'cumulative_prompt_tokens')
    $script:CumulativeCompletionTokens = [int64](Get-RunnerStateField -State $State -Name 'cumulative_completion_tokens')
    $script:EditCount = [int](Get-RunnerStateField -State $State -Name 'edit_count')
    $script:PatchCount = [int](Get-RunnerStateField -State $State -Name 'patch_count')
    $script:ReadCallCount = [int](Get-RunnerStateField -State $State -Name 'read_tool_calls')
    $script:ToolCallCount = [int](Get-RunnerStateField -State $State -Name 'tool_calls')
    $script:ToolCallsByName = Convert-JsonMapToOrdered -Value (Get-RunnerStateField -State $State -Name 'tool_calls_by_name') -ValueKind int
    $sequence = @(Get-RunnerStateField -State $State -Name 'tool_call_sequence')
    $script:ToolCallSequence = @()
    foreach ($item in $sequence) {
        if ($null -ne $item) {
            $script:ToolCallSequence += (Convert-ToSafeObject $item)
        }
    }
    $script:ChangedPaths = [ordered]@{}
    foreach ($path in @(Get-RunnerStateField -State $State -Name 'changed_paths')) {
        if (-not [string]::IsNullOrWhiteSpace([string]$path)) {
            $script:ChangedPaths[[string]$path] = $true
        }
    }
    $script:ChangedFileHashes = Convert-JsonMapToOrdered -Value (Get-RunnerStateField -State $State -Name 'changed_file_hashes') -ValueKind string
    $script:BaseWriteState = Convert-JsonMapToOrdered -Value (Get-RunnerStateField -State $State -Name 'base_write_state') -ValueKind string
    $script:LastExtensionEditCount = [int](Get-RunnerStateField -State $State -Name 'last_extension_edit_count')
    $script:LastExtensionNetChangeFingerprint = [string](Get-RunnerStateField -State $State -Name 'last_extension_net_change_fingerprint')
    $script:LastCheckpointEditCount = [int](Get-RunnerStateField -State $State -Name 'last_checkpoint_edit_count')
    $script:CheckpointRound = [int](Get-RunnerStateField -State $State -Name 'checkpoint_round')
    $script:ConvergenceMode = [string](Get-RunnerStateField -State $State -Name 'convergence_mode')
    $script:RequestedWriteStrategy = [string](Get-RunnerStateField -State $State -Name 'requested_write_strategy')
    $script:EffectiveWriteStrategy = [string](Get-RunnerStateField -State $State -Name 'effective_write_strategy')
    $script:ExpectedWriteBytes = [int](Get-RunnerStateField -State $State -Name 'expected_write_bytes')
    $script:EffectiveExpectedWriteBytes = [int](Get-RunnerStateField -State $State -Name 'effective_expected_write_bytes')
    $script:WriterBudgetSource = [string](Get-RunnerStateField -State $State -Name 'writer_budget_source')
    $finish = Get-RunnerStateField -State $State -Name 'finish_reasons'
    if ($null -eq $finish) {
        $script:FinishReasons = @()
    }
    else {
        $script:FinishReasons = @($finish | ForEach-Object { [string]$_ })
    }
    $script:LeadingToolFailure = [bool](Get-RunnerStateField -State $State -Name 'leading_tool_failure')
    $script:ExpectedFingerprint = [string](Get-RunnerStateField -State $State -Name 'expected_fingerprint')
    # Restore prior-process totals into before-process buckets. Do NOT reset RunStopwatch:
    # it has already been counting this process's validation/snapshot/checkpoint-load work,
    # and the saved totals came from the prior process only (no double count).
    $script:ElapsedBeforeProcessMs = [int64](Get-RunnerStateField -State $State -Name 'elapsed_ms')
    $script:ApiElapsedBeforeProcessMs = [int64](Get-RunnerStateField -State $State -Name 'api_elapsed_ms')
    # Current-process request durations start empty; prior API time lives in ApiElapsedBeforeProcessMs.
    $script:RequestDurationsMs = @()
    # Tighten budgets: effective limit = min(CLI, saved). Loosening on resume is not allowed.
    $savedMaxElapsed = [int](Get-RunnerStateField -State $State -Name 'max_elapsed_minutes')
    $savedMaxApi = [int](Get-RunnerStateField -State $State -Name 'max_api_elapsed_minutes')
    if ($savedMaxElapsed -le 0 -or $savedMaxApi -le 0) {
        throw 'CHECKPOINT_BUDGET_LIMIT_INVALID'
    }
    if ($savedMaxApi -gt $savedMaxElapsed) {
        throw 'CHECKPOINT_BUDGET_LIMIT_INVALID'
    }
    if ($savedMaxElapsed -lt $script:MaxElapsedMinutes) {
        $script:MaxElapsedMinutes = $savedMaxElapsed
    }
    if ($savedMaxApi -lt $script:MaxApiElapsedMinutes) {
        $script:MaxApiElapsedMinutes = $savedMaxApi
    }
    if ($script:MaxApiElapsedMinutes -gt $script:MaxElapsedMinutes) {
        $script:MaxApiElapsedMinutes = $script:MaxElapsedMinutes
    }
}

function Get-ProgressMetric {
    # Writer progress is positive net change vs sealed BaseWriteState, not tool call counts.
    # Read-only evidence gathering is not progress.
    $writeState = Get-WritePathState
    $netPaths = @(Get-NetChangedPaths -CurrentWriteState $writeState)
    return [pscustomobject]@{
        net_changed_path_count = [int]$netPaths.Count
        net_change_fingerprint = (Get-NetChangeEvidenceFingerprint -CurrentWriteState $writeState)
        edit_count = [int]$script:EditCount
        patch_count = [int]$script:PatchCount
        changed_path_count = @($script:ChangedPaths.Keys).Count
    }
}

function Test-HasPositiveProgress {
    param(
        [AllowNull()][object]$Before,
        [AllowNull()][object]$After
    )
    if ($null -eq $Before -or $null -eq $After) {
        return $false
    }
    # Positive progress requires a non-empty net-change set that differs from the prior metric.
    # A→B→A yields empty net_changed_paths and therefore is not progress.
    if ([int]$After.net_changed_path_count -le 0) {
        return $false
    }
    if ([string]$After.net_change_fingerprint -ne [string]$Before.net_change_fingerprint) {
        return $true
    }
    return $false
}

function Test-ReadOnlyTerminalSuccess {
    # Reviewer/ReadOnly success: completed without errors, leading tool failure,
    # or workspace fingerprint drift. Filesystem mutation is independently forbidden.
    return (
        $script:Mode -eq 'ReadOnly' -and
        $script:Errors.Count -eq 0 -and
        -not $script:LeadingToolFailure -and
        (Test-ExpectedFingerprint)
    )
}

function Test-WriterTerminalSuccess {
    # Writer success requires at least one net-changed writable path vs sealed baseline,
    # clean error/tool state, and fingerprint consistency. EditCount alone is insufficient
    # (A→B→A leaves edit_count>0 with empty net change and must not PASS).
    # Checkpoint integrity is enforced separately via Assert-CheckpointSuccessOrDemote.
    return (
        $script:Mode -eq 'Writer' -and
        (@(Get-NetChangedPaths).Count -gt 0) -and
        $script:Errors.Count -eq 0 -and
        -not $script:LeadingToolFailure -and
        (Test-ExpectedFingerprint)
    )
}

function Resolve-TerminalCompletionState {
    # Mode-specific terminal outcome when the model emits a completion message.
    # Fingerprint mismatch is never silent PASS/PARTIAL without the explicit code.
    if (-not (Test-ExpectedFingerprint)) {
        if ($script:EditCount -gt 0) {
            return [pscustomobject]@{
                Status = 'PARTIAL_AFTER_EDIT'
                ExitCode = 2
                StopReason = 'WORKSPACE_FINGERPRINT_MISMATCH'
                ErrorCode = 'WORKSPACE_FINGERPRINT_MISMATCH'
            }
        }
        return [pscustomobject]@{
            Status = 'FAIL'
            ExitCode = 1
            StopReason = 'WORKSPACE_FINGERPRINT_MISMATCH'
            ErrorCode = 'WORKSPACE_FINGERPRINT_MISMATCH'
        }
    }
    if ($script:Mode -eq 'Writer' -and (@(Get-NetChangedPaths).Count -eq 0)) {
        if ($script:EditCount -eq 0) {
            return [pscustomobject]@{
                Status = 'PARTIAL'
                ExitCode = 2
                StopReason = 'WRITER_COMPLETED_WITHOUT_EDIT'
                ErrorCode = 'WRITER_COMPLETED_WITHOUT_EDIT'
            }
        }
        return [pscustomobject]@{
            Status = 'PARTIAL_AFTER_EDIT'
            ExitCode = 2
            StopReason = 'WRITER_COMPLETED_WITHOUT_NET_CHANGE'
            ErrorCode = 'WRITER_COMPLETED_WITHOUT_NET_CHANGE'
        }
    }
    if ($script:LeadingToolFailure -or $script:Errors.Count -gt 0) {
        if ($script:EditCount -gt 0) {
            return [pscustomobject]@{
                Status = 'PARTIAL_AFTER_EDIT'
                ExitCode = 2
                StopReason = 'MODEL_COMPLETED'
                ErrorCode = $null
            }
        }
        return [pscustomobject]@{
            Status = 'PARTIAL'
            ExitCode = 2
            StopReason = 'MODEL_COMPLETED'
            ErrorCode = $null
        }
    }
    if ($script:Mode -eq 'ReadOnly') {
        if (Test-ReadOnlyTerminalSuccess) {
            return [pscustomobject]@{
                Status = 'PASS'
                ExitCode = 0
                StopReason = 'MODEL_COMPLETED'
                ErrorCode = $null
            }
        }
    }
    elseif (Test-WriterTerminalSuccess) {
        return [pscustomobject]@{
            Status = 'PASS'
            ExitCode = 0
            StopReason = 'MODEL_COMPLETED'
            ErrorCode = $null
        }
    }
    if ($script:EditCount -gt 0) {
        return [pscustomobject]@{
            Status = 'PARTIAL_AFTER_EDIT'
            ExitCode = 2
            StopReason = 'MODEL_COMPLETED'
            ErrorCode = $null
        }
    }
    return [pscustomobject]@{
        Status = 'PARTIAL'
        ExitCode = 2
        StopReason = 'MODEL_COMPLETED'
        ErrorCode = $null
    }
}

function Resolve-WriteStrategy {
    param(
        [string]$Requested,
        [string]$Mode
    )
    if ($Mode -ne 'Writer') {
        return 'None'
    }
    if ($Requested -eq 'ReplaceText') {
        return 'ReplaceText'
    }
    if ($Requested -eq 'ApplyPatch') {
        return 'ApplyPatch'
    }
    # Auto: resolve from allowlisted target filesystem status (language-independent)
    if ($script:WriteRoots.Count -eq 0) {
        return 'ReplaceText'
    }
    $existingLeafCount = 0
    $hasMissing = $false
    $hasDirectory = $false
    foreach ($root in $script:WriteRoots) {
        $full = Get-FullPathFromRelative $root
        if (Test-Path -LiteralPath $full -PathType Container) {
            $hasDirectory = $true
        }
        elseif (Test-Path -LiteralPath $full -PathType Leaf) {
            $existingLeafCount++
        }
        else {
            $hasMissing = $true
        }
    }
    # Any directory target or mixed existing/missing set => ambiguous
    if ($hasDirectory -or ($existingLeafCount -gt 0 -and $hasMissing)) {
        throw 'WRITER_WRITE_STRATEGY_REQUIRED'
    }
    # All missing exact targets => ApplyPatch
    if ($hasMissing -and $existingLeafCount -eq 0) {
        return 'ApplyPatch'
    }
    # Exactly one existing exact leaf => ReplaceText; two or more => ApplyPatch
    if ($existingLeafCount -eq 1) {
        return 'ReplaceText'
    }
    if ($existingLeafCount -ge 2) {
        return 'ApplyPatch'
    }
    return 'ReplaceText'
}

function Get-EstimatedWriterOutputTokens {
    param(
        [string]$Mode
    )
    if ($Mode -ne 'Writer') {
        return 0
    }
    # --- Determine effective expected-write byte budget ---
    if ($script:ExpectedWriteBytes -gt 0) {
        $script:EffectiveExpectedWriteBytes = $script:ExpectedWriteBytes
        $script:WriterBudgetSource = 'explicit'
    }
    else {
        # Derive from target files; all write roots must be existing leaf files
        $largestSize = 0
        foreach ($root in $script:WriteRoots) {
            $full = Get-FullPathFromRelative $root
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                throw 'WRITER_PACKET_BUDGET_REQUIRED'
            }
            $item = Get-Item -LiteralPath $full
            if ($item.Length -gt $largestSize) {
                $largestSize = $item.Length
            }
        }
        $script:EffectiveExpectedWriteBytes = 2 * $largestSize + 2048
        $script:WriterBudgetSource = 'target-files'
    }
    # --- Compute prompt-based token estimate ---
    $promptEstimate = 8192
    if (-not [string]::IsNullOrWhiteSpace($Prompt)) {
        try {
            $json = ConvertTo-Json -InputObject ([string]$Prompt) -Compress
            $bytes = [System.Text.Encoding]::UTF8.GetByteCount($json)
            $promptEstimate = [Math]::Ceiling($bytes / 2.0) + 2048
        }
        catch {
            # Keep default
        }
    }
    # --- Compute write-based token estimate ---
    $writeEstimate = [Math]::Ceiling($script:EffectiveExpectedWriteBytes * 1.25) + 2048
    # --- Final estimate: max of prompt, write, and floor ---
    $estimate = [Math]::Max([Math]::Max($promptEstimate, $writeEstimate), 8192)
    # --- Check limits based on source ---
    if ($script:WriterBudgetSource -eq 'explicit' -and $estimate -gt 32768) {
        throw 'WRITER_PACKET_SPLIT_REQUIRED'
    }
    if ($script:WriterBudgetSource -eq 'target-files' -and $estimate -gt 32768) {
        throw 'WRITER_PACKET_BUDGET_REQUIRED'
    }
    return $estimate
}

function Get-ExposedWriteToolNames {
    param([string]$EffectiveStrategy)
    if ($EffectiveStrategy -eq 'None') {
        return @()
    }
    if ($EffectiveStrategy -eq 'ReplaceText') {
        return @('replace_text')
    }
    if ($EffectiveStrategy -eq 'ApplyPatch') {
        return @('apply_patch')
    }
    return @()
}

function Add-RunnerError {
    param(
        [string]$Code,
        [string]$Detail = ''
    )
    $script:Errors += [ordered]@{
        code = $Code
        detail = (Redact-Text $Detail)
    }
}

function Add-RunnerWarning {
    param(
        [string]$Code,
        [string]$Detail = ''
    )
    $existing = @($script:Warnings | Where-Object { $_.code -eq $Code })
    if ($existing.Count -eq 0) {
        $script:Warnings += [ordered]@{
            code = $Code
            detail = (Redact-Text $Detail)
        }
    }
}

function Get-Sha256Text {
    param([AllowNull()][string]$Text)
    if ($null -eq $Text) {
        $Text = ''
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-FileSha256 {
    param([string]$Path)
    $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return ([string]$hash.Hash).ToLowerInvariant()
}

function Get-NormalizedRelativePath {
    param([string]$Path)
    $relative = $Path.Replace('/', '\').Trim()
    if ($relative -eq '.') {
        return '.'
    }
    while ($relative.StartsWith('.\')) {
        $relative = $relative.Substring(2)
    }
    return $relative.TrimEnd('\')
}

function Test-SensitiveRelativePath {
    param([string]$RelativePath)
    $lower = (Get-NormalizedRelativePath $RelativePath).ToLowerInvariant()
    if ($lower -eq '.env.example') {
        return $false
    }
    $parts = $lower.Split('\')
    foreach ($part in $parts) {
        if ($part -in @('.git', '.codex', '.grok', 'node_modules', '__pycache__')) {
            return $true
        }
        if ($part -eq '.env' -or $part.StartsWith('.env.') -or $part -eq 'auth.json') {
            return $true
        }
        if ($part.StartsWith('id_rsa') -or $part.Contains('secret') -or $part.Contains('credential')) {
            return $true
        }
    }
    return $false
}

function Get-FullPathFromRelative {
    param([string]$RelativePath)
    $relative = Get-NormalizedRelativePath $RelativePath
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative -eq '.') {
        return $script:RepositoryRoot
    }
    if ([System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|\\)\.\.(\\|$)') {
        throw "PATH_OUTSIDE_REPOSITORY"
    }
    $full = [System.IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot $relative))
    $rootPrefix = $script:RepositoryRoot.TrimEnd('\') + '\'
    if (($full -ne $script:RepositoryRoot) -and (-not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "PATH_OUTSIDE_REPOSITORY"
    }
    Assert-NoRepositoryReparsePoint -FullPath $full
    return $full
}

function Get-RelativePathFromFull {
    param([string]$FullPath)
    $rootUri = New-Object System.Uri(($script:RepositoryRoot.TrimEnd('\') + '\'))
    $fileUri = New-Object System.Uri($FullPath)
    $relative = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($fileUri).ToString())
    return (Get-NormalizedRelativePath $relative)
}

function Assert-NoRepositoryReparsePoint {
    param([string]$FullPath)

    $root = [System.IO.Path]::GetFullPath($script:RepositoryRoot).TrimEnd('\')
    $candidate = [System.IO.Path]::GetFullPath($FullPath)
    $rootPrefix = $root + '\'
    if (($candidate -ne $root) -and (-not $candidate.StartsWith(
        $rootPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    ))) {
        throw 'PATH_OUTSIDE_REPOSITORY'
    }

    $existing = $candidate
    while (-not (Test-Path -LiteralPath $existing)) {
        $parent = Split-Path -Parent $existing
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $existing) {
            throw 'PATH_EXISTING_PARENT_NOT_FOUND'
        }
        $existing = $parent
    }

    while (-not $existing.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $item = Get-Item -LiteralPath $existing -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'PATH_REPARSE_POINT_FORBIDDEN'
        }
        $parent = Split-Path -Parent $existing
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $existing) {
            throw 'PATH_OUTSIDE_REPOSITORY'
        }
        $existing = $parent
    }
}

function Test-RelativePathInRoots {
    param(
        [string]$RelativePath,
        [object[]]$Roots
    )
    $relative = Get-NormalizedRelativePath $RelativePath
    if (Test-SensitiveRelativePath $relative) {
        return $false
    }
    if ($Roots.Count -eq 0) {
        return $false
    }
    foreach ($root in $Roots) {
        if ($root -eq '.') {
            return $true
        }
        if ($relative -eq $root -or $relative.StartsWith($root.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Test-ReadAllowedRelativePath {
    param([string]$RelativePath)
    return (Test-RelativePathInRoots -RelativePath $RelativePath -Roots $script:ReadRoots)
}

function Test-WriteAllowedRelativePath {
    param([string]$RelativePath)
    return (Test-RelativePathInRoots -RelativePath $RelativePath -Roots $script:WriteRoots)
}

function Get-ReadableFiles {
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($root in $script:ReadRoots) {
        $full = Get-FullPathFromRelative $root
        if (-not (Test-Path -LiteralPath $full)) {
            continue
        }
        $item = Get-Item -LiteralPath $full
        if ($item.PSIsContainer) {
            $pending = New-Object System.Collections.Generic.Stack[string]
            $pending.Push($full)
            while ($pending.Count -gt 0) {
                $directory = $pending.Pop()
                Assert-NoRepositoryReparsePoint -FullPath $directory
                foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
                    if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                        throw 'PATH_REPARSE_POINT_FORBIDDEN'
                    }
                    $relative = Get-RelativePathFromFull $child.FullName
                    if (Test-SensitiveRelativePath $relative) {
                        continue
                    }
                    if ($child.PSIsContainer) {
                        $pending.Push($child.FullName)
                        continue
                    }
                    [void]$files.Add([pscustomobject]@{
                        relative = $relative
                        full = $child.FullName
                    })
                }
            }
        }
        elseif (-not (Test-SensitiveRelativePath $root)) {
            [void]$files.Add([pscustomobject]@{ relative = (Get-RelativePathFromFull $full); full = $full })
        }
    }
    $unique = @{}
    foreach ($file in $files) {
        $key = $file.relative.ToLowerInvariant()
        if (-not $unique.ContainsKey($key)) {
            $unique[$key] = $file
        }
    }
    return @($unique.Values | Sort-Object relative)
}

function Get-WorkspaceSnapshot {
    $fileHashes = [ordered]@{}
    $canonical = New-Object System.Collections.Generic.List[string]
    foreach ($file in (Get-ReadableFiles)) {
        try {
            $hash = Get-FileSha256 $file.full
            $fileHashes[$file.relative] = $hash
            [void]$canonical.Add(($file.relative + '|' + $hash))
        }
        catch {
            $fileHashes[$file.relative] = 'UNREADABLE'
            [void]$canonical.Add(($file.relative + '|UNREADABLE'))
        }
    }
    foreach ($root in $script:ReadRoots) {
        if (-not (Test-Path -LiteralPath (Get-FullPathFromRelative $root))) {
            $fileHashes[$root] = 'MISSING'
            [void]$canonical.Add(($root + '|MISSING'))
        }
    }
    $canonicalArray = @($canonical | Sort-Object)
    $fingerprint = Get-Sha256Text ([string]::Join([Environment]::NewLine, $canonicalArray))
    return [pscustomobject]@{
        fingerprint = $fingerprint
        file_hashes = $fileHashes
        files = @($fileHashes.Keys | Sort-Object)
    }
}

function Get-GitHead {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& git -C $script:RepositoryRoot rev-parse HEAD 2>$null | ForEach-Object { [string]$_ })
        $exit = $LASTEXITCODE
        if ($exit -ne 0 -or $lines.Count -eq 0) {
            return 'GIT_METADATA_UNAVAILABLE'
        }
        $head = $lines[0].Trim()
        if ($head -notmatch '^[0-9a-fA-F]{7,64}$') {
            return 'GIT_METADATA_UNAVAILABLE'
        }
        return $head.ToLowerInvariant()
    }
    catch {
        return 'GIT_METADATA_UNAVAILABLE'
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Get-GitDiffHash {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $diffLines = @(
            & git -C $script:RepositoryRoot diff --binary --no-ext-diff -- . 2>$null |
                ForEach-Object { [string]$_ }
        )
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            return $null
        }
        $untrackedPaths = @(
            & git -C $script:RepositoryRoot ls-files --others --exclude-standard -- 2>$null |
                ForEach-Object { Get-NormalizedRelativePath ([string]$_) } |
                Where-Object { Test-ReadAllowedRelativePath $_ } |
                Sort-Object
        )
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        $canonical = New-Object System.Collections.Generic.List[string]
        [void]$canonical.Add('TRACKED_DIFF')
        foreach ($line in $diffLines) {
            [void]$canonical.Add($line)
        }
        [void]$canonical.Add('UNTRACKED_FILES')
        foreach ($relative in $untrackedPaths) {
            $full = Get-FullPathFromRelative $relative
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                [void]$canonical.Add(($relative + '|' + (Get-FileSha256 $full)))
            }
            else {
                [void]$canonical.Add(($relative + '|MISSING'))
            }
        }
        return (Get-Sha256Text ([string]::Join([Environment]::NewLine, $canonical)))
    }
    catch {
        return $null
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Get-EnvValue {
    param(
        [string]$Name,
        [string]$Path
    )
    if (-not [string]::IsNullOrWhiteSpace($Path)) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw 'ENV_FILE_MISSING'
        }
        $lines = [System.IO.File]::ReadAllLines($Path)
        foreach ($line in $lines) {
            $trimmed = $line.Trim()
            if ($trimmed.StartsWith('#') -or $trimmed.Length -eq 0) {
                continue
            }
            $index = $trimmed.IndexOf('=')
            if ($index -le 0) {
                continue
            }
            $key = $trimmed.Substring(0, $index).Trim()
            if ($key -ne $Name) {
                continue
            }
            $value = $trimmed.Substring($index + 1).Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith('''') -and $value.EndsWith(''''))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    $environmentValue = [System.Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($environmentValue)) {
        return $null
    }
    return $environmentValue
}

function Test-PathMatchesInjectionSuffix {
    param(
        [string]$Path,
        [string]$Injected
    )
    if ([string]::IsNullOrWhiteSpace($Injected)) {
        return $false
    }
    $normInjected = ([string]$Injected).Replace('/', '\').Trim().TrimStart('\')
    $normPath = ([string]$Path).Replace('/', '\')
    return (
        $normPath.Equals($normInjected, [System.StringComparison]::OrdinalIgnoreCase) -or
        $normPath.EndsWith('\' + $normInjected, [System.StringComparison]::OrdinalIgnoreCase)
    )
}

function Get-Sha256Bytes {
    param([byte[]]$Bytes)
    if ($null -eq $Bytes) {
        $Bytes = [byte[]]@()
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Bytes)
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-MissingAncestorDirectories {
    param(
        [string]$FileFullPath,
        [string]$RepositoryRoot
    )
    $missing = New-Object System.Collections.Generic.List[string]
    $rootFull = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
    $dir = Split-Path -Parent $FileFullPath
    while (
        -not [string]::IsNullOrWhiteSpace($dir) -and
        $dir.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not (Test-Path -LiteralPath $dir)
    ) {
        [void]$missing.Insert(0, $dir)
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) {
            break
        }
        $dir = $parent
    }
    return @($missing.ToArray())
}

function Remove-EmptyTrackedDirectories {
    param([object[]]$DirectoriesDeepestFirst)
    foreach ($dir in $DirectoriesDeepestFirst) {
        if ([string]::IsNullOrWhiteSpace([string]$dir)) {
            continue
        }
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
            continue
        }
        $remaining = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
        if ($remaining.Count -eq 0) {
            Remove-Item -LiteralPath $dir -Force -ErrorAction Stop
        }
    }
}

function Write-AtomicBytes {
    param(
        [string]$Path,
        [byte[]]$Bytes,
        [string]$InjectionEnvName = 'DEEPSEEK_RUNNER_TEST_FAIL_WRITE'
    )
    if ($null -eq $Bytes) {
        $Bytes = [byte[]]@()
    }
    # TestMode-only fault injection for multi-file write/rollback contracts.
    if ($TestMode -and -not [string]::IsNullOrWhiteSpace($InjectionEnvName)) {
        $injected = [System.Environment]::GetEnvironmentVariable($InjectionEnvName)
        if (Test-PathMatchesInjectionSuffix -Path $Path -Injected $injected) {
            if ($InjectionEnvName -eq 'DEEPSEEK_RUNNER_TEST_FAIL_ROLLBACK') {
                throw 'TEST_INJECTED_ROLLBACK_FAILURE'
            }
            throw 'TEST_INJECTED_WRITE_FAILURE'
        }
    }
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    $temp = Join-Path $directory ('.runner-write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllBytes($temp, $Bytes)
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try {
                [System.IO.File]::Replace($temp, $Path, $null, $true)
            }
            catch {
                Move-Item -LiteralPath $temp -Destination $Path -Force
            }
        }
        else {
            Move-Item -LiteralPath $temp -Destination $Path
        }
    }
    finally {
        if (Test-Path -LiteralPath $temp) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-AtomicText {
    param(
        [string]$Path,
        [string]$Text
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    if ($null -eq $Text) {
        $Text = ''
    }
    $bytes = $encoding.GetBytes($Text)
    Write-AtomicBytes -Path $Path -Bytes $bytes -InjectionEnvName 'DEEPSEEK_RUNNER_TEST_FAIL_WRITE'
}

function Get-ToolArgument {
    param(
        [AllowNull()][object]$Arguments,
        [string]$Name
    )
    if ($null -eq $Arguments) {
        return $null
    }
    $property = $Arguments.PSObject.Properties | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function New-ToolSuccess {
    param([AllowNull()][object]$Value)
    return [pscustomobject]@{
        ok = $true
        result = $Value
        error_code = $null
        error_detail = $null
        changed = $false
    }
}

function New-ToolFailure {
    param(
        [string]$Code,
        [string]$Detail = ''
    )
    return [pscustomobject]@{
        ok = $false
        result = $null
        error_code = $Code
        error_detail = (Redact-Text $Detail)
        changed = $false
    }
}

function New-PathAwareToolFailure {
    param(
        [string]$FallbackCode,
        [System.Management.Automation.ErrorRecord]$ErrorRecord
    )
    $message = [string]$ErrorRecord.Exception.Message
    if ($message -in @(
        'PATH_OUTSIDE_REPOSITORY',
        'PATH_EXISTING_PARENT_NOT_FOUND',
        'PATH_REPARSE_POINT_FORBIDDEN'
    )) {
        return (New-ToolFailure $message)
    }
    return (New-ToolFailure $FallbackCode $message)
}

function Invoke-WorkspaceStatusTool {
    $snapshot = Get-WorkspaceSnapshot
    return (New-ToolSuccess ([ordered]@{
        ok = $true
        head = (Get-GitHead)
        git_metadata = if ((Get-GitHead) -eq 'GIT_METADATA_UNAVAILABLE') { 'GIT_METADATA_UNAVAILABLE' } else { 'AVAILABLE' }
        fingerprint = $snapshot.fingerprint
        read_paths = @($script:ReadPathDisplay)
        write_paths = @($script:WritePathDisplay)
    }))
}

function Invoke-ReadFileTool {
    param([object]$Arguments)
    $script:ReadCallCount++
    if ($script:ReadCallCount -gt $MaxReadToolCalls) {
        return (New-ToolFailure 'READ_BUDGET_EXHAUSTED')
    }
    $relative = [string](Get-ToolArgument $Arguments 'path')
    if ([string]::IsNullOrWhiteSpace($relative)) {
        return (New-ToolFailure 'PATH_REQUIRED')
    }
    $relative = Get-NormalizedRelativePath $relative
    if (-not (Test-ReadAllowedRelativePath $relative)) {
        return (New-ToolFailure 'PATH_NOT_READ_ALLOWLISTED')
    }
    try {
        $full = Get-FullPathFromRelative $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            $script:FreshReadTokens[$relative] = 'MISSING'
            return (New-ToolSuccess ([ordered]@{
                path = $relative
                exists = $false
                bytes = 0
                content = ''
            }))
        }
        $item = Get-Item -LiteralPath $full
        if ($item.Length -gt 1048576) {
            return (New-ToolFailure 'FILE_TOO_LARGE')
        }
        $content = [System.IO.File]::ReadAllText($full)
        $script:FreshReadTokens[$relative] = Get-FileSha256 $full
        return (New-ToolSuccess ([ordered]@{
            path = $relative
            exists = $true
            bytes = $item.Length
            content = (Redact-Text $content)
        }))
    }
    catch {
        return (New-PathAwareToolFailure 'READ_FAILED' $_)
    }
}

function Invoke-SearchTextTool {
    param([object]$Arguments)
    $script:ReadCallCount++
    if ($script:ReadCallCount -gt $MaxReadToolCalls) {
        return (New-ToolFailure 'READ_BUDGET_EXHAUSTED')
    }
    $pattern = [string](Get-ToolArgument $Arguments 'pattern')
    if ([string]::IsNullOrWhiteSpace($pattern)) {
        return (New-ToolFailure 'PATTERN_REQUIRED')
    }
    if ($pattern.Length -gt 512) {
        return (New-ToolFailure 'PATTERN_TOO_LONG')
    }
    $matches = New-Object System.Collections.Generic.List[object]
    try {
        foreach ($file in (Get-ReadableFiles)) {
            if ($matches.Count -ge 100) {
                break
            }
            try {
                $lines = [System.IO.File]::ReadAllLines($file.full)
            }
            catch {
                continue
            }
            for ($index = 0; $index -lt $lines.Count; $index++) {
                if ($lines[$index].IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    [void]$matches.Add([ordered]@{
                        path = $file.relative
                        line = ($index + 1)
                        text = (Redact-Text $lines[$index])
                    })
                }
                if ($matches.Count -ge 100) {
                    break
                }
            }
        }
        return (New-ToolSuccess ([ordered]@{
            pattern = (Redact-Text $pattern)
            matches = @($matches.ToArray())
            truncated = ($matches.Count -ge 100)
        }))
    }
    catch {
        return (New-PathAwareToolFailure 'SEARCH_FAILED' $_)
    }
}

function Test-ExpectedFingerprint {
    $current = (Get-WorkspaceSnapshot).fingerprint
    return ($current -eq $script:ExpectedFingerprint)
}

function Invoke-ReplaceTextTool {
    param([object]$Arguments)
    $relative = [string](Get-ToolArgument $Arguments 'path')
    $oldText = [string](Get-ToolArgument $Arguments 'old_text')
    $newText = [string](Get-ToolArgument $Arguments 'new_text')
    if ([string]::IsNullOrWhiteSpace($relative)) {
        return (New-ToolFailure 'PATH_REQUIRED')
    }
    if ([string]::IsNullOrEmpty($oldText)) {
        return (New-ToolFailure 'OLD_TEXT_REQUIRED')
    }
    # Path policy before no-effect: out-of-scope paths must not bypass allowlist via A==A.
    $relative = Get-NormalizedRelativePath $relative
    if (-not (Test-WriteAllowedRelativePath $relative)) {
        return (New-ToolFailure 'PATH_NOT_WRITE_ALLOWLISTED')
    }
    if ($oldText -eq $newText) {
        return (New-ToolFailure 'NO_EFFECTIVE_CHANGE' 'replace_text old_text equals new_text')
    }
    if (-not (Test-ExpectedFingerprint)) {
        return (New-ToolFailure 'WORKSPACE_FINGERPRINT_MISMATCH')
    }
    # Fresh-current-byte write gate
    if ($null -ne $script:PriorFreshTokens) {
        if (-not $script:PriorFreshTokens.ContainsKey($relative)) {
            return (New-ToolFailure 'WRITE_REQUIRES_FRESH_READ' "File '$relative' must be read with read_file in a prior turn before writing.")
        }
        $expectedToken = $script:PriorFreshTokens[$relative]
        if ($expectedToken -eq 'MISSING') {
            return (New-ToolFailure 'WRITE_REQUIRES_FRESH_READ' "File '$relative' was confirmed missing; it must exist for replace_text. Use read_file to refresh.")
        }
    }
    try {
        $full = Get-FullPathFromRelative $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            return (New-ToolFailure 'FILE_NOT_FOUND')
        }
        # Verify freshness token matches current content
        if ($null -ne $script:PriorFreshTokens -and $script:PriorFreshTokens.ContainsKey($relative)) {
            $currentHash = Get-FileSha256 $full
            if ($currentHash -ne $script:PriorFreshTokens[$relative]) {
                return (New-ToolFailure 'WRITE_REQUIRES_FRESH_READ' "File '$relative' has changed since last read. Use read_file to refresh before writing.")
            }
        }
        $originalBytes = [System.IO.File]::ReadAllBytes($full)
        $fileEncoding = Resolve-TextFileEncoding -Bytes $originalBytes
        $current = Get-StringFromFileBytes -Bytes $originalBytes -Encoding $fileEncoding
        $first = $current.IndexOf($oldText, [System.StringComparison]::Ordinal)
        if ($first -lt 0) {
            return (New-ToolFailure 'OLD_TEXT_NOT_FOUND')
        }
        $second = $current.IndexOf($oldText, $first + $oldText.Length, [System.StringComparison]::Ordinal)
        if ($second -ge 0) {
            return (New-ToolFailure 'OLD_TEXT_NOT_UNIQUE')
        }
        $updated = $current.Substring(0, $first) + $newText + $current.Substring($first + $oldText.Length)
        $updatedBytes = Get-FileBytesFromString -Text $updated -Encoding $fileEncoding
        if ((Test-ByteArraysEqual -Left $updatedBytes -Right $originalBytes) -or ($updated -eq $current)) {
            return (New-ToolFailure 'NO_EFFECTIVE_CHANGE' 'materialized replace_text postimage equals current bytes')
        }
        if ($DryRun) {
            return (New-ToolSuccess ([ordered]@{
                path = $relative
                dry_run = $true
                changed = $false
            }))
        }
        Write-AtomicBytes -Path $full -Bytes $updatedBytes -InjectionEnvName 'DEEPSEEK_RUNNER_TEST_FAIL_WRITE'
        $script:EditCount++
        $script:ChangedPaths[$relative] = $true
        $script:FreshReadTokens.Remove($relative)
        # One post-write workspace snapshot for the successful mutation batch.
        $snapshot = Get-WorkspaceSnapshot
        $script:ExpectedFingerprint = $snapshot.fingerprint
        $hash = if ($snapshot.file_hashes.Contains($relative)) {
            [string]$snapshot.file_hashes[$relative]
        }
        else {
            Get-FileSha256 $full
        }
        $script:ChangedFileHashes[$relative] = $hash
        return [pscustomobject]@{
            ok = $true
            result = [ordered]@{
                path = $relative
                dry_run = $false
                changed = $true
                sha256 = $hash
            }
            error_code = $null
            error_detail = $null
            changed = $true
        }
    }
    catch {
        return (New-PathAwareToolFailure 'WRITE_FAILED' $_)
    }
}

function Apply-UnifiedPatch {
    param(
        [string]$PatchText,
        [bool]$DryRunOnly
    )
    if ([string]::IsNullOrWhiteSpace($PatchText)) {
        return (New-ToolFailure 'PATCH_REQUIRED')
    }
    $lines = @($PatchText -split "\r?\n")
    if ($lines.Count -lt 3 -or $lines[0] -ne '*** Begin Patch' -or $lines[$lines.Count - 1] -ne '*** End Patch') {
        return (New-ToolFailure 'PATCH_FORMAT_INVALID')
    }
    # Collect every file marker. Multi-file batches are allowed: all plans are
    # fully prevalidated (path, preimage/hash, parse, postimage) before any durable write.
    $markers = New-Object System.Collections.Generic.List[object]
    for ($i = 1; $i -lt ($lines.Count - 1); $i++) {
        if ($lines[$i].StartsWith('*** Update File: ')) {
            [void]$markers.Add([pscustomobject]@{ index = $i; kind = 'Update'; raw = $lines[$i] })
        }
        elseif ($lines[$i].StartsWith('*** Add File: ')) {
            [void]$markers.Add([pscustomobject]@{ index = $i; kind = 'Add'; raw = $lines[$i] })
        }
    }
    if ($markers.Count -eq 0) {
        return (New-ToolFailure 'PATCH_SINGLE_FILE_ONLY' 'update_markers=0 add_markers=0')
    }
    if (-not (Test-ExpectedFingerprint)) {
        return (New-ToolFailure 'WORKSPACE_FINGERPRINT_MISMATCH')
    }
    try {
        $plans = New-Object System.Collections.Generic.List[object]
        $seenPaths = @{}
        $crlf = ([string][char]13) + ([string][char]10)
        for ($m = 0; $m -lt $markers.Count; $m++) {
            $marker = $markers[$m]
            $bodyStart = $marker.index + 1
            $bodyEnd = if ($m -lt ($markers.Count - 1)) { $markers[$m + 1].index } else { ($lines.Count - 1) }
            $relative = Get-NormalizedRelativePath ($marker.raw.Substring($marker.raw.IndexOf(':') + 1).Trim())
            if (-not (Test-WriteAllowedRelativePath $relative)) {
                return (New-ToolFailure 'PATH_NOT_WRITE_ALLOWLISTED')
            }
            if ($seenPaths.ContainsKey($relative)) {
                return (New-ToolFailure 'PATCH_DUPLICATE_PATH' $relative)
            }
            $seenPaths[$relative] = $true
            $full = Get-FullPathFromRelative $relative
            if ($marker.kind -eq 'Add') {
                $addLines = New-Object System.Collections.Generic.List[string]
                for ($j = $bodyStart; $j -lt $bodyEnd; $j++) {
                    $addLine = $lines[$j]
                    if ($addLine.StartsWith('***')) {
                        return (New-ToolFailure 'PATCH_ADD_MARKER_INVALID')
                    }
                    if (-not $addLine.StartsWith('+')) {
                        return (New-ToolFailure 'PATCH_ADD_LINE_PREFIX_REQUIRED')
                    }
                    # Strip exactly the patch prefix. A literal leading plus is encoded as "++".
                    [void]$addLines.Add($addLine.Substring(1))
                }
                if ($null -ne $script:PriorFreshTokens) {
                    if (-not $script:PriorFreshTokens.ContainsKey($relative) -or $script:PriorFreshTokens[$relative] -ne 'MISSING') {
                        return (New-ToolFailure 'WRITE_REQUIRES_FRESH_READ' "File '$relative' must be confirmed missing via read_file in a prior turn before Add File.")
                    }
                }
                if (Test-Path -LiteralPath $full) {
                    return (New-ToolFailure 'PATCH_TARGET_EXISTS')
                }
                $newText = [string]::Join([Environment]::NewLine, @($addLines))
                $addEncoding = New-Object System.Text.UTF8Encoding($false)
                $candidateBytes = Get-FileBytesFromString -Text $newText -Encoding $addEncoding
                $createdDirs = @(Get-MissingAncestorDirectories -FileFullPath $full -RepositoryRoot $script:RepositoryRoot)
                [void]$plans.Add([pscustomobject]@{
                    relative = $relative
                    full = $full
                    kind = 'Add'
                    existed = $false
                    originalBytes = $null
                    originalSha256 = $null
                    createdDirs = $createdDirs
                    newText = $newText
                    candidateBytes = $candidateBytes
                })
                continue
            }
            # Update File path
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                return (New-ToolFailure 'FILE_NOT_FOUND')
            }
            $originalBytes = [System.IO.File]::ReadAllBytes($full)
            $originalSha256 = Get-Sha256Bytes $originalBytes
            $fileEncoding = Resolve-TextFileEncoding -Bytes $originalBytes
            $currentText = Get-StringFromFileBytes -Bytes $originalBytes -Encoding $fileEncoding
            $normalized = $currentText.Replace($crlf, ([string][char]10)).Replace([char]13, [char]10)
            # Preserve pre-hunk normalized text so context-only / mixed-EOL no-ops are detected
            # before line-ending rematerialization can rewrite unrelated bytes.
            $normalizedBefore = $normalized
            $hunks = New-Object System.Collections.Generic.List[object]
            $oldLines = New-Object System.Collections.Generic.List[string]
            $newLines = New-Object System.Collections.Generic.List[string]
            $flush = {
                if ($oldLines.Count -gt 0) {
                    [void]$hunks.Add([pscustomobject]@{
                        old = [string]::Join([char]10, @($oldLines))
                        new = [string]::Join([char]10, @($newLines))
                    })
                }
                $oldLines.Clear()
                $newLines.Clear()
            }
            for ($j = $bodyStart; $j -lt $bodyEnd; $j++) {
                $line = $lines[$j]
                if ($line.StartsWith('@@')) {
                    & $flush
                    continue
                }
                if ($line.StartsWith('***')) {
                    return (New-ToolFailure 'PATCH_UPDATE_MARKER_INVALID')
                }
                if ($line.StartsWith(' ')) {
                    [void]$oldLines.Add($line.Substring(1))
                    [void]$newLines.Add($line.Substring(1))
                }
                elseif ($line.StartsWith('-')) {
                    [void]$oldLines.Add($line.Substring(1))
                }
                elseif ($line.StartsWith('+')) {
                    [void]$newLines.Add($line.Substring(1))
                }
                else {
                    $category = if ([string]::IsNullOrEmpty($line)) { 'empty' } else { 'prefix=' + $line[0] }
                    return (New-ToolFailure 'PATCH_HUNK_LINE_INVALID' "line=$($j+1) $category")
                }
            }
            & $flush
            if ($hunks.Count -eq 0) {
                return (New-ToolFailure 'PATCH_HUNK_MISSING')
            }
            # Fresh-current-byte / preimage gate after parse, before postimage materialization.
            if ($null -ne $script:PriorFreshTokens) {
                if (-not $script:PriorFreshTokens.ContainsKey($relative)) {
                    return (New-ToolFailure 'WRITE_REQUIRES_FRESH_READ' "File '$relative' must be read with read_file in a prior turn before writing.")
                }
                if ($script:PriorFreshTokens[$relative] -eq 'MISSING') {
                    return (New-ToolFailure 'WRITE_REQUIRES_FRESH_READ' "File '$relative' was confirmed missing; it must exist for Update File. Use read_file to refresh.")
                }
                if ($originalSha256 -ne $script:PriorFreshTokens[$relative]) {
                    return (New-ToolFailure 'WRITE_REQUIRES_FRESH_READ' "File '$relative' has changed since last read. Use read_file to refresh before writing.")
                }
            }
            foreach ($hunk in $hunks) {
                $first = $normalized.IndexOf($hunk.old, [System.StringComparison]::Ordinal)
                if ($first -lt 0) {
                    return (New-ToolFailure 'PATCH_CONTEXT_NOT_FOUND')
                }
                $second = $normalized.IndexOf($hunk.old, $first + $hunk.old.Length, [System.StringComparison]::Ordinal)
                if ($second -ge 0) {
                    return (New-ToolFailure 'PATCH_CONTEXT_NOT_UNIQUE')
                }
                $normalized = $normalized.Substring(0, $first) + $hunk.new + $normalized.Substring($first + $hunk.old.Length)
            }
            if ($normalized -eq $normalizedBefore) {
                # Semantic no-op (including context-only): keep original bytes; do not rematerialize EOLs.
                $updated = $currentText
                $candidateBytes = $originalBytes
            }
            else {
                $updated = if ($currentText.Contains($crlf)) { $normalized.Replace(([string][char]10), $crlf) } else { $normalized }
                $candidateBytes = Get-FileBytesFromString -Text $updated -Encoding $fileEncoding
            }
            [void]$plans.Add([pscustomobject]@{
                relative = $relative
                full = $full
                kind = 'Update'
                existed = $true
                originalBytes = $originalBytes
                originalSha256 = $originalSha256
                createdDirs = @()
                newText = $updated
                candidateBytes = $candidateBytes
            })
        }

        # No-effect gate: reject whole batch if any plan is context-only or same postimage
        # (encoding-aware candidate bytes, so BOM/UTF-16 context-only is NO_EFFECTIVE_CHANGE).
        foreach ($plan in $plans) {
            if ($plan.kind -eq 'Update') {
                if (Test-ByteArraysEqual -Left $plan.candidateBytes -Right $plan.originalBytes) {
                    return (New-ToolFailure 'NO_EFFECTIVE_CHANGE' ("apply_patch no-effect plan path=" + $plan.relative))
                }
            }
        }

        if ($DryRunOnly) {
            $dryPaths = @($plans | ForEach-Object { $_.relative })
            $dryResult = [ordered]@{
                path = $dryPaths[0]
                paths = $dryPaths
                changed = $false
                dry_run = $true
                batch_size = $plans.Count
            }
            return [pscustomobject]@{
                ok = $true
                result = $dryResult
                error_code = $null
                error_detail = $null
                changed = $false
            }
        }

        # Close TOCTOU: re-validate workspace fingerprint and every plan preimage immediately before first durable write.
        if (-not (Test-ExpectedFingerprint)) {
            return (New-ToolFailure 'WORKSPACE_FINGERPRINT_MISMATCH')
        }
        foreach ($plan in $plans) {
            if ($plan.kind -eq 'Add') {
                if (Test-Path -LiteralPath $plan.full) {
                    return (New-ToolFailure 'PATCH_TARGET_EXISTS' $plan.relative)
                }
            }
            else {
                if (-not (Test-Path -LiteralPath $plan.full -PathType Leaf)) {
                    return (New-ToolFailure 'FILE_NOT_FOUND' $plan.relative)
                }
                $liveHash = Get-FileSha256 $plan.full
                if ($liveHash -ne $plan.originalSha256) {
                    return (New-ToolFailure 'WRITE_REQUIRES_FRESH_READ' "File '$($plan.relative)' has changed since plan validation. Use read_file to refresh before writing.")
                }
            }
        }

        # Durable write phase: only after every plan revalidated.
        # Mutation contract: rollback-backed exception-atomic under exclusive workspace ownership;
        # not crash/power-loss atomic. Track each plan before its first side effect so a failing
        # Add/write is still rolled back.
        $applied = New-Object System.Collections.Generic.List[object]
        try {
            foreach ($plan in $plans) {
                if ($plan.kind -eq 'Add') {
                    # Snapshot missing ancestors before any create so rollback can prune only batch-created dirs.
                    $plan.createdDirs = @(Get-MissingAncestorDirectories -FileFullPath $plan.full -RepositoryRoot $script:RepositoryRoot)
                }
                else {
                    $plan.createdDirs = @()
                }
                [void]$applied.Add($plan)
                if ($plan.kind -eq 'Add') {
                    foreach ($dir in @($plan.createdDirs)) {
                        if (-not (Test-Path -LiteralPath $dir)) {
                            [System.IO.Directory]::CreateDirectory($dir) | Out-Null
                        }
                    }
                }
                Write-AtomicBytes -Path $plan.full -Bytes $plan.candidateBytes -InjectionEnvName 'DEEPSEEK_RUNNER_TEST_FAIL_WRITE'
            }
        }
        catch {
            $writeError = $_
            # Disable write injection during rollback; rollback has its own injection env.
            $savedWriteInject = $null
            if ($TestMode) {
                $savedWriteInject = [System.Environment]::GetEnvironmentVariable('DEEPSEEK_RUNNER_TEST_FAIL_WRITE')
                [System.Environment]::SetEnvironmentVariable('DEEPSEEK_RUNNER_TEST_FAIL_WRITE', $null)
            }
            $rollbackFailures = New-Object System.Collections.Generic.List[string]
            try {
                for ($r = $applied.Count - 1; $r -ge 0; $r--) {
                    $rolled = $applied[$r]
                    try {
                        if ($rolled.existed) {
                            Write-AtomicBytes -Path $rolled.full -Bytes $rolled.originalBytes -InjectionEnvName 'DEEPSEEK_RUNNER_TEST_FAIL_ROLLBACK'
                            $restoredHash = Get-FileSha256 $rolled.full
                            if ($restoredHash -ne $rolled.originalSha256) {
                                throw ('ROLLBACK_HASH_MISMATCH:' + $rolled.relative)
                            }
                        }
                        else {
                            if ($TestMode) {
                                $rbInject = [System.Environment]::GetEnvironmentVariable('DEEPSEEK_RUNNER_TEST_FAIL_ROLLBACK')
                                if (Test-PathMatchesInjectionSuffix -Path $rolled.full -Injected $rbInject) {
                                    throw 'TEST_INJECTED_ROLLBACK_FAILURE'
                                }
                            }
                            if (Test-Path -LiteralPath $rolled.full -PathType Leaf) {
                                Remove-Item -LiteralPath $rolled.full -Force -ErrorAction Stop
                            }
                            $deepestFirst = @($rolled.createdDirs)
                            if ($deepestFirst.Count -gt 0) {
                                [Array]::Reverse($deepestFirst)
                                Remove-EmptyTrackedDirectories -DirectoriesDeepestFirst $deepestFirst
                            }
                        }
                    }
                    catch {
                        $detail = [string]$_.Exception.Message
                        if ([string]::IsNullOrWhiteSpace($detail)) {
                            $detail = [string]$_
                        }
                        [void]$rollbackFailures.Add(($rolled.relative + ':' + $detail))
                    }
                }
            }
            finally {
                if ($TestMode) {
                    [System.Environment]::SetEnvironmentVariable('DEEPSEEK_RUNNER_TEST_FAIL_WRITE', $savedWriteInject)
                }
            }

            # Divergence is measured from actual filesystem vs plan preimage, not from rollback bookkeeping.
            $divergentPaths = New-Object System.Collections.Generic.List[string]
            $divergentMarkers = New-Object System.Collections.Generic.List[string]
            foreach ($appliedPlan in $applied) {
                $isDivergent = $false
                $marker = $null
                if ($appliedPlan.existed) {
                    if (-not (Test-Path -LiteralPath $appliedPlan.full -PathType Leaf)) {
                        $isDivergent = $true
                        $marker = 'MISSING'
                    }
                    else {
                        $liveHash = Get-FileSha256 $appliedPlan.full
                        if ($liveHash -ne $appliedPlan.originalSha256) {
                            $isDivergent = $true
                            $marker = $liveHash
                        }
                    }
                }
                else {
                    $fileStillExists = (Test-Path -LiteralPath $appliedPlan.full -PathType Leaf)
                    $residueDirs = @()
                    foreach ($dir in @($appliedPlan.createdDirs)) {
                        if (-not [string]::IsNullOrWhiteSpace([string]$dir) -and (Test-Path -LiteralPath $dir)) {
                            $residueDirs += [string]$dir
                        }
                    }
                    if ($fileStillExists -or $residueDirs.Count -gt 0) {
                        $isDivergent = $true
                        if ($fileStillExists) {
                            $marker = Get-FileSha256 $appliedPlan.full
                        }
                        else {
                            $marker = 'DIRECTORY_RESIDUE'
                        }
                    }
                }
                if ($isDivergent) {
                    [void]$divergentPaths.Add($appliedPlan.relative)
                    [void]$divergentMarkers.Add(([string]$appliedPlan.relative + '=' + [string]$marker))
                    $script:EditCount++
                    $script:PatchCount++
                    $script:ChangedPaths[$appliedPlan.relative] = $true
                    $script:ChangedFileHashes[$appliedPlan.relative] = $marker
                    $script:FreshReadTokens.Remove($appliedPlan.relative)
                }
            }
            if ($divergentPaths.Count -gt 0) {
                $snapshot = Get-WorkspaceSnapshot
                $script:ExpectedFingerprint = $snapshot.fingerprint
                $rbDetail = 'write_error=' + (Redact-Text ([string]$writeError.Exception.Message)) + '; rollback_failures=' + ([string]::Join('|', @($rollbackFailures))) + '; divergent=' + ([string]::Join(',', @($divergentMarkers)))
                return [pscustomobject]@{
                    ok = $false
                    result = [ordered]@{
                        divergent_paths = @($divergentPaths.ToArray())
                        rollback_failures = @($rollbackFailures.ToArray())
                    }
                    error_code = 'PATCH_BATCH_ROLLBACK_FAILED'
                    error_detail = $rbDetail
                    changed = $true
                }
            }
            return (New-PathAwareToolFailure 'PATCH_BATCH_WRITE_FAILED' $writeError)
        }

        # One final workspace snapshot after all successful writes in the batch.
        foreach ($plan in $plans) {
            $script:EditCount++
            $script:PatchCount++
            $script:ChangedPaths[$plan.relative] = $true
            $script:FreshReadTokens.Remove($plan.relative)
        }
        $snapshot = Get-WorkspaceSnapshot
        $script:ExpectedFingerprint = $snapshot.fingerprint
        $fileResults = New-Object System.Collections.Generic.List[object]
        foreach ($plan in $plans) {
            $hash = if ($snapshot.file_hashes.Contains($plan.relative)) {
                [string]$snapshot.file_hashes[$plan.relative]
            }
            else {
                Get-FileSha256 $plan.full
            }
            $script:ChangedFileHashes[$plan.relative] = $hash
            [void]$fileResults.Add([ordered]@{
                path = $plan.relative
                changed = $true
                sha256 = $hash
            })
        }
        $paths = @($plans | ForEach-Object { $_.relative })
        $result = [ordered]@{
            path = $paths[0]
            paths = $paths
            changed = $true
            dry_run = $false
            batch_size = $plans.Count
            files = @($fileResults.ToArray())
        }
        if ($plans.Count -eq 1) {
            $result.sha256 = $script:ChangedFileHashes[$paths[0]]
        }
        return [pscustomobject]@{
            ok = $true
            result = $result
            error_code = $null
            error_detail = $null
            changed = $true
        }
    }
    catch {
        return (New-PathAwareToolFailure 'PATCH_FAILED' $_)
    }
}

function Invoke-ApplyPatchTool {
    param([object]$Arguments)
    $patch = [string](Get-ToolArgument $Arguments 'patch')
    return (Apply-UnifiedPatch -PatchText $patch -DryRunOnly ([bool]$DryRun))
}

function Invoke-WorkspaceTool {
    param(
        [string]$Name,
        [object]$Arguments
    )
    switch ($Name) {
        'workspace_status' {
            return (Invoke-WorkspaceStatusTool)
        }
        'read_file' {
            return (Invoke-ReadFileTool $Arguments)
        }
        'search_text' {
            return (Invoke-SearchTextTool $Arguments)
        }
        'replace_text' {
            if ($Mode -ne 'Writer') {
                return (New-ToolFailure 'WRITER_TOOL_NOT_ALLOWED')
            }
            if ($script:EffectiveWriteStrategy -ne 'ReplaceText') {
                return (New-ToolFailure 'WRITER_TOOL_NOT_ALLOWED' 'replace_text is not the selected write tool for this run.')
            }
            return (Invoke-ReplaceTextTool $Arguments)
        }
        'apply_patch' {
            if ($Mode -ne 'Writer') {
                return (New-ToolFailure 'WRITER_TOOL_NOT_ALLOWED')
            }
            if ($script:EffectiveWriteStrategy -ne 'ApplyPatch') {
                return (New-ToolFailure 'WRITER_TOOL_NOT_ALLOWED' 'apply_patch is not the selected write tool for this run.')
            }
            return (Invoke-ApplyPatchTool $Arguments)
        }
        default {
            return (New-ToolFailure 'TOOL_NOT_ALLOWED' $Name)
        }
    }
}

function Get-ToolDefinitions {
    if ($DirectResponse) {
        $script:LastExposedToolNames = @()
        return @()
    }
    $definitions = New-Object System.Collections.Generic.List[object]
    $exposedNames = New-Object System.Collections.Generic.List[string]
    # In write-only mode, expose only the selected write tool
    if ($script:ConvergenceMode -eq 'write-only') {
        if ($Mode -eq 'Writer') {
            if ($script:EffectiveWriteStrategy -eq 'ReplaceText') {
                [void]$definitions.Add([ordered]@{
                    type = 'function'
                    function = [ordered]@{
                        name = 'replace_text'
                        description = 'Replace exactly one occurrence in one file from the write allowlist.'
                        parameters = [ordered]@{
                            type = 'object'
                            properties = [ordered]@{
                                path = [ordered]@{ type = 'string' }
                                old_text = [ordered]@{ type = 'string' }
                                new_text = [ordered]@{ type = 'string' }
                            }
                            required = @('path', 'old_text', 'new_text')
                            additionalProperties = $false
                        }
                    }
                })
                [void]$exposedNames.Add('replace_text')
            }
            elseif ($script:EffectiveWriteStrategy -eq 'ApplyPatch') {
                [void]$definitions.Add([ordered]@{
                    type = 'function'
                    function = [ordered]@{
                        name = 'apply_patch'
                        description = 'Apply one or more files from the write allowlist in one batch using Codex patch format: *** Begin Patch, then one or more *** Update File: path or *** Add File: path sections, patch lines, and *** End Patch. Every file is validated (path, preimage/hash, parse, postimage) before any durable write; mutation is rollback-backed exception-atomic under exclusive workspace ownership; not crash/power-loss atomic. Every Add File content line requires one + patch prefix; encode a literal leading plus as ++. Never send diff --git format.'
                        parameters = [ordered]@{
                            type = 'object'
                            properties = [ordered]@{ patch = [ordered]@{ type = 'string' } }
                            required = @('patch')
                            additionalProperties = $false
                        }
                    }
                })
                [void]$exposedNames.Add('apply_patch')
            }
        }
        $script:LastExposedToolNames = @($exposedNames.ToArray())
        return @($definitions.ToArray())
    }
    # Normal mode: expose read_file
    [void]$definitions.Add([ordered]@{
        type = 'function'
        function = [ordered]@{
            name = 'read_file'
            description = 'Read one relative text file from the read allowlist.'
            parameters = [ordered]@{
                type = 'object'
                properties = [ordered]@{ path = [ordered]@{ type = 'string' } }
                required = @('path')
                additionalProperties = $false
            }
        }
    })
    [void]$exposedNames.Add('read_file')
    # In forced-write mode, omit search_text
    if ($script:ConvergenceMode -ne 'forced-write') {
        [void]$definitions.Add([ordered]@{
            type = 'function'
            function = [ordered]@{
                name = 'search_text'
                description = 'Search literal text in files from the read allowlist.'
                parameters = [ordered]@{
                    type = 'object'
                    properties = [ordered]@{ pattern = [ordered]@{ type = 'string' } }
                    required = @('pattern')
                    additionalProperties = $false
                }
            }
        })
        [void]$exposedNames.Add('search_text')
    }
    if ($Mode -eq 'Writer') {
        if ($script:EffectiveWriteStrategy -eq 'ReplaceText') {
            [void]$definitions.Add([ordered]@{
                type = 'function'
                function = [ordered]@{
                    name = 'replace_text'
                    description = 'Replace exactly one occurrence in one file from the write allowlist.'
                    parameters = [ordered]@{
                        type = 'object'
                        properties = [ordered]@{
                            path = [ordered]@{ type = 'string' }
                            old_text = [ordered]@{ type = 'string' }
                            new_text = [ordered]@{ type = 'string' }
                        }
                        required = @('path', 'old_text', 'new_text')
                        additionalProperties = $false
                    }
                }
            })
            [void]$exposedNames.Add('replace_text')
        }
        elseif ($script:EffectiveWriteStrategy -eq 'ApplyPatch') {
            [void]$definitions.Add([ordered]@{
                type = 'function'
                function = [ordered]@{
                    name = 'apply_patch'
                    description = 'Apply one or more files from the write allowlist in one batch using Codex patch format: *** Begin Patch, then one or more *** Update File: path or *** Add File: path sections, patch lines, and *** End Patch. Every file is validated (path, preimage/hash, parse, postimage) before any durable write; mutation is rollback-backed exception-atomic under exclusive workspace ownership; not crash/power-loss atomic. Every Add File content line requires one + patch prefix; encode a literal leading plus as ++. Never send diff --git format.'
                    parameters = [ordered]@{
                        type = 'object'
                        properties = [ordered]@{ patch = [ordered]@{ type = 'string' } }
                        required = @('patch')
                        additionalProperties = $false
                    }
                }
            })
            [void]$exposedNames.Add('apply_patch')
        }
    }
    $script:LastExposedToolNames = @($exposedNames.ToArray())
    return @($definitions.ToArray())
}

function New-InitialMessages {
    $system = New-InitialSystemMessage
    $user = [string]$Prompt
    return @(
        [ordered]@{ role = 'system'; content = $system },
        [ordered]@{ role = 'user'; content = $user }
    )
}

function New-InitialSystemMessage {
    $strategy = $script:EffectiveWriteStrategy
    if ($DirectResponse) {
        return 'Answer the user directly and concisely. No workspace tools are available. Do not claim to inspect or modify files.'
    }
    $readPathText = [string]::Join(', ', @(
        $script:ReadPathDisplay | ForEach-Object { [string]$_ }
    ))
    $writePathText = [string]::Join(', ', @(
        $script:WritePathDisplay | ForEach-Object { [string]$_ }
    ))
    if ($script:Mode -eq 'ReadOnly') {
        # Independent Reviewer prompt: no Writer/editing language; mutation explicitly prohibited.
        return (
            'You are the single sequential workspace Reviewer in ReadOnly mode. One model response is one turn. ' +
            'Use only the provided read tools (read_file, search_text); there is no shell, command runner, commit, stage, push, dependency installation, or recursive runner. ' +
            'Readable paths are: ' + $readPathText + '. ' +
            'There are no writable paths in this role. You must not mutate, edit, write, patch, create, delete, rename, or otherwise change any workspace file or path. ' +
            'Write tools are unavailable and any mutation attempt is forbidden. ' +
            'Batch independent reads and searches in the same turn and do not reread unchanged files. ' +
            'Gather evidence with reads and searches only, then stop with a concise review report. Never claim to have edited files.'
        )
    }
    $base = 'You are the single sequential workspace Writer. One model response is one turn. Use only the provided tools; there is no shell, command runner, commit, stage, push, dependency installation, or recursive runner. Readable paths are: ' + $readPathText + '. Writable paths are: ' + $writePathText + '. Read-only reference paths must never be edited. Batch independent reads and searches in the same turn and do not reread unchanged files. Read before editing, make minimal changes, begin editing once the required evidence is sufficient, and stop with a concise completion report only after the requested work is actually complete.'
    $mutationContract = $script:MutationAtomicityContract
    if ($strategy -eq 'ReplaceText') {
        $base += ' Write strategy: ReplaceText. Only replace_text is available for writes. Replace exactly one occurrence in one file; use shortest unique context; do not copy whole large files. One replace_text call per turn; reread a changed file before another edit. A tool failure stops the turn and all later writes.'
    }
    elseif ($strategy -eq 'ApplyPatch') {
        $base += ' Write strategy: ApplyPatch. Only apply_patch is available for writes. apply_patch accepts one or more files in one batch and requires Codex markers *** Begin Patch, then one or more *** Update File: path or *** Add File: path sections, then *** End Patch; every file is validated before any durable write; mutation is ' + $mutationContract + '; every Add File content line begins with + and a literal leading plus is encoded as ++; never send diff --git. One apply_patch tool call per turn; reread a changed file before another edit. A tool failure stops the turn and all later writes.'
    }
    else {
        $base += ' apply_patch accepts one or more files in one batch and requires Codex markers *** Begin Patch, then one or more *** Update File: path or *** Add File: path sections, then *** End Patch; every file is validated before any durable write; mutation is ' + $mutationContract + '; every Add File content line begins with + and a literal leading plus is encoded as ++; never send diff --git. One write tool call per turn; reread a changed file before another edit; use shortest unique context; do not copy whole large files; preserve valid JSON escaping for backslashes and prefer forward slashes for path arguments. A tool failure stops the turn and all later writes.'
    }
    return $base
}

function Load-MockResponses {
    if (-not $TestMode -or [string]::IsNullOrWhiteSpace($MockResponsesPath)) {
        return @()
    }
    if (-not (Test-Path -LiteralPath $MockResponsesPath -PathType Leaf)) {
        throw 'MOCK_RESPONSES_FILE_MISSING'
    }
    $json = [System.IO.File]::ReadAllText($MockResponsesPath)
    $converted = $json | ConvertFrom-Json
    $parsed = @($converted | ForEach-Object { $_ })
    if ($parsed.Count -eq 1 -and $null -ne $parsed[0].responses) {
        return @($parsed[0].responses | ForEach-Object { $_ })
    }
    return @($parsed | ForEach-Object { $_ })
}

function Get-ResponseMessage {
    param([object]$Response)
    if ($null -eq $Response) {
        return $null
    }
    if ($null -ne $Response.choices -and @($Response.choices).Count -gt 0) {
        return $Response.choices[0].message
    }
    if ($null -ne $Response.message) {
        return $Response.message
    }
    return $null
}

function Get-ResponseUsage {
    param([object]$Response)
    if ($null -eq $Response -or $null -eq $Response.usage) {
        return $null
    }
    $usage = $Response.usage
    $promptValue = $usage.prompt_tokens
    if ($null -eq $promptValue) {
        $promptValue = $usage.input_tokens
    }
    if ($null -eq $promptValue) {
        return $null
    }
    try {
        $promptTokens = [int64]$promptValue
        $completionTokens = 0
        if ($null -ne $usage.completion_tokens) {
            $completionTokens = [int64]$usage.completion_tokens
        }
        elseif ($null -ne $usage.output_tokens) {
            $completionTokens = [int64]$usage.output_tokens
        }
        return [pscustomobject]@{
            prompt_tokens = $promptTokens
            completion_tokens = $completionTokens
            context_tokens = ($promptTokens + $completionTokens + $script:OutputReserveTokens)
        }
    }
    catch {
        return $null
    }
}

function Add-AssistantMessage {
    param([object]$Message)
    $assistant = [ordered]@{
        role = 'assistant'
        content = if ($null -eq $Message.content) { $null } else { [string]$Message.content }
    }
    if ($Message.PSObject.Properties.Name -contains 'reasoning_content') {
        $assistant.reasoning_content = $Message.reasoning_content
    }
    if ($Message.PSObject.Properties.Name -contains 'reasoning_details') {
        $assistant.reasoning_details = $Message.reasoning_details
    }
    $toolCallsProperty = $Message.PSObject.Properties['tool_calls']
    if ($null -ne $toolCallsProperty -and $null -ne $toolCallsProperty.Value) {
        $assistant.tool_calls = @(
            foreach ($toolCall in @($toolCallsProperty.Value)) {
                [ordered]@{
                    id = [string]$toolCall.id
                    type = if ([string]::IsNullOrWhiteSpace([string]$toolCall.type)) {
                        'function'
                    }
                    else {
                        [string]$toolCall.type
                    }
                    function = [ordered]@{
                        name = [string]$toolCall.function.name
                        arguments = [string]$toolCall.function.arguments
                    }
                }
            }
        )
    }
    $script:Messages += $assistant
}

function Convert-ArgumentsObject {
    param([object]$ToolCall)
    $raw = $null
    if ($null -ne $ToolCall.function) {
        $raw = $ToolCall.function.arguments
    }
    if ($null -eq $raw -or ([string]$raw).Trim().Length -eq 0) {
        return [pscustomobject]@{}
    }
    if ($raw -is [string]) {
        try {
            return ([string]$raw | ConvertFrom-Json)
        }
        catch {
            throw 'TOOL_ARGUMENTS_INVALID_JSON'
        }
    }
    return $raw
}

function Get-ToolCallName {
    param([object]$ToolCall)
    if ($null -ne $ToolCall.function -and $null -ne $ToolCall.function.name) {
        return [string]$ToolCall.function.name
    }
    return ''
}

function Get-ToolBatchFingerprint {
    param([object[]]$ToolCalls)
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($call in $ToolCalls) {
        $name = Get-ToolCallName $call
        $args = ''
        try {
            $args = ConvertTo-Json (Convert-ArgumentsObject $call) -Depth 20 -Compress
        }
        catch {
            $args = 'INVALID'
        }
        [void]$parts.Add($name + ':' + (Get-Sha256Text $args))
    }
    $partArray = @($parts | ForEach-Object { [string]$_ })
    return (Get-Sha256Text ([string]::Join('|', $partArray)))
}

function Convert-ToSafeObject {
    param(
        [AllowNull()][object]$Value,
        [ValidateRange(0, 40)]
        [int]$Depth = 0
    )
    if ($Depth -ge 40) {
        throw 'SAFE_OBJECT_MAX_DEPTH'
    }
    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [string]) {
        $text = [string]$Value
        $trimmed = $text.Trim()
        $isObjectJson = $trimmed.StartsWith('{') -and $trimmed.EndsWith('}')
        $isArrayJson = $trimmed.StartsWith('[') -and $trimmed.EndsWith(']')
        if ($isObjectJson -or $isArrayJson) {
            $parsed = $null
            $parsedOk = $false
            try {
                if ($isArrayJson) {
                    $parsed = @($text | ConvertFrom-Json -ErrorAction Stop)
                }
                else {
                    $parsed = $text | ConvertFrom-Json -ErrorAction Stop
                }
                $parsedOk = $true
            }
            catch {
                $parsedOk = $false
            }
            if ($parsedOk) {
                $safeParsed = Convert-ToSafeObject -Value $parsed -Depth ($Depth + 1)
                return (ConvertTo-Json -InputObject $safeParsed -Depth 30 -Compress)
            }
        }
        return (Redact-Text $text)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $safeDictionary = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $name = [string]$key
            if ($name -match '^(?i:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|secret|password|token)$') {
                $safeDictionary[$name] = '[REDACTED]'
            }
            else {
                $safeDictionary[$name] = Convert-ToSafeObject -Value $Value[$key] -Depth ($Depth + 1)
            }
        }
        return $safeDictionary
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $safeObject = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            $name = [string]$property.Name
            if ($name -match '^(?i:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|secret|password|token)$') {
                $safeObject[$name] = '[REDACTED]'
            }
            else {
                $safeObject[$name] = Convert-ToSafeObject -Value $property.Value -Depth ($Depth + 1)
            }
        }
        return [pscustomobject]$safeObject
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $safeItems = New-Object System.Collections.Generic.List[object]
        foreach ($item in $Value) {
            [void]$safeItems.Add((Convert-ToSafeObject -Value $item -Depth ($Depth + 1)))
        }
        return ,@($safeItems.ToArray())
    }
    return $Value
}

function Get-CheckpointPath {
    param([string]$Requested)
    $path = $Requested
    if ([string]::IsNullOrWhiteSpace($path)) {
        $safeTask = [regex]::Replace($script:TaskId, '[^A-Za-z0-9_.-]', '_')
        $base = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
        if ([string]::IsNullOrWhiteSpace($base)) {
            $base = [System.IO.Path]::GetTempPath()
        }
        $path = Join-Path $base ('SSWCenter\deepseek-runner\' + $safeTask + '.checkpoint.json')
    }
    $full = [System.IO.Path]::GetFullPath($path)
    $rootPrefix = $script:RepositoryRoot.TrimEnd('\') + '\'
    if ($full -eq $script:RepositoryRoot -or $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'CHECKPOINT_INSIDE_REPOSITORY'
    }
    return $full
}

function Save-Checkpoint {
    param([string]$Reason = 'periodic')
    if ([string]::IsNullOrWhiteSpace($script:CheckpointPathResolved)) {
        return $true
    }
    $priorLastCheckpointEditCount = $script:LastCheckpointEditCount
    $priorCheckpointRound = $script:CheckpointRound
    try {
        $safeMessages = Convert-ToSafeObject @($script:Messages)
        # Capture pre-increment checkpoint round into runner_state so resume restores the saved value.
        $nextCheckpointRound = $script:CheckpointRound + 1
        $script:LastCheckpointEditCount = $script:EditCount
        $runnerState = Get-RunnerStateObject
        $runnerState.checkpoint_round = $nextCheckpointRound
        $runnerState.last_checkpoint_edit_count = $script:LastCheckpointEditCount
        $data = [ordered]@{
            schema_version = $script:SchemaVersion
            runner = $script:RunnerName
            runner_version = $script:RunnerVersion
            task_id = $script:TaskId
            provider = $script:Provider
            model = $script:Model
            mode = $script:Mode
            read_paths = @($script:ReadPathDisplay)
            write_paths = @($script:WritePathDisplay)
            workspace_fingerprint = $script:ExpectedFingerprint
            base_head = $script:BaseHead
            final_head = (Get-GitHead)
            workspace_diff_sha256 = (Get-GitDiffHash)
            changed_file_hashes = $script:ChangedFileHashes
            base_write_state = $script:BaseWriteState
            net_changed_paths = $runnerState.net_changed_paths
            net_changed_file_hashes = $runnerState.net_changed_file_hashes
            committed = $false
            turn = $script:TurnsUsed
            next_turn = ($script:TurnsUsed + 1)
            effective_max_turns = $script:EffectiveMaxTurns
            hard_turn_limit = $script:HardTurnLimit
            extensions_used = $script:ExtensionsUsed
            no_progress_rounds = $script:NoProgressRounds
            latest_prompt_tokens = $script:LatestPromptTokens
            latest_context_tokens = $script:LatestContextTokens
            checkpoint_round = $nextCheckpointRound
            checkpoint_reason = $Reason
            requested_write_strategy = $script:RequestedWriteStrategy
            effective_write_strategy = $script:EffectiveWriteStrategy
            convergence_mode = $script:ConvergenceMode
            expected_write_bytes = $script:ExpectedWriteBytes
            effective_expected_write_bytes = $script:EffectiveExpectedWriteBytes
            writer_budget_source = $script:WriterBudgetSource
            runner_state = $runnerState
            completion_criteria = 'The model must report completion after requested edits and tests are complete; this runner never commits.'
            remaining_work = if ([string]::IsNullOrWhiteSpace($script:StopReason)) { 'Continue from next_turn.' } else { $script:StopReason }
            message_boundary = [ordered]@{
                last_turn = $script:TurnsUsed
                next_model_request = ($script:TurnsUsed + 1)
                ordering = 'assistant tool_call and tool result messages are preserved in order'
            }
            messages = $safeMessages
        }
        $payloadJson = ConvertTo-Json $data -Depth 40 -Compress
        $data.payload_sha256 = Get-Sha256Text $payloadJson
        $json = ConvertTo-Json $data -Depth 40
        $directory = Split-Path -Parent $script:CheckpointPathResolved
        if (-not (Test-Path -LiteralPath $directory)) {
            [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        }
        $temp = Join-Path $directory ('.checkpoint-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $encoding = New-Object System.Text.UTF8Encoding($false)
        try {
            [System.IO.File]::WriteAllText($temp, $json, $encoding)
            if (Test-Path -LiteralPath $script:CheckpointPathResolved -PathType Leaf) {
                $backup = Join-Path $directory ('.checkpoint-backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
                try {
                    [System.IO.File]::Replace($temp, $script:CheckpointPathResolved, $backup, $true)
                }
                catch {
                    throw ('CHECKPOINT_ATOMIC_REPLACE_FAILED: ' + $_.Exception.Message)
                }
                finally {
                    if (Test-Path -LiteralPath $backup) {
                        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
                    }
                }
            }
            else {
                [System.IO.File]::Move($temp, $script:CheckpointPathResolved)
            }
        }
        finally {
            if (Test-Path -LiteralPath $temp) {
                Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
            }
        }
        $script:CheckpointRound = $nextCheckpointRound
        $script:CheckpointSaved = $true
        return $true
    }
    catch {
        # Roll back in-memory checkpoint markers so a failed save cannot leak partial state.
        $script:LastCheckpointEditCount = $priorLastCheckpointEditCount
        $script:CheckpointRound = $priorCheckpointRound
        $script:CheckpointFailure = $true
        Add-RunnerError 'CHECKPOINT_WRITE_FAILED' $_.Exception.Message
        return $false
    }
}

function Load-Checkpoint {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw 'CHECKPOINT_MISSING'
        }
        $raw = [System.IO.File]::ReadAllText($Path)
        $data = $raw | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string]$data.payload_sha256)) {
            throw 'CHECKPOINT_HASH_MISSING'
        }
        $payload = [ordered]@{}
        foreach ($property in $data.PSObject.Properties) {
            if ($property.Name -ne 'payload_sha256') {
                $payload[$property.Name] = $property.Value
            }
        }
        $computedPayloadHash = Get-Sha256Text (ConvertTo-Json $payload -Depth 40 -Compress)
        if ([string]$data.payload_sha256 -ne $computedPayloadHash) {
            throw 'CHECKPOINT_HASH_MISMATCH'
        }
        if ($data.schema_version -ne $script:SchemaVersion) {
            throw 'CHECKPOINT_SCHEMA_MISMATCH'
        }
        if ($data.runner -ne $script:RunnerName -or $data.model -ne $script:Model -or $data.mode -ne $script:Mode -or $data.provider -ne $script:Provider) {
            throw 'CHECKPOINT_RUNNER_CONFIG_MISMATCH'
        }
        $savedReadPaths = @($data.read_paths | ForEach-Object { [string]$_ })
        $savedWritePaths = @($data.write_paths | ForEach-Object { [string]$_ })
        if (
            (ConvertTo-Json $savedReadPaths -Compress) -ne
                (ConvertTo-Json @($script:ReadPathDisplay) -Compress) -or
            (ConvertTo-Json $savedWritePaths -Compress) -ne
                (ConvertTo-Json @($script:WritePathDisplay) -Compress)
        ) {
            throw 'CHECKPOINT_PATH_POLICY_MISMATCH'
        }
        $current = Get-WorkspaceSnapshot
        if ([string]$data.workspace_fingerprint -ne [string]$current.fingerprint) {
            throw 'CHECKPOINT_FINGERPRINT_MISMATCH'
        }
        if ([string]$data.base_head -ne [string]$script:BaseHead) {
            throw 'CHECKPOINT_BASE_HEAD_MISMATCH'
        }
        if ([string]::IsNullOrWhiteSpace([string]$data.task_id)) {
            throw 'CHECKPOINT_TASK_ID_MISSING'
        }
        if ($null -eq $data.messages) {
            throw 'CHECKPOINT_MESSAGES_MISSING'
        }
        if ($null -eq $data.runner_state) {
            throw 'CHECKPOINT_RUNNER_STATE_MISSING'
        }
        $script:TaskId = [string]$data.task_id
        $script:Messages = @($data.messages)
        Restore-RunnerState $data.runner_state
        # Fingerprint sealed in runner_state must match checkpoint envelope and live workspace.
        if ([string]$script:ExpectedFingerprint -ne [string]$data.workspace_fingerprint) {
            throw 'CHECKPOINT_FINGERPRINT_MISMATCH'
        }
        if ([string]$script:ExpectedFingerprint -ne [string]$current.fingerprint) {
            throw 'CHECKPOINT_FINGERPRINT_MISMATCH'
        }
        return $true
    }
    catch {
        Add-RunnerError $_.Exception.Message
        $script:StopReason = $_.Exception.Message
        return $false
    }
}

function Get-ModelRequestErrorDetail {
    param([System.Management.Automation.ErrorRecord]$ErrorRecord)
    $parts = New-Object System.Collections.Generic.List[string]
    $bodyTexts = New-Object System.Collections.Generic.List[string]
    [void]$parts.Add((Redact-Text $ErrorRecord.Exception.Message))
    if (
        $null -ne $ErrorRecord.ErrorDetails -and
        -not [string]::IsNullOrWhiteSpace([string]$ErrorRecord.ErrorDetails.Message)
    ) {
        [void]$bodyTexts.Add([string]$ErrorRecord.ErrorDetails.Message)
    }
    try {
        $response = $ErrorRecord.Exception.Response
        if ($null -ne $response) {
            if ($response.PSObject.Properties.Name -contains 'StatusCode') {
                [void]$parts.Add(('HTTP_STATUS=' + [int]$response.StatusCode))
            }
            $stream = $response.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                try {
                    $streamBody = $reader.ReadToEnd()
                    if (-not [string]::IsNullOrWhiteSpace($streamBody)) {
                        [void]$bodyTexts.Add($streamBody)
                    }
                }
                finally {
                    $reader.Dispose()
                }
            }
        }
    }
    catch {
        # Preserve the original exception if provider diagnostics cannot be parsed.
    }
    foreach ($bodyText in @($bodyTexts | Select-Object -Unique)) {
        try {
            $apiError = $bodyText | ConvertFrom-Json
            $errorProperty = $apiError.PSObject.Properties['error']
            if ($null -eq $errorProperty -or $null -eq $errorProperty.Value) {
                continue
            }
            $codeProperty = $errorProperty.Value.PSObject.Properties['code']
            if ($null -ne $codeProperty -and -not [string]::IsNullOrWhiteSpace([string]$codeProperty.Value)) {
                [void]$parts.Add(('API_CODE=' + (Redact-Text ([string]$codeProperty.Value))))
            }
            $messageProperty = $errorProperty.Value.PSObject.Properties['message']
            if ($null -ne $messageProperty -and -not [string]::IsNullOrWhiteSpace([string]$messageProperty.Value)) {
                [void]$parts.Add(('API_MESSAGE=' + (Redact-Text ([string]$messageProperty.Value))))
            }
        }
        catch {
            # Do not expose an unstructured provider response body.
        }
    }
    return ([string]::Join(' | ', $parts.ToArray()))
}

function Get-ProviderHttpErrorDetail {
    param(
        [int]$StatusCode,
        [AllowEmptyString()][string]$BodyText
    )
    $parts = New-Object System.Collections.Generic.List[string]
    [void]$parts.Add(('HTTP_STATUS=' + $StatusCode))
    if ([string]::IsNullOrWhiteSpace($BodyText)) {
        return ([string]::Join(' | ', $parts.ToArray()))
    }
    try {
        $apiError = $BodyText | ConvertFrom-Json
        $errorProperty = $apiError.PSObject.Properties['error']
        if ($null -ne $errorProperty -and $null -ne $errorProperty.Value) {
            $codeProperty = $errorProperty.Value.PSObject.Properties['code']
            if ($null -ne $codeProperty -and -not [string]::IsNullOrWhiteSpace([string]$codeProperty.Value)) {
                [void]$parts.Add(('API_CODE=' + (Redact-Text ([string]$codeProperty.Value))))
            }
            $messageProperty = $errorProperty.Value.PSObject.Properties['message']
            if ($null -ne $messageProperty -and -not [string]::IsNullOrWhiteSpace([string]$messageProperty.Value)) {
                [void]$parts.Add(('API_MESSAGE=' + (Redact-Text ([string]$messageProperty.Value))))
            }
        }
    }
    catch {
        # Never expose an unstructured provider response body.
    }
    return ([string]::Join(' | ', $parts.ToArray()))
}

function Invoke-ModelRequest {
    # Obtain tool definitions before TestMode early return so TestMode records the exact exposed list too
    $toolDefinitions = @(Get-ToolDefinitions)
    $script:ToolExposureHistory += [ordered]@{
        turn = ($script:TurnsUsed + 1)
        names = @($script:LastExposedToolNames)
    }
    if ($TestMode) {
        if ($script:MockIndex -ge $script:MockResponses.Count) {
            return [pscustomobject]@{
                __runner_error = 'MOCK_RESPONSES_EXHAUSTED'
            }
        }
        $response = $script:MockResponses[$script:MockIndex]
        $script:MockIndex++
        # Optional TestMode-only synthetic request duration for API-budget contracts (ignored outside TestMode).
        $testDurationRaw = [System.Environment]::GetEnvironmentVariable('DEEPSEEK_RUNNER_TEST_REQUEST_DURATION_MS')
        if (-not [string]::IsNullOrWhiteSpace($testDurationRaw)) {
            try {
                $script:RequestDurationsMs += [int64]$testDurationRaw
            }
            catch {
                # Ignore malformed injection values.
            }
        }
        return $response
    }
    $requestTimer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $body = [ordered]@{
            model = $script:Model
            messages = @($script:Messages)
            max_tokens = $MaxTokens
            stream = $false
        }
        if ($toolDefinitions.Count -gt 0) {
            $body.tools = $toolDefinitions
        }
        if ($script:Provider -eq 'DeepSeek') {
            $body.thinking = [ordered]@{ type = $script:ThinkingModeResolved }
            if ($script:ThinkingModeResolved -eq 'enabled') {
                $body.reasoning_effort = $ReasoningEffort
            }
            else {
                $body.temperature = 0
            }
        }
        else {
            $body.temperature = 0
            $body.reasoning_effort = $ReasoningEffort
            if ($toolDefinitions.Count -gt 0) {
                $body.tool_choice = 'auto'
            }
        }
        $json = ConvertTo-Json $body -Depth 40
        Add-Type -AssemblyName System.Net.Http
        $httpClient = New-Object System.Net.Http.HttpClient
        $httpResponse = $null
        $httpContent = $null
        try {
            # Clamp HTTP timeout to remaining wall/API budgets so a long provider call
            # cannot overrun the hard budget after a precheck that only checked "before".
            $effectiveTimeoutMs = Get-EffectiveHttpClientTimeoutMs
            $httpClient.Timeout = [TimeSpan]::FromMilliseconds([double]$effectiveTimeoutMs)
            $httpClient.DefaultRequestHeaders.Authorization = New-Object `
                System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $script:ApiKey)
            $httpContent = New-Object System.Net.Http.StringContent(
                $json,
                [System.Text.Encoding]::UTF8,
                'application/json'
            )
            $httpResponse = $httpClient.PostAsync($script:Endpoint, $httpContent).GetAwaiter().GetResult()
            $responseText = $httpResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if (-not $httpResponse.IsSuccessStatusCode) {
                return [pscustomobject]@{
                    __runner_error = 'MODEL_REQUEST_FAILED'
                    __runner_detail = Get-ProviderHttpErrorDetail `
                        -StatusCode ([int]$httpResponse.StatusCode) `
                        -BodyText $responseText
                }
            }
            return ($responseText | ConvertFrom-Json)
        }
        finally {
            if ($null -ne $httpContent) { $httpContent.Dispose() }
            if ($null -ne $httpResponse) { $httpResponse.Dispose() }
            $httpClient.Dispose()
        }
    }
    catch {
        return [pscustomobject]@{
            __runner_error = 'MODEL_REQUEST_FAILED'
            __runner_detail = (Get-ModelRequestErrorDetail $_)
        }
    }
    finally {
        $requestTimer.Stop()
        $script:RequestDurationsMs += [int64]$requestTimer.ElapsedMilliseconds
    }
}

function Get-ResultObject {
    param([string]$Status)
    $script:FinalHead = Get-GitHead
    $script:WorkspaceDiffHash = Get-GitDiffHash
    $snapshot = Get-WorkspaceSnapshot
    if ([string]::IsNullOrWhiteSpace($script:ExpectedFingerprint)) {
        $script:ExpectedFingerprint = $snapshot.fingerprint
    }
    # One writable-tree pass for both net evidence fields.
    $writeState = Get-WritePathState
    $netChangedPaths = @(Get-NetChangedPaths -CurrentWriteState $writeState)
    $netChangedHashes = Get-NetChangedFileHashes -CurrentWriteState $writeState
    return [ordered]@{
        status = $Status
        runner = $script:RunnerName
        runner_version = $script:RunnerVersion
        schema_version = $script:SchemaVersion
        provider = $script:Provider
        mode = $script:Mode
        model = $script:Model
        endpoint = $script:Endpoint
        repository_root = $script:RepositoryRoot
        task_id = $script:TaskId
        dry_run = [bool]$DryRun
        direct_response = [bool]$DirectResponse
        thinking_mode = $script:ThinkingModeResolved
        tools_enabled = (-not [bool]$DirectResponse)
        elapsed_ms = (Get-TotalElapsedMs)
        api_elapsed_ms = (Get-TotalApiElapsedMs)
        request_durations_ms = @($script:RequestDurationsMs)
        max_elapsed_minutes = [int]$script:MaxElapsedMinutes
        max_api_elapsed_minutes = [int]$script:MaxApiElapsedMinutes
        mutation_atomicity_contract = $script:MutationAtomicityContract
        turns_used = $script:TurnsUsed
        max_turns = $MaxTurns
        effective_max_turns = $script:EffectiveMaxTurns
        hard_turn_limit = $script:HardTurnLimit
        checkpoint_turn = $script:CheckpointTurn
        soft_turn = $script:SoftTurn
        extension_size = $script:ExtensionSize
        extensions_used = $script:ExtensionsUsed
        no_progress_rounds = $script:NoProgressRounds
        latest_prompt_tokens = $script:LatestPromptTokens
        latest_completion_tokens = $script:LatestCompletionTokens
        latest_context_tokens = $script:LatestContextTokens
        usage_known = $script:LatestUsageKnown
        provider_context_limit = $script:ProviderContextLimit
        context_soft_limit = $script:ContextSoftLimit
        context_hard_limit = $script:ContextHardLimit
        output_reserve_tokens = $script:OutputReserveTokens
        minimum_writer_output_tokens = $script:MinimumWriterOutputTokens
        usable_context_tokens = ($script:ContextHardLimit - $script:OutputReserveTokens)
        request_count = $script:RequestCount
        finish_reasons = @($script:FinishReasons)
        tool_calls = $script:ToolCallCount
        tool_calls_by_name = $script:ToolCallsByName
        tool_call_sequence = @($script:ToolCallSequence)
        read_tool_calls = $script:ReadCallCount
        max_read_tool_calls = $MaxReadToolCalls
        edit_count = $script:EditCount
        patch_count = $script:PatchCount
        leading_tool_failure = $script:LeadingToolFailure
        changed_paths = @($script:ChangedPaths.Keys | Sort-Object)
        changed_file_hashes = $script:ChangedFileHashes
        base_write_state = $script:BaseWriteState
        net_changed_paths = $netChangedPaths
        net_changed_file_hashes = $netChangedHashes
        read_paths = @($script:ReadPathDisplay)
        write_paths = @($script:WritePathDisplay)
        base_head = $script:BaseHead
        final_head = $script:FinalHead
        workspace_fingerprint = $script:ExpectedFingerprint
        workspace_diff_sha256 = $script:WorkspaceDiffHash
        committed = $false
        checkpoint_saved = $script:CheckpointSaved
        checkpoint_round = $script:CheckpointRound
        checkpoint_integrity = if ($script:CheckpointFailure) { 'FAIL' } elseif ($script:CheckpointSaved) { 'ATOMIC_WRITE_ATTEMPTED' } else { 'NOT_REQUESTED' }
        checkpoint_schema_version = $script:SchemaVersion
        warnings = @($script:Warnings)
        errors = @($script:Errors)
        stop_reason = $script:StopReason
        cumulative_prompt_tokens = $script:CumulativePromptTokens
        cumulative_completion_tokens = $script:CumulativeCompletionTokens
        cumulative_tokens = ($script:CumulativePromptTokens + $script:CumulativeCompletionTokens)
        cost_usd = if ($script:RequestCount -eq 0) { 0 } else { 'uninstrumented' }
        response = (Redact-Text $script:FinalResponse)
        exit_code = $script:ExitCode
        requested_write_strategy = $script:RequestedWriteStrategy
        effective_write_strategy = $script:EffectiveWriteStrategy
        estimated_writer_output_tokens = $script:EstimatedWriterOutputTokens
        convergence_mode = $script:ConvergenceMode
        expected_write_bytes = $script:ExpectedWriteBytes
        effective_expected_write_bytes = $script:EffectiveExpectedWriteBytes
        writer_budget_source = $script:WriterBudgetSource
        exposed_tool_names = @($script:LastExposedToolNames)
        tool_exposure_history = @($script:ToolExposureHistory)
    }
}

function Emit-Result {
    param([object]$Result)
    if ($JsonOutput) {
        Write-Output (ConvertTo-Json $Result -Depth 50)
        return
    }
    Write-Output ('DEEPSEEK_WORKSPACE_RUNNER={0} mode={1} provider={2} model={3} turns={4}/{5} exit={6}' -f $Result.status, $Result.mode, $Result.provider, $Result.model, $Result.turns_used, $Result.effective_max_turns, $Result.exit_code)
    if (-not [string]::IsNullOrWhiteSpace([string]$Result.stop_reason)) {
        Write-Output ('STOP_REASON={0}' -f (Redact-Text $Result.stop_reason))
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Result.response)) {
        Write-Output (Redact-Text $Result.response)
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
        $RepositoryRoot = Split-Path -Parent $PSScriptRoot
    }
    $script:RepositoryRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
    if (-not (Test-Path -LiteralPath $script:RepositoryRoot -PathType Container)) {
        throw 'REPOSITORY_ROOT_MISSING'
    }
    if ($MaxApiElapsedMinutes -gt $MaxElapsedMinutes) {
        throw 'MAX_API_ELAPSED_EXCEEDS_MAX_ELAPSED'
    }
    if ($RequestTimeoutSeconds -ne 0 -and ($RequestTimeoutSeconds -lt 30 -or $RequestTimeoutSeconds -gt 600)) {
        throw 'REQUEST_TIMEOUT_OUT_OF_RANGE'
    }
    if ($DirectResponse -and $Mode -ne 'ReadOnly') {
        throw 'DIRECT_RESPONSE_READONLY_ONLY'
    }
    if ([string]::IsNullOrWhiteSpace($Model)) {
        $Model = if ($Provider -eq 'DeepSeek') { 'deepseek-v4-pro' } else { 'anthropic/claude-opus-5' }
    }
    if ($Provider -eq 'DeepSeek' -and $Model -eq 'deepseek-v4-flash') {
        throw 'MODEL_NOT_ALLOWED'
    }
    $script:Model = $Model
    $script:ThinkingModeResolved = if ($Provider -ne 'DeepSeek') {
        'provider-default'
    }
    elseif ($ThinkingMode -eq 'auto') {
        if ($DirectResponse) { 'disabled' } else { 'enabled' }
    }
    else {
        $ThinkingMode
    }
    $script:Endpoint = if ([string]::IsNullOrWhiteSpace($Endpoint)) {
        if ($Provider -eq 'DeepSeek') { 'https://api.deepseek.com/chat/completions' } else { 'https://openrouter.ai/api/v1/chat/completions' }
    }
    else { $Endpoint }
    $uri = New-Object System.Uri($script:Endpoint)
    $allowedHost = if ($Provider -eq 'DeepSeek') { 'api.deepseek.com' } else { 'openrouter.ai' }
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne $allowedHost) {
        throw 'ENDPOINT_NOT_ALLOWLISTED'
    }
    $script:TimeoutSeconds = if ($RequestTimeoutSeconds -eq 0) { if ($Provider -eq 'DeepSeek') { 300 } else { 420 } } else { $RequestTimeoutSeconds }
    if ([string]::IsNullOrWhiteSpace($TaskId)) {
        $TaskId = 'task-' + [guid]::NewGuid().ToString('N')
    }
    $script:TaskId = $TaskId
    $script:BaseHead = Get-GitHead
    $script:WriteRoots = @()
    if ($null -ne $AllowPath) {
        # Expand comma-joined external CLI values so -AllowPath a,b,c works via powershell.exe -File.
        $allowItems = @($AllowPath | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        foreach ($requestedPath in $allowItems) {
            $relative = Get-NormalizedRelativePath $requestedPath
            if ([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|\\)\.\.(\\|$)') {
                throw 'ALLOWLIST_PATH_INVALID'
            }
            if (Test-SensitiveRelativePath $relative) {
                throw 'ALLOWLIST_SENSITIVE_PATH'
            }
            Get-FullPathFromRelative $relative | Out-Null
            if ($script:WriteRoots -notcontains $relative) {
                $script:WriteRoots += $relative
            }
        }
    }
    $script:ReadRoots = @($script:WriteRoots)
    if ($null -ne $ReadPath) {
        $readItems = @($ReadPath | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        foreach ($requestedPath in $readItems) {
            $relative = Get-NormalizedRelativePath $requestedPath
            if (
                [string]::IsNullOrWhiteSpace($relative) -or
                [System.IO.Path]::IsPathRooted($relative) -or
                $relative -match '(^|\\)\.\.(\\|$)'
            ) {
                throw 'READ_PATH_INVALID'
            }
            if (Test-SensitiveRelativePath $relative) {
                throw 'READ_PATH_SENSITIVE'
            }
            Get-FullPathFromRelative $relative | Out-Null
            if ($script:ReadRoots -notcontains $relative) {
                $script:ReadRoots += $relative
            }
        }
    }
    $script:WritePathDisplay = @($script:WriteRoots)
    $script:ReadPathDisplay = @($script:ReadRoots)
    if ($Mode -eq 'Writer' -and $script:WriteRoots.Count -eq 0) {
        throw 'WRITER_ALLOWLIST_REQUIRED'
    }
    if ($DirectResponse -and ($script:WriteRoots.Count -gt 0 -or $script:ReadRoots.Count -gt 0)) {
        throw 'DIRECT_RESPONSE_ALLOWLIST_NOT_ALLOWED'
    }
    if ([string]::IsNullOrWhiteSpace($Prompt) -and [string]::IsNullOrWhiteSpace($ResumeCheckpoint)) {
        throw 'PROMPT_REQUIRED'
    }
    # --- Write strategy preflight (before checkpoint, snapshot, mock, offline, or API) ---
    $script:RequestedWriteStrategy = $WriteStrategy
    $script:EffectiveWriteStrategy = Resolve-WriteStrategy -Requested $WriteStrategy -Mode $Mode
    $script:EstimatedWriterOutputTokens = Get-EstimatedWriterOutputTokens -Mode $Mode
    if ($Mode -eq 'Writer') {
        if ($MaxTokens -lt $script:EstimatedWriterOutputTokens) {
            throw 'WRITER_OUTPUT_BUDGET_TOO_LOW'
        }
        $script:MinimumWriterOutputTokens = [Math]::Max($script:MinimumWriterOutputTokens, $script:EstimatedWriterOutputTokens)
        $script:ConvergenceMode = 'normal'
    }
    else {
        $script:ConvergenceMode = 'none'
    }
    $script:CheckpointPathResolved = Get-CheckpointPath $CheckpointPath
    $script:ExpectedFingerprint = (Get-WorkspaceSnapshot).fingerprint
    # Fresh-run baseline seal over writable paths (SHA256 or MISSING). Resume restores sealed state
    # from checkpoint and must not re-seal over post-edit bytes.
    if ([string]::IsNullOrWhiteSpace($ResumeCheckpoint)) {
        Seal-BaseWriteState
    }
    $script:MockResponses = @(Load-MockResponses)
    if (-not [string]::IsNullOrWhiteSpace($MockResponsesPath) -and -not $TestMode) {
        throw 'MOCK_REQUIRES_TEST_MODE'
    }
    # Compute exposed tool names for OfflineConfig and result object
    $script:LastExposedToolNames = @(Get-ToolDefinitions | ForEach-Object { $_.function.name })
    if ($OfflineConfig) {
        $script:Status = 'OFFLINE_CONFIG'
        $script:ExitCode = 0
        $script:StopReason = 'OFFLINE_CONFIG'
    }
    else {
        if (-not $TestMode) {
            $keyName = if ($Provider -eq 'DeepSeek') { 'DEEPSEEK_API_KEY' } else { 'OPENROUTER_API_KEY' }
            try {
                $script:ApiKey = Get-EnvValue -Name $keyName -Path $EnvFile
            }
            catch {
                if ($_.Exception.Message -eq 'ENV_FILE_MISSING') {
                    throw (($Provider.ToUpperInvariant()) + '_ENV_FILE_MISSING')
                }
                throw
            }
            if ([string]::IsNullOrWhiteSpace($script:ApiKey)) {
                throw (($Provider.ToUpperInvariant()) + '_API_KEY_MISSING')
            }
        }
        if ([string]::IsNullOrWhiteSpace($ResumeCheckpoint)) {
            if ([string]::IsNullOrWhiteSpace($Prompt)) {
                throw 'PROMPT_REQUIRED'
            }
            $script:Messages = @(New-InitialMessages)
        }
        else {
            $resumeFull = [System.IO.Path]::GetFullPath($ResumeCheckpoint)
            if ($resumeFull -ne $script:CheckpointPathResolved) {
                $script:CheckpointPathResolved = Get-CheckpointPath $resumeFull
            }
            if (-not (Load-Checkpoint $script:CheckpointPathResolved)) {
                throw 'CHECKPOINT_RESUME_FAILED'
            }
        }
        $previousBatchFingerprint = ''
        $duplicateBatchSeen = $false
        while ($true) {
            if ($script:TurnsUsed -ge $script:EffectiveMaxTurns) {
                $writeStateExt = Get-WritePathState
                $currentNetFp = Get-NetChangeEvidenceFingerprint -CurrentWriteState $writeStateExt
                $hasPositiveNetChange = (@(Get-NetChangedPaths -CurrentWriteState $writeStateExt).Count -gt 0)
                $eligible = ($script:EffectiveMaxTurns -lt $script:HardTurnLimit) -and
                    $hasPositiveNetChange -and
                    ($currentNetFp -ne $script:LastExtensionNetChangeFingerprint) -and
                    (-not $script:LeadingToolFailure) -and
                    (-not $script:CheckpointFailure) -and
                    (Test-ExpectedFingerprint)
                if ($eligible) {
                    $script:EffectiveMaxTurns = [Math]::Min($script:HardTurnLimit, $script:EffectiveMaxTurns + $script:ExtensionSize)
                    $script:ExtensionsUsed++
                    $script:LastExtensionEditCount = $script:EditCount
                    $script:LastExtensionNetChangeFingerprint = $currentNetFp
                    [void](Save-Checkpoint 'extension')
                    continue
                }
                $script:StopReason = if ($script:EffectiveMaxTurns -ge $script:HardTurnLimit) { 'HARD_TURN_LIMIT_REACHED' } else { 'TURN_LIMIT_REACHED' }
                break
            }
            if (-not (Test-ExpectedFingerprint)) {
                Add-RunnerError 'WORKSPACE_FINGERPRINT_MISMATCH'
                $script:StopReason = 'WORKSPACE_FINGERPRINT_MISMATCH'
                break
            }
            if ($script:TurnsUsed -ge $script:SoftTurn) {
                Add-RunnerWarning 'SOFT_TURN_LIMIT_REACHED' 'Further turns require objective progress and safe extension checks.'
            }
            # Wall-clock / API budgets: enforce before every model request.
            $preBudgetCode = Test-TimeBudgetExceeded
            if ($null -ne $preBudgetCode) {
                Stop-ForTimeBudget $preBudgetCode
                break
            }
            $response = $null
            $script:RequestCount++
            $response = Invoke-ModelRequest
            # Enforce again after the request returns; expired responses must not apply tools.
            $postBudgetCode = Test-TimeBudgetExceeded
            if ($null -ne $postBudgetCode) {
                Stop-ForTimeBudget $postBudgetCode
                break
            }
            $runnerErrorProperty = $response.PSObject.Properties['__runner_error']
            if ($null -ne $runnerErrorProperty -and $null -ne $runnerErrorProperty.Value) {
                $runnerDetailProperty = $response.PSObject.Properties['__runner_detail']
                $runnerDetail = if ($null -ne $runnerDetailProperty) {
                    [string]$runnerDetailProperty.Value
                }
                else {
                    ''
                }
                Add-RunnerError ([string]$runnerErrorProperty.Value) $runnerDetail
                $script:StopReason = [string]$runnerErrorProperty.Value
                break
            }
            $script:TurnsUsed++
            $usage = Get-ResponseUsage $response
            if ($null -eq $usage) {
                Add-RunnerError 'CONTEXT_USAGE_UNKNOWN' 'Latest model usage was missing or ambiguous; no tool calls were applied.'
                $script:StopReason = 'CONTEXT_USAGE_UNKNOWN'
                break
            }
            $script:LatestUsageKnown = $true
            $script:LatestPromptTokens = $usage.prompt_tokens
            $script:LatestCompletionTokens = $usage.completion_tokens
            $script:LatestContextTokens = $usage.context_tokens
            $script:CumulativePromptTokens += $usage.prompt_tokens
            $script:CumulativeCompletionTokens += $usage.completion_tokens
            if ($usage.context_tokens -ge $script:ContextSoftLimit) {
                Add-RunnerWarning 'CONTEXT_SOFT_LIMIT_REACHED' 'Latest usage plus output reserve reached the context soft limit.'
            }
            if ($usage.context_tokens -gt $script:ContextHardLimit -or $usage.context_tokens -gt $script:ProviderContextLimit) {
                Add-RunnerError 'CONTEXT_HARD_LIMIT_REACHED' 'Latest usage plus output reserve exceeded the operational context limit.'
                $script:StopReason = 'CONTEXT_HARD_LIMIT_REACHED'
                break
            }
            $message = Get-ResponseMessage $response
            if ($null -eq $message) {
                Add-RunnerError 'MODEL_MESSAGE_MISSING'
                $script:StopReason = 'MODEL_MESSAGE_MISSING'
                break
            }
            $finishReason = if ($null -ne $response.choices -and $null -ne $response.choices[0].finish_reason) { [string]$response.choices[0].finish_reason } else { 'unknown' }
            $script:FinishReasons += $finishReason
            $toolCalls = @()
            $messageToolCallsProperty = $message.PSObject.Properties['tool_calls']
            if (
                $null -ne $messageToolCallsProperty -and
                $null -ne $messageToolCallsProperty.Value
            ) {
                $toolCalls = @($messageToolCallsProperty.Value)
            }
            if ($finishReason -eq 'length' -and $toolCalls.Count -gt 0) {
                Add-RunnerError 'OUTPUT_LIMIT_DURING_TOOL_CALL'
                $script:StopReason = 'OUTPUT_LIMIT_DURING_TOOL_CALL'
                break
            }
            Add-AssistantMessage $message
            $turnProgressStart = Get-ProgressMetric
            if ($toolCalls.Count -eq 0) {
                if ($finishReason -eq 'length') {
                    if ($script:EditCount -eq 0) {
                        Add-RunnerError 'OUTPUT_LIMIT_BEFORE_EDIT'
                        $script:StopReason = 'OUTPUT_LIMIT_BEFORE_EDIT'
                    }
                    else {
                        Add-RunnerError 'OUTPUT_LIMIT_AFTER_EDIT'
                        $script:StopReason = 'OUTPUT_LIMIT_AFTER_EDIT'
                    }
                    break
                }
                if ($null -ne $message.content -and -not [string]::IsNullOrWhiteSpace([string]$message.content)) {
                    $script:FinalResponse = [string]$message.content
                    $completion = Resolve-TerminalCompletionState
                    if (-not [string]::IsNullOrWhiteSpace([string]$completion.ErrorCode)) {
                        Add-RunnerError ([string]$completion.ErrorCode)
                    }
                    $script:Status = [string]$completion.Status
                    $script:ExitCode = [int]$completion.ExitCode
                    $script:StopReason = [string]$completion.StopReason
                    if (-not $DirectResponse) {
                        # Checkpoint is required for non-direct runs that reached model completion.
                        # A write/integrity/redaction failure must not leave PASS/exit 0.
                        $completedSaved = Save-Checkpoint 'completed'
                        if (-not $completedSaved) {
                            Assert-CheckpointSuccessOrDemote -Saved $false -Context 'completed'
                        }
                    }
                    break
                }
                Add-RunnerError 'EMPTY_MODEL_RESPONSE'
                $script:StopReason = 'EMPTY_MODEL_RESPONSE'
                break
            }
            $batchFingerprint = Get-ToolBatchFingerprint $toolCalls
            if ($batchFingerprint -eq $previousBatchFingerprint) {
                if ($duplicateBatchSeen) {
                    Add-RunnerError 'DUPLICATE_TOOL_CALLS' 'The same tool batch was repeated after one warning.'
                    $script:StopReason = 'DUPLICATE_TOOL_CALLS'
                    break
                }
                $duplicateBatchSeen = $true
                Add-RunnerWarning 'DUPLICATE_TOOL_BATCH' 'The same tool batch occurred once; a second repetition stops safely.'
            }
            else {
                $duplicateBatchSeen = $false
            }
            $previousBatchFingerprint = $batchFingerprint

            # --- Local tool-batch preflight (all-or-nothing validation before execution) ---
            $toolContracts = @{
                'read_file'    = @('path')
                'search_text'  = @('pattern')
                'replace_text' = @('path', 'old_text', 'new_text')
                'apply_patch'  = @('patch')
            }
            $writeToolNames = @('replace_text', 'apply_patch')
            $allowedToolNames = @($toolContracts.Keys)
            $preflightEntries = New-Object System.Collections.Generic.List[object]
            $preflightFailed = $false
            $writeCount = 0
            for ($i = 0; $i -lt $toolCalls.Count; $i++) {
                $tc = $toolCalls[$i]
                $tcName = Get-ToolCallName $tc
                $tcId = if ($null -ne $tc.id) { [string]$tc.id } else { 'tool-' + ($script:ToolCallCount + $i + 1) }
                $tcArgs = $null
                $parseErr = $null
                try {
                    $tcArgs = Convert-ArgumentsObject $tc
                }
                catch {
                    $parseErr = if ($finishReason -eq 'length') { 'OUTPUT_LIMIT_DURING_TOOL_CALL' } else { 'TOOL_ARGUMENTS_INVALID_JSON' }
                }
                $entry = [pscustomobject]@{
                    tc       = $tc
                    name     = $tcName
                    id       = $tcId
                    args     = $tcArgs
                    parseErr = $parseErr
                    reqErr    = $null
                    budgetErr = $null
                    unknown   = $false
                    isWrite   = $false
                }
                if ($null -ne $parseErr) {
                    $preflightFailed = $true
                }
                elseif ($tcName -notin $allowedToolNames) {
                    $entry.unknown = $true
                    $preflightFailed = $true
                }
                else {
                    if ($tcName -in $writeToolNames) {
                        $entry.isWrite = $true
                        $writeCount++
                    }
                    if ($null -eq $tcArgs) {
                        $tcArgs = [pscustomobject]@{}
                    }
                    $requiredProps = $toolContracts[$tcName]
                    foreach ($prop in $requiredProps) {
                        $propFound = $tcArgs.PSObject.Properties | Where-Object { $_.Name -eq $prop } | Select-Object -First 1
                        if ($null -eq $propFound) {
                            $entry.reqErr = "$tcName.$prop"
                            $preflightFailed = $true
                            break
                        }
                    }
                }
                [void]$preflightEntries.Add($entry)
            }
            if ($writeCount -gt 1) {
                $preflightFailed = $true
            }
            # Write budget preflight: check serialized write-tool argument size against budget
            if ($Mode -eq 'Writer' -and $script:EffectiveExpectedWriteBytes -gt 0 -and -not $preflightFailed) {
                foreach ($entry in $preflightEntries) {
                    if ($entry.isWrite) {
                        $writeBytes = [System.Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json $entry.args -Depth 20 -Compress))
                        if ($writeBytes -gt $script:EffectiveExpectedWriteBytes) {
                            $entry.budgetErr = 'WRITER_WRITE_BUDGET_EXCEEDED'
                            $preflightFailed = $true
                        }
                    }
                }
            }
            # Snapshot prior-turn fresh read tokens so same-turn reads cannot satisfy freshness
            $script:PriorFreshTokens = $script:FreshReadTokens.Clone()
            # --- End preflight ---

            $batchFailed = $false
            $freshReadRecoveryNeeded = $false
            $freshReadRecoveryPath = ''
            foreach ($entry in $preflightEntries) {
                $tc = $entry.tc
                $name = $entry.name
                $id = $entry.id
                $args = $entry.args
                $script:ToolCallCount++
                if (-not $script:ToolCallsByName.Contains($name)) {
                    $script:ToolCallsByName[$name] = 0
                }
                $toolResult = $null
                if ($preflightFailed) {
                    # A: never break early; assign specific code to defective calls,
                    # TOOL_PREFLIGHT_ABORTED to unaffected calls.
                    # For multiple-write batches, write calls get MULTIPLE_WRITE_TOOLS_PER_TURN
                    # and non-write calls get TOOL_PREFLIGHT_ABORTED.
                    if ($null -ne $entry.parseErr) {
                        $toolResult = New-ToolFailure $entry.parseErr
                    }
                    elseif ($entry.unknown) {
                        $toolResult = New-ToolFailure 'TOOL_NOT_ALLOWED' $name
                    }
                    elseif ($null -ne $entry.reqErr) {
                        $toolResult = New-ToolFailure 'TOOL_ARGUMENT_REQUIRED' $entry.reqErr
                    }
                    elseif ($null -ne $entry.budgetErr) {
                        $toolResult = New-ToolFailure $entry.budgetErr
                    }
                    elseif ($writeCount -gt 1) {
                        if ($entry.isWrite) {
                            $toolResult = New-ToolFailure 'MULTIPLE_WRITE_TOOLS_PER_TURN'
                        }
                        else {
                            $toolResult = New-ToolFailure 'TOOL_PREFLIGHT_ABORTED'
                        }
                    }
                    else {
                        $toolResult = New-ToolFailure 'TOOL_PREFLIGHT_ABORTED'
                    }
                }
                else {
                    $toolResult = Invoke-WorkspaceTool -Name $name -Arguments $args
                }
                $script:ToolCallSequence += [ordered]@{
                    turn        = $script:TurnsUsed
                    tool_call_id = $id
                    name        = $name
                    ok          = [bool]$toolResult.ok
                    changed     = [bool]$toolResult.changed
                }
                if ($toolResult.ok) {
                    $script:ToolCallsByName[$name] = [int]$script:ToolCallsByName[$name] + 1
                }
                # B: serialize failed tool messages as a safe object instead of null result
                if ($toolResult.ok) {
                    $toolContent = ConvertTo-Json (Convert-ToSafeObject $toolResult.result) -Depth 30 -Compress
                }
                else {
                    $safeFailure = [ordered]@{
                        ok           = $false
                        error_code   = [string]$toolResult.error_code
                        error_detail = [string]$toolResult.error_detail
                        changed      = $false
                    }
                    $toolContent = ConvertTo-Json (Convert-ToSafeObject $safeFailure) -Depth 30 -Compress
                }
                $script:Messages += [ordered]@{
                    role         = 'tool'
                    tool_call_id = $id
                    content      = $toolContent
                }
                if (-not $toolResult.ok) {
                    $errorCode = [string]$toolResult.error_code
                    # C: WRITE_REQUIRES_FRESH_READ is recoverable; do not set LeadingToolFailure
                    if ($errorCode -eq 'WRITE_REQUIRES_FRESH_READ') {
                        Add-RunnerWarning $errorCode ([string]$toolResult.error_detail)
                        $freshReadRecoveryNeeded = $true
                        $script:NoProgressRounds = 0
                        # In write-only mode, fall back to forced-write so read_file is available
                        if ($script:ConvergenceMode -eq 'write-only') {
                            $script:ConvergenceMode = 'forced-write'
                        }
                        # Extract the path from the error detail for the system message
                        if ([string]$toolResult.error_detail -match "'([^']+)'") {
                            $freshReadRecoveryPath = $Matches[1]
                        }
                    }
                    elseif ($preflightFailed) {
                        # A: preflight failures are collected but do not break the foreach;
                        # LeadingToolFailure and the primary error are recorded after the loop.
                        $batchFailed = $true
                    }
                    else {
                        $script:LeadingToolFailure = $true
                        Add-RunnerError $errorCode ([string]$toolResult.error_detail)
                        $script:StopReason = 'LEADING_TOOL_FAILURE'
                        $batchFailed = $true
                        break
                    }
                }
                if ($toolResult.changed -and $script:EditCount -gt $script:LastCheckpointEditCount) {
                    if (-not (Save-Checkpoint 'successful_write')) {
                        Assert-CheckpointSuccessOrDemote -Saved $false -Context 'successful_write'
                        $batchFailed = $true
                        break
                    }
                }
            }
            # A: after all preflight-failed entries are emitted, record one primary error and stop
            if ($preflightFailed -and $batchFailed) {
                $script:LeadingToolFailure = $true
                if ($writeCount -gt 1) {
                    Add-RunnerError 'MULTIPLE_WRITE_TOOLS_PER_TURN' 'Multiple write tools requested in one turn; no workspace tool executed.'
                }
                else {
                    # Compute the primary preflight code/detail from the first actual defective entry
                    $primaryCode = 'TOOL_PREFLIGHT_FAILED'
                    $primaryDetail = 'One or more tool calls failed all-or-nothing preflight validation; no workspace tool executed.'
                    foreach ($entry in $preflightEntries) {
                        if ($null -ne $entry.parseErr) {
                            $primaryCode = $entry.parseErr
                            $primaryDetail = ''
                            break
                        }
                        if ($entry.unknown) {
                            $primaryCode = 'TOOL_NOT_ALLOWED'
                            $primaryDetail = $entry.name
                            break
                        }
                        if ($null -ne $entry.budgetErr) {
                            $primaryCode = $entry.budgetErr
                            $primaryDetail = ''
                            break
                        }
                        if ($null -ne $entry.reqErr) {
                            $primaryCode = 'TOOL_ARGUMENT_REQUIRED'
                            $primaryDetail = $entry.reqErr
                            break
                        }
                    }
                    Add-RunnerError $primaryCode $primaryDetail
                }
                $script:StopReason = 'LEADING_TOOL_FAILURE'
            }
            $script:PriorFreshTokens = $null
            # C: append a concise system message for fresh-read recovery
            if ($freshReadRecoveryNeeded -and -not [string]::IsNullOrWhiteSpace($freshReadRecoveryPath)) {
                $script:Messages += [ordered]@{
                    role    = 'system'
                    content = "WRITE_REQUIRES_FRESH_READ: call read_file for '$freshReadRecoveryPath' next turn and continue only unfinished work."
                }
                $script:FreshReadRecoveryTurn = $true
            }
            if ($batchFailed) {
                break
            }
            $turnProgressEnd = Get-ProgressMetric
            $madeProgress = Test-HasPositiveProgress -Before $turnProgressStart -After $turnProgressEnd
            if (-not $madeProgress) {
                # C: do not increment no-progress counter for a fresh-read recovery turn
                if (-not $script:FreshReadRecoveryTurn) {
                    $script:NoProgressRounds++
                }
                $script:FreshReadRecoveryTurn = $false
                $netChangedCount = @(Get-NetChangedPaths).Count
                if ($netChangedCount -eq 0) {
                    # No lasting net change: edit-start convergence applies only when no effective
                    # edits exist yet. A→B→A leaves edit_count>0 with empty net and must not be
                    # treated as post-edit progress debt (so final completion can fail closed on
                    # WRITER_COMPLETED_WITHOUT_NET_CHANGE instead of a false POST_EDIT stop).
                    if ($Mode -eq 'Writer' -and $script:EditCount -eq 0) {
                        if ($script:NoProgressRounds -ge 2 -and $script:ConvergenceMode -ne 'forced-write' -and $script:ConvergenceMode -ne 'write-only') {
                            $script:ConvergenceMode = 'forced-write'
                            Add-RunnerWarning 'EDIT_CONVERGENCE_MODE' 'No edits after 2 rounds; entering forced-write mode. Further search is disabled; read only if freshness is missing, then use the selected write tool for the smallest pending edit.'
                            $script:Messages += [ordered]@{
                                role    = 'system'
                                content = 'Further search is disabled; read only if freshness is missing, then use the selected write tool for the smallest pending edit.'
                            }
                        }
                        if ($script:NoProgressRounds -ge 3 -and $script:ConvergenceMode -eq 'forced-write') {
                            $script:ConvergenceMode = 'write-only'
                            Add-RunnerWarning 'EDIT_CONVERGENCE_MODE' 'No edits after forced-write round; entering write-only mode. Only the selected write tool is exposed.'
                            $script:Messages += [ordered]@{
                                role    = 'system'
                                content = 'Only the selected write tool is available. Make the smallest pending edit now.'
                            }
                        }
                        if ($script:NoProgressRounds -ge 4) {
                            Add-RunnerWarning 'EDIT_START_DEADLINE_WARNING' 'No edits have been made; the run will stop soon without progress.'
                        }
                        if ($script:NoProgressRounds -ge 6) {
                            Add-RunnerError 'EDIT_START_DEADLINE_REACHED' 'No edits were made within the start deadline.'
                            $script:StopReason = 'EDIT_START_DEADLINE_REACHED'
                            break
                        }
                    }
                }
                else {
                    # Post-edit no-progress is Writer-only and requires positive net change still present.
                    # Two consecutive successful-tool turns with no positive progress end as PARTIAL.
                    if ($Mode -eq 'Writer') {
                        if ($script:NoProgressRounds -ge 2) {
                            Add-RunnerWarning 'POST_EDIT_NO_PROGRESS_WARNING' 'Edits exist but recent turns produced no progress. Perform only necessary verification and return a completion report.'
                            $script:Messages += [ordered]@{
                                role    = 'system'
                                content = 'Edits have been made. If requested edits are complete, minimally verify and report; otherwise continue only the missing edit after required fresh reads.'
                            }
                            Add-RunnerError 'POST_EDIT_NO_PROGRESS_LIMIT_REACHED' 'No progress in consecutive turns after edits were made.'
                            $script:StopReason = 'POST_EDIT_NO_PROGRESS_LIMIT_REACHED'
                            break
                        }
                    }
                }
            }
            else {
                $script:NoProgressRounds = 0
                $script:FreshReadRecoveryTurn = $false
                if ($Mode -eq 'Writer' -and ($script:ConvergenceMode -eq 'forced-write' -or $script:ConvergenceMode -eq 'write-only')) {
                    $script:ConvergenceMode = 'normal'
                }
            }
            if ($script:TurnsUsed -ge $script:CheckpointTurn -and ($script:TurnsUsed % $script:ExtensionSize) -eq 0) {
                if (-not (Save-Checkpoint 'periodic')) {
                    Assert-CheckpointSuccessOrDemote -Saved $false -Context 'periodic'
                    break
                }
            }
        }
        if (-not $DirectResponse -and -not $script:CheckpointFailure -and $script:TurnsUsed -gt 0 -and -not $script:CheckpointSaved) {
            if (-not (Save-Checkpoint 'stopped')) {
                Assert-CheckpointSuccessOrDemote -Saved $false -Context 'stopped'
            }
        }
        if ($script:CheckpointFailure) {
            Assert-CheckpointSuccessOrDemote -Saved $false -Context 'final'
        }
        if ($script:Status -eq 'FAIL') {
            if ($script:EditCount -gt 0) {
                $script:Status = 'PARTIAL_AFTER_EDIT'
                $script:ExitCode = 2
            }
            elseif ($script:LeadingToolFailure) {
                $script:Status = 'PARTIAL'
                $script:ExitCode = 2
            }
            else {
                $script:ExitCode = 1
            }
        }
    }
}
catch {
    Add-RunnerError $_.Exception.Message $_.Exception.ToString()
    $script:Status = 'FAIL'
    $script:ExitCode = 1
    if ([string]::IsNullOrWhiteSpace($script:StopReason)) {
        $script:StopReason = $_.Exception.Message
    }
}
finally {
    if ($script:CheckpointFailure -and ($script:Status -eq 'PASS' -or $script:ExitCode -eq 0)) {
        Assert-CheckpointSuccessOrDemote -Saved $false -Context 'emit'
    }
    $result = Get-ResultObject $script:Status
    $result.exit_code = $script:ExitCode
    Emit-Result $result
    exit $script:ExitCode
}
