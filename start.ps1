# Stagelight: start on Windows. The first run creates .venv and installs everything (a few minutes).
#   powershell -ExecutionPolicy Bypass -File start.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$py = ".venv\Scripts\python.exe"
$cpuTorch = "https://download.pytorch.org/whl/cpu"

if (-not (Test-Path $py)) {
    Write-Host "First run: setting up Python environment..." -ForegroundColor Magenta
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        uv venv --python 3.12 .venv
        uv pip install --python $py -r requirements.txt --extra-index-url $cpuTorch --index-strategy unsafe-best-match
    } else {
        py -3.12 -m venv .venv
        & $py -m pip install --upgrade pip
        & $py -m pip install -r requirements.txt --extra-index-url $cpuTorch
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Get-Command deno -ErrorAction SilentlyContinue)) {
    Write-Host "Tip: install Node.js or Deno. YouTube downloads need a JavaScript runtime." -ForegroundColor Yellow
}

Write-Host "Stagelight is running at http://localhost:8765 (Ctrl+C to stop)" -ForegroundColor Magenta
Start-Job { Start-Sleep 3; Start-Process "http://localhost:8765" } | Out-Null
& $py -m uvicorn server:app --port 8765
