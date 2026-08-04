param(
    [switch]$RequirePostgres
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$PythonExe = Join-Path $WorkspaceRoot "backend\.venv\Scripts\python.exe"
$NpmExe = "C:\Program Files\nodejs\npm.cmd"
$env:Path = "$(Split-Path -Parent $NpmExe);$env:Path"

Push-Location (Join-Path $WorkspaceRoot "backend")
try {
    & $PythonExe -m ruff check app tests alembic
    if ($LASTEXITCODE -ne 0) { throw "Ruff failed" }
    & $PythonExe -m mypy app
    if ($LASTEXITCODE -ne 0) { throw "mypy failed" }
    & $PythonExe -m pytest -q
    if ($LASTEXITCODE -ne 0) { throw "pytest failed" }

    if ($RequirePostgres) {
        if (-not $env:SSWCENTER_DATABASE_URL) {
            throw "SSWCENTER_DATABASE_URL is required for PostgreSQL integration tests"
        }
        if ($env:SSWCENTER_DATABASE_URL -notmatch '(_test|_review)(\?|$)') {
            throw "PostgreSQL integration target must end with _test or _review"
        }
        & $PythonExe -m alembic -c alembic.ini upgrade head
        if ($LASTEXITCODE -ne 0) { throw "Alembic upgrade failed" }
        & $PythonExe -m alembic -c alembic.ini current
        if ($LASTEXITCODE -ne 0) { throw "Alembic current failed" }
    }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $WorkspaceRoot "frontend")
try {
    & $NpmExe run lint
    if ($LASTEXITCODE -ne 0) { throw "Frontend lint failed" }
    & $NpmExe run test
    if ($LASTEXITCODE -ne 0) { throw "Frontend unit tests failed" }
    & $NpmExe run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
    & $NpmExe run test:e2e
    if ($LASTEXITCODE -ne 0) { throw "Frontend Playwright smoke tests failed" }
}
finally {
    Pop-Location
}
