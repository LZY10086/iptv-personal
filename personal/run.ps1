$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath 'node_modules')) {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE"
        }
    }

    npm run personal:generate
    if ($LASTEXITCODE -ne 0) {
        throw "personal playlist generation failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
