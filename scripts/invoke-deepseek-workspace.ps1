[CmdletBinding()]
param(
    [string]$RepositoryRoot = '',
    [ValidateSet('ReadOnly', 'Writer')]
    [string]$Mode = 'ReadOnly',
    [ValidateSet('DeepSeek', 'OpenRouter')]
    [string]$Provider = 'DeepSeek',
    [string[]]$AllowPath,
    [string]$EnvFile = '',
    [switch]$DryRun,
    [string]$Prompt = '',
    [string]$Model = '',
    [ValidateRange(1, 96)]
    [int]$MaxTurns = 48,
    [ValidateRange(1, 64)]
    [int]$MaxReadToolCalls = 12,
    [ValidateRange(128, 32768)]
    [int]$MaxTokens = 16384,
    [ValidateSet('low', 'high', 'max')]
    [string]$ReasoningEffort = 'high',
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
    [string]$MockResponsesPath = ''
)

$ErrorActionPreference = 'Stop'

$script:RunnerName = 'deepseek-workspace-runner'
$script:RunnerVersion = '2.0.0'
$script:SchemaVersion = '2.0.0'
$script:ProviderContextLimit = 1000000
$script:ContextSoftLimit = 600000
$script:ContextHardLimit = 800000
$script:OutputReserveTokens = 128000
$script:HardTurnLimit = 96
$script:ExtensionSize = 8
$script:CheckpointTurn = 64
$script:SoftTurn = 80
$script:Mode = $Mode
$script:Provider = $Provider
$script:TimeoutSeconds = 0
$script:AllowRoots = @()
$script:AllowPathDisplay = @()
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
$script:EditCount = 0
$script:PatchCount = 0
$script:ReadCallCount = 0
$script:ToolCallCount = 0
$script:ToolCallsByName = [ordered]@{}
$script:ToolCallSequence = @()
$script:ChangedPaths = [ordered]@{}
$script:ChangedFileHashes = [ordered]@{}
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

function Redact-Text {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) {
        return $null
    }
    $text = [string]$Value
    if ([string]::IsNullOrEmpty($text)) {
        return $text
    }
    $redacted = [regex]::Replace(
        $text,
        '(?i)(api[_-]?key|authorization|access[_-]?token|secret|password)\s*[:=]\s*["'']?[^,\s"''}\]]+',
        '[REDACTED]'
    )
    $redacted = [regex]::Replace($redacted, '(?i)\bsk-[A-Za-z0-9_-]{8,}\b', '[REDACTED]')
    return $redacted
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
    return $full
}

function Get-RelativePathFromFull {
    param([string]$FullPath)
    $rootUri = New-Object System.Uri(($script:RepositoryRoot.TrimEnd('\') + '\'))
    $fileUri = New-Object System.Uri($FullPath)
    $relative = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($fileUri).ToString())
    return (Get-NormalizedRelativePath $relative)
}

function Test-AllowedRelativePath {
    param([string]$RelativePath)
    $relative = Get-NormalizedRelativePath $RelativePath
    if (Test-SensitiveRelativePath $relative) {
        return $false
    }
    if ($script:AllowRoots.Count -eq 0) {
        return $false
    }
    foreach ($root in $script:AllowRoots) {
        if ($root -eq '.') {
            return $true
        }
        if ($relative -eq $root -or $relative.StartsWith($root.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Get-AllowedFiles {
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($root in $script:AllowRoots) {
        $full = Get-FullPathFromRelative $root
        if (-not (Test-Path -LiteralPath $full)) {
            continue
        }
        $item = Get-Item -LiteralPath $full
        if ($item.PSIsContainer) {
            $children = Get-ChildItem -LiteralPath $full -File -Recurse -Force -ErrorAction Stop
            foreach ($child in $children) {
                $relative = Get-RelativePathFromFull $child.FullName
                if (-not (Test-SensitiveRelativePath $relative)) {
                    [void]$files.Add([pscustomobject]@{ relative = $relative; full = $child.FullName })
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
    foreach ($file in (Get-AllowedFiles)) {
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
    foreach ($root in $script:AllowRoots) {
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
        $diffLines = @(& git -C $script:RepositoryRoot diff --binary --no-ext-diff -- . 2>$null | ForEach-Object { [string]$_ })
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            return $null
        }
        return (Get-Sha256Text ([string]::Join([Environment]::NewLine, $diffLines)))
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

function Write-AtomicText {
    param(
        [string]$Path,
        [string]$Text
    )
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    $temp = Join-Path $directory ('.runner-write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $encoding = New-Object System.Text.UTF8Encoding($false)
    try {
        [System.IO.File]::WriteAllText($temp, $Text, $encoding)
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

function Invoke-WorkspaceStatusTool {
    $snapshot = Get-WorkspaceSnapshot
    return (New-ToolSuccess ([ordered]@{
        ok = $true
        head = (Get-GitHead)
        git_metadata = if ((Get-GitHead) -eq 'GIT_METADATA_UNAVAILABLE') { 'GIT_METADATA_UNAVAILABLE' } else { 'AVAILABLE' }
        fingerprint = $snapshot.fingerprint
        allowlist = @($script:AllowPathDisplay)
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
    if (-not (Test-AllowedRelativePath $relative)) {
        return (New-ToolFailure 'PATH_NOT_ALLOWLISTED')
    }
    try {
        $full = Get-FullPathFromRelative $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            return (New-ToolFailure 'FILE_NOT_FOUND')
        }
        $item = Get-Item -LiteralPath $full
        if ($item.Length -gt 1048576) {
            return (New-ToolFailure 'FILE_TOO_LARGE')
        }
        $content = [System.IO.File]::ReadAllText($full)
        return (New-ToolSuccess ([ordered]@{
            path = $relative
            bytes = $item.Length
            content = (Redact-Text $content)
        }))
    }
    catch {
        return (New-ToolFailure 'READ_FAILED' $_.Exception.Message)
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
        foreach ($file in (Get-AllowedFiles)) {
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
        return (New-ToolFailure 'SEARCH_FAILED' $_.Exception.Message)
    }
}

function Set-ChangedFileState {
    param([string]$RelativePath)
    $script:ChangedPaths[$RelativePath] = $true
    $snapshot = Get-WorkspaceSnapshot
    $script:ExpectedFingerprint = $snapshot.fingerprint
    if ($snapshot.file_hashes.Contains($RelativePath)) {
        $script:ChangedFileHashes[$RelativePath] = $snapshot.file_hashes[$RelativePath]
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
    $relative = Get-NormalizedRelativePath $relative
    if (-not (Test-AllowedRelativePath $relative)) {
        return (New-ToolFailure 'PATH_NOT_ALLOWLISTED')
    }
    if (-not (Test-ExpectedFingerprint)) {
        return (New-ToolFailure 'WORKSPACE_FINGERPRINT_MISMATCH')
    }
    try {
        $full = Get-FullPathFromRelative $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            return (New-ToolFailure 'FILE_NOT_FOUND')
        }
        $current = [System.IO.File]::ReadAllText($full)
        $first = $current.IndexOf($oldText, [System.StringComparison]::Ordinal)
        if ($first -lt 0) {
            return (New-ToolFailure 'OLD_TEXT_NOT_FOUND')
        }
        $second = $current.IndexOf($oldText, $first + $oldText.Length, [System.StringComparison]::Ordinal)
        if ($second -ge 0) {
            return (New-ToolFailure 'OLD_TEXT_NOT_UNIQUE')
        }
        $updated = $current.Substring(0, $first) + $newText + $current.Substring($first + $oldText.Length)
        if ($DryRun) {
            return (New-ToolSuccess ([ordered]@{
                path = $relative
                dry_run = $true
                changed = $false
            }))
        }
        Write-AtomicText -Path $full -Text $updated
        $script:EditCount++
        Set-ChangedFileState $relative
        $hash = Get-FileSha256 $full
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
        return (New-ToolFailure 'WRITE_FAILED' $_.Exception.Message)
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
    $updateIndexes = @()
    $addIndexes = @()
    for ($i = 1; $i -lt ($lines.Count - 1); $i++) {
        if ($lines[$i].StartsWith('*** Update File: ')) {
            $updateIndexes += $i
        }
        elseif ($lines[$i].StartsWith('*** Add File: ')) {
            $addIndexes += $i
        }
    }
    if (($updateIndexes.Count + $addIndexes.Count) -ne 1) {
        return (New-ToolFailure 'PATCH_SINGLE_FILE_ONLY')
    }
    $marker = if ($updateIndexes.Count -eq 1) { $lines[$updateIndexes[0]] } else { $lines[$addIndexes[0]] }
    $relative = Get-NormalizedRelativePath ($marker.Substring($marker.IndexOf(':') + 1).Trim())
    if (-not (Test-AllowedRelativePath $relative)) {
        return (New-ToolFailure 'PATH_NOT_ALLOWLISTED')
    }
    if (-not (Test-ExpectedFingerprint)) {
        return (New-ToolFailure 'WORKSPACE_FINGERPRINT_MISMATCH')
    }
    try {
        $full = Get-FullPathFromRelative $relative
        if ($addIndexes.Count -eq 1) {
            if (Test-Path -LiteralPath $full) {
                return (New-ToolFailure 'PATCH_TARGET_EXISTS')
            }
            $addStart = $addIndexes[0] + 1
            $addLines = New-Object System.Collections.Generic.List[string]
            for ($j = $addStart; $j -lt ($lines.Count - 1); $j++) {
                if (-not $lines[$j].StartsWith('+')) {
                    return (New-ToolFailure 'PATCH_ADD_LINE_INVALID')
                }
                [void]$addLines.Add($lines[$j].Substring(1))
            }
            $newText = [string]::Join([Environment]::NewLine, @($addLines))
            if (-not $DryRunOnly) {
                Write-AtomicText -Path $full -Text $newText
                $script:EditCount++
                Set-ChangedFileState $relative
                $script:ChangedFileHashes[$relative] = Get-FileSha256 $full
            }
            return [pscustomobject]@{
                ok = $true
                result = [ordered]@{ path = $relative; changed = (-not $DryRunOnly); dry_run = $DryRunOnly }
                error_code = $null
                error_detail = $null
                changed = (-not $DryRunOnly)
            }
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            return (New-ToolFailure 'FILE_NOT_FOUND')
        }
        $currentText = [System.IO.File]::ReadAllText($full)
        $crlf = ([string][char]13) + ([string][char]10)
        $normalized = $currentText.Replace($crlf, ([string][char]10)).Replace([char]13, [char]10)
        $cursor = $updateIndexes[0] + 1
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
        for ($j = $cursor; $j -lt ($lines.Count - 1); $j++) {
            $line = $lines[$j]
            if ($line.StartsWith('@@')) {
                & $flush
                continue
            }
            if ($line.StartsWith('***')) {
                continue
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
                return (New-ToolFailure 'PATCH_HUNK_LINE_INVALID')
            }
        }
        & $flush
        if ($hunks.Count -eq 0) {
            return (New-ToolFailure 'PATCH_HUNK_MISSING')
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
        $updated = if ($currentText.Contains($crlf)) { $normalized.Replace(([string][char]10), $crlf) } else { $normalized }
        if ($DryRunOnly) {
            return [pscustomobject]@{
                ok = $true
                result = [ordered]@{ path = $relative; changed = $false; dry_run = $true }
                error_code = $null
                error_detail = $null
                changed = $false
            }
        }
        Write-AtomicText -Path $full -Text $updated
        $script:EditCount++
        $script:PatchCount++
        Set-ChangedFileState $relative
        $script:ChangedFileHashes[$relative] = Get-FileSha256 $full
        return [pscustomobject]@{
            ok = $true
            result = [ordered]@{ path = $relative; changed = $true; dry_run = $false; sha256 = $script:ChangedFileHashes[$relative] }
            error_code = $null
            error_detail = $null
            changed = $true
        }
    }
    catch {
        return (New-ToolFailure 'PATCH_FAILED' $_.Exception.Message)
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
            return (Invoke-ReplaceTextTool $Arguments)
        }
        'apply_patch' {
            if ($Mode -ne 'Writer') {
                return (New-ToolFailure 'WRITER_TOOL_NOT_ALLOWED')
            }
            return (Invoke-ApplyPatchTool $Arguments)
        }
        default {
            return (New-ToolFailure 'TOOL_NOT_ALLOWED' $Name)
        }
    }
}

function Get-ToolDefinitions {
    $definitions = New-Object System.Collections.Generic.List[object]
    [void]$definitions.Add([ordered]@{
        type = 'function'
        function = [ordered]@{
            name = 'workspace_status'
            description = 'Return safe workspace fingerprint and Git metadata status.'
            parameters = [ordered]@{ type = 'object'; properties = [ordered]@{}; additionalProperties = $false }
        }
    })
    [void]$definitions.Add([ordered]@{
        type = 'function'
        function = [ordered]@{
            name = 'read_file'
            description = 'Read one allowlisted relative text file.'
            parameters = [ordered]@{
                type = 'object'
                properties = [ordered]@{ path = [ordered]@{ type = 'string' } }
                required = @('path')
                additionalProperties = $false
            }
        }
    })
    [void]$definitions.Add([ordered]@{
        type = 'function'
        function = [ordered]@{
            name = 'search_text'
            description = 'Search literal text in allowlisted files.'
            parameters = [ordered]@{
                type = 'object'
                properties = [ordered]@{ pattern = [ordered]@{ type = 'string' } }
                required = @('pattern')
                additionalProperties = $false
            }
        }
    })
    if ($Mode -eq 'Writer') {
        [void]$definitions.Add([ordered]@{
            type = 'function'
            function = [ordered]@{
                name = 'replace_text'
                description = 'Replace exactly one occurrence in one allowlisted file.'
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
        [void]$definitions.Add([ordered]@{
            type = 'function'
            function = [ordered]@{
                name = 'apply_patch'
                description = 'Apply one bounded single-file patch in the allowlist.'
                parameters = [ordered]@{
                    type = 'object'
                    properties = [ordered]@{ patch = [ordered]@{ type = 'string' } }
                    required = @('patch')
                    additionalProperties = $false
                }
            }
        })
    }
    return @($definitions)
}

function New-InitialMessages {
    $system = 'You are the single sequential workspace Writer. One model response is one turn. Use only the provided tools; there is no shell, command runner, commit, stage, push, dependency installation, or recursive runner. Respect the allowlist. Read before editing, make minimal changes, and stop with a concise completion report only after the requested work is actually complete. A tool failure stops the turn and all later writes.'
    $user = [string]$Prompt
    return @(
        [ordered]@{ role = 'system'; content = $system },
        [ordered]@{ role = 'user'; content = $user }
    )
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
    if ($null -ne $Message.tool_calls) {
        $assistant.tool_calls = @($Message.tool_calls)
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
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) {
        return $null
    }
    try {
        $json = ConvertTo-Json $Value -Depth 30 -Compress
        $json = Redact-Text $json
        return ($json | ConvertFrom-Json)
    }
    catch {
        return (Redact-Text ([string]$Value))
    }
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
    try {
        $snapshot = Get-WorkspaceSnapshot
        $safeMessages = Convert-ToSafeObject @($script:Messages)
        $data = [ordered]@{
            schema_version = $script:SchemaVersion
            runner = $script:RunnerName
            runner_version = $script:RunnerVersion
            task_id = $script:TaskId
            provider = $script:Provider
            model = $script:Model
            mode = $script:Mode
            allowlist = @($script:AllowPathDisplay)
            workspace_fingerprint = $script:ExpectedFingerprint
            base_head = $script:BaseHead
            final_head = (Get-GitHead)
            workspace_diff_sha256 = (Get-GitDiffHash)
            changed_file_hashes = $script:ChangedFileHashes
            committed = $false
            turn = $script:TurnsUsed
            next_turn = ($script:TurnsUsed + 1)
            effective_max_turns = $script:EffectiveMaxTurns
            hard_turn_limit = $script:HardTurnLimit
            extensions_used = $script:ExtensionsUsed
            no_progress_rounds = $script:NoProgressRounds
            latest_prompt_tokens = $script:LatestPromptTokens
            latest_context_tokens = $script:LatestContextTokens
            checkpoint_round = ($script:CheckpointRound + 1)
            checkpoint_reason = $Reason
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
        $script:CheckpointRound++
        $script:LastCheckpointEditCount = $script:EditCount
        $script:CheckpointSaved = $true
        return $true
    }
    catch {
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
        $savedAllow = @($data.allowlist | ForEach-Object { [string]$_ })
        if ((ConvertTo-Json $savedAllow -Compress) -ne (ConvertTo-Json @($script:AllowPathDisplay) -Compress)) {
            throw 'CHECKPOINT_ALLOWLIST_MISMATCH'
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
        $script:ExpectedFingerprint = [string]$data.workspace_fingerprint
        $script:TaskId = [string]$data.task_id
        $script:Messages = @($data.messages)
        $script:TurnsUsed = [int]$data.turn
        $script:EffectiveMaxTurns = [Math]::Min($HardTurnLimit, [Math]::Max($MaxTurns, [int]$data.effective_max_turns))
        $script:ExtensionsUsed = [int]$data.extensions_used
        $script:NoProgressRounds = [int]$data.no_progress_rounds
        $script:LatestPromptTokens = [int64]$data.latest_prompt_tokens
        $script:LatestContextTokens = [int64]$data.latest_context_tokens
        $script:CheckpointRound = [int]$data.checkpoint_round
        return $true
    }
    catch {
        Add-RunnerError $_.Exception.Message
        $script:StopReason = $_.Exception.Message
        return $false
    }
}

function Invoke-ModelRequest {
    if ($TestMode) {
        if ($script:MockIndex -ge $script:MockResponses.Count) {
            return [pscustomobject]@{
                __runner_error = 'MOCK_RESPONSES_EXHAUSTED'
            }
        }
        $response = $script:MockResponses[$script:MockIndex]
        $script:MockIndex++
        return $response
    }
    try {
        $body = [ordered]@{
            model = $script:Model
            messages = @($script:Messages)
            tools = @(Get-ToolDefinitions)
            tool_choice = 'auto'
            max_tokens = $MaxTokens
            temperature = 0
            stream = $false
            reasoning_effort = $ReasoningEffort
        }
        if ($script:Provider -eq 'DeepSeek') {
            $body.thinking = [ordered]@{ type = 'enabled' }
        }
        $json = ConvertTo-Json $body -Depth 40
        $headers = @{ Authorization = ('Bearer ' + $script:ApiKey) }
        return Invoke-RestMethod -Method Post -Uri $script:Endpoint -Headers $headers -ContentType 'application/json' -Body $json -TimeoutSec $script:TimeoutSeconds
    }
    catch {
        return [pscustomobject]@{
            __runner_error = 'MODEL_REQUEST_FAILED'
            __runner_detail = (Redact-Text $_.Exception.Message)
        }
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
    if ($RequestTimeoutSeconds -ne 0 -and ($RequestTimeoutSeconds -lt 30 -or $RequestTimeoutSeconds -gt 600)) {
        throw 'REQUEST_TIMEOUT_OUT_OF_RANGE'
    }
    if ([string]::IsNullOrWhiteSpace($Model)) {
        $Model = if ($Provider -eq 'DeepSeek') { 'deepseek-v4-pro' } else { 'anthropic/claude-opus-5' }
    }
    if ($Provider -eq 'DeepSeek' -and $Model -eq 'deepseek-v4-flash') {
        throw 'MODEL_NOT_ALLOWED'
    }
    $script:Model = $Model
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
    $script:AllowRoots = @()
    if ($null -ne $AllowPath) {
        foreach ($requestedPath in @($AllowPath)) {
            $relative = Get-NormalizedRelativePath $requestedPath
            if ([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|\\)\.\.(\\|$)') {
                throw 'ALLOWLIST_PATH_INVALID'
            }
            if (Test-SensitiveRelativePath $relative) {
                throw 'ALLOWLIST_SENSITIVE_PATH'
            }
            if ($script:AllowRoots -notcontains $relative) {
                $script:AllowRoots += $relative
            }
        }
    }
    $script:AllowPathDisplay = @($script:AllowRoots)
    if ($Mode -eq 'Writer' -and $script:AllowRoots.Count -eq 0) {
        throw 'WRITER_ALLOWLIST_REQUIRED'
    }
    $script:CheckpointPathResolved = Get-CheckpointPath $CheckpointPath
    $script:ExpectedFingerprint = (Get-WorkspaceSnapshot).fingerprint
    $script:MockResponses = @(Load-MockResponses)
    if (-not [string]::IsNullOrWhiteSpace($MockResponsesPath) -and -not $TestMode) {
        throw 'MOCK_REQUIRES_TEST_MODE'
    }
    if ($OfflineConfig) {
        $script:Status = 'OFFLINE_CONFIG'
        $script:ExitCode = 0
        $script:StopReason = 'OFFLINE_CONFIG'
    }
    else {
        if ([string]::IsNullOrWhiteSpace($Prompt) -and [string]::IsNullOrWhiteSpace($ResumeCheckpoint)) {
            throw 'PROMPT_REQUIRED'
        }
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
            $script:Messages = New-InitialMessages
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
                $eligible = ($script:EffectiveMaxTurns -lt $script:HardTurnLimit) -and
                    ($script:EditCount -gt $script:LastExtensionEditCount) -and
                    (-not $script:LeadingToolFailure) -and
                    (-not $script:CheckpointFailure) -and
                    (Test-ExpectedFingerprint)
                if ($eligible) {
                    $script:EffectiveMaxTurns = [Math]::Min($script:HardTurnLimit, $script:EffectiveMaxTurns + $script:ExtensionSize)
                    $script:ExtensionsUsed++
                    $script:LastExtensionEditCount = $script:EditCount
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
            $response = $null
            $script:RequestCount++
            $response = Invoke-ModelRequest
            if ($null -ne $response.__runner_error) {
                Add-RunnerError ([string]$response.__runner_error) ([string]$response.__runner_detail)
                $script:StopReason = [string]$response.__runner_error
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
            $script:FinishReasons += if ($null -ne $response.choices -and $null -ne $response.choices[0].finish_reason) { [string]$response.choices[0].finish_reason } else { 'unknown' }
            Add-AssistantMessage $message
            $toolCalls = @()
            if ($null -ne $message.tool_calls) {
                $toolCalls = @($message.tool_calls)
            }
            $turnEditStart = $script:EditCount
            if ($toolCalls.Count -eq 0) {
                if ($null -ne $message.content -and -not [string]::IsNullOrWhiteSpace([string]$message.content)) {
                    $script:FinalResponse = [string]$message.content
                    if ($script:LeadingToolFailure -or $script:Errors.Count -gt 0) {
                        $script:Status = 'PARTIAL'
                        $script:ExitCode = 2
                    }
                    else {
                        $script:Status = 'PASS'
                        $script:ExitCode = 0
                    }
                    $script:StopReason = 'MODEL_COMPLETED'
                    [void](Save-Checkpoint 'completed')
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
            foreach ($toolCall in $toolCalls) {
                if ($script:LeadingToolFailure) {
                    break
                }
                $toolResult = $null
                $name = Get-ToolCallName $toolCall
                $id = if ($null -ne $toolCall.id) { [string]$toolCall.id } else { 'tool-' + ($script:ToolCallCount + 1) }
                $script:ToolCallCount++
                if (-not $script:ToolCallsByName.Contains($name)) {
                    $script:ToolCallsByName[$name] = 0
                }
                $args = $null
                try {
                    $args = Convert-ArgumentsObject $toolCall
                }
                catch {
                    $toolResult = New-ToolFailure 'TOOL_ARGUMENTS_INVALID_JSON'
                    $script:LeadingToolFailure = $true
                    Add-RunnerError 'TOOL_ARGUMENTS_INVALID_JSON'
                }
                if ($null -eq $toolResult) {
                    $toolResult = Invoke-WorkspaceTool -Name $name -Arguments $args
                }
                $script:ToolCallSequence += [ordered]@{
                    turn = $script:TurnsUsed
                    tool_call_id = $id
                    name = $name
                    ok = [bool]$toolResult.ok
                    changed = [bool]$toolResult.changed
                }
                if ($toolResult.ok) {
                    $script:ToolCallsByName[$name] = [int]$script:ToolCallsByName[$name] + 1
                }
                $toolContent = ConvertTo-Json (Convert-ToSafeObject $toolResult.result) -Depth 30 -Compress
                $script:Messages += [ordered]@{
                    role = 'tool'
                    tool_call_id = $id
                    content = (Redact-Text $toolContent)
                }
                if (-not $toolResult.ok) {
                    $script:LeadingToolFailure = $true
                    Add-RunnerError ([string]$toolResult.error_code) ([string]$toolResult.error_detail)
                    $script:StopReason = 'LEADING_TOOL_FAILURE'
                    break
                }
                if ($toolResult.changed -and $script:EditCount -gt $script:LastCheckpointEditCount) {
                    if (-not (Save-Checkpoint 'successful_write')) {
                        $script:StopReason = 'CHECKPOINT_WRITE_FAILED'
                        break
                    }
                }
            }
            if ($script:LeadingToolFailure -or $script:CheckpointFailure) {
                break
            }
            if ($script:EditCount -eq $turnEditStart) {
                $script:NoProgressRounds++
                if ($script:NoProgressRounds -ge 2) {
                    Add-RunnerWarning 'NO_PROGRESS_WARNING' 'Two complete turns produced no objective edit progress.'
                }
                if ($script:NoProgressRounds -ge 4) {
                    Add-RunnerError 'NO_PROGRESS_LIMIT_REACHED' 'Four complete turns produced no objective edit progress.'
                    $script:StopReason = 'NO_PROGRESS_LIMIT_REACHED'
                    break
                }
            }
            else {
                $script:NoProgressRounds = 0
            }
            if ($script:TurnsUsed -ge $script:CheckpointTurn -and ($script:TurnsUsed % $script:ExtensionSize) -eq 0) {
                if (-not (Save-Checkpoint 'periodic')) {
                    $script:StopReason = 'CHECKPOINT_WRITE_FAILED'
                    break
                }
            }
        }
        if (-not $script:CheckpointFailure -and $script:TurnsUsed -gt 0 -and -not $script:CheckpointSaved) {
            [void](Save-Checkpoint 'stopped')
        }
        if ($script:Status -eq 'FAIL') {
            if ($script:LeadingToolFailure -or $script:EditCount -gt 0) {
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
    $result = Get-ResultObject $script:Status
    $result.exit_code = $script:ExitCode
    Emit-Result $result
    exit $script:ExitCode
}
