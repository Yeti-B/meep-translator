$ErrorActionPreference = "Stop"
$ProxyDir = Join-Path $PSScriptRoot "proxy"

if (-not (Test-Path (Join-Path $ProxyDir ".env"))) {
  Copy-Item (Join-Path $ProxyDir ".env.example") (Join-Path $ProxyDir ".env")
  Write-Host "Created proxy\.env. Put your OPENAI_API_KEY in that file, then run this script again."
  exit 1
}

$EnvPath = Join-Path $ProxyDir ".env"
$ProxyLine = Get-Content -LiteralPath $EnvPath |
  Where-Object { $_ -match '^\s*OPENAI_HTTP_PROXY\s*=' } |
  Select-Object -First 1

if ($ProxyLine) {
  $ProxyValue = ($ProxyLine -replace '^\s*OPENAI_HTTP_PROXY\s*=\s*', '').Trim().Trim('"').Trim("'")
  if ($ProxyValue) {
    $env:HTTP_PROXY = $ProxyValue
    $env:HTTPS_PROXY = $ProxyValue
    Write-Host "Using HTTP proxy: $ProxyValue"
  }
}

node --use-env-proxy (Join-Path $ProxyDir "server.js")
