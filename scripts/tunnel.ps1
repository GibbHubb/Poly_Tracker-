<#
.SYNOPSIS
  Put Poly_Tracker online via a Cloudflare *named* tunnel (stable public URL).

.DESCRIPTION
  Brings up the production Docker stack (built PWA served by nginx on
  http://localhost:8080) and connects a Cloudflare named tunnel to it so the
  app is reachable at the public hostname you configured in the Cloudflare
  Zero Trust dashboard (e.g. https://poly.yourdomain.com).

  Unlike a quick tunnel (random *.trycloudflare.com URL that dies on stop),
  a named tunnel keeps the SAME URL across restarts. The connector token is
  read from .env as CLOUDFLARE_TUNNEL_TOKEN.

.PREREQUISITES (one-time, in the Cloudflare dashboard — see README "Public access")
  1. A domain added to your Cloudflare account.
  2. Zero Trust > Networks > Tunnels > Create a tunnel (Cloudflared).
  3. Add a Public Hostname: subdomain (e.g. "poly") -> Service http://localhost:8080
  4. Copy the connector token into .env as CLOUDFLARE_TUNNEL_TOKEN=...

.USAGE
  ./scripts/tunnel.ps1            # NAMED tunnel (stable URL) — needs CLOUDFLARE_TUNNEL_TOKEN + a domain on Cloudflare
  ./scripts/tunnel.ps1 -Quick     # QUICK tunnel — random *.trycloudflare.com URL, no domain/token needed
  ./scripts/tunnel.ps1 -NoStack   # skip starting the stack (it's already running)
#>
[CmdletBinding()]
param(
  [switch]$Quick,
  [switch]$NoStack
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# --- Resolve cloudflared (PATH, or the default MSI install location) ---
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  foreach ($p in @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe")) {
    if (Test-Path $p) { $cf = $p; break }
  }
}
if (-not $cf) { throw "cloudflared not found. Install it: winget install Cloudflare.cloudflared (then reopen the shell)." }

# --- Bring up the production stack (built PWA via nginx at :8080) ---
if (-not $NoStack) {
  Write-Host "Starting production stack (docker-compose.prod.yml)..." -ForegroundColor Cyan
  docker compose -f (Join-Path $repo 'docker-compose.prod.yml') --project-directory $repo up --build -d
}

if ($Quick) {
  # --- Quick tunnel: zero config, random URL printed below. Ctrl+C to stop. ---
  Write-Host "Opening Cloudflare QUICK tunnel -> http://localhost:8080 (random URL, changes each run)..." -ForegroundColor Cyan
  & $cf tunnel --url http://localhost:8080
}
else {
  # --- Named tunnel: stable URL from the token in .env. Ctrl+C to stop. ---
  $envFile = Join-Path $repo '.env'
  if (-not (Test-Path $envFile)) { throw ".env not found at $envFile — copy .env.example to .env first." }
  $envVars = @{}
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*)$') { $envVars[$matches[1]] = $matches[2].Trim() }
  }
  $token = $envVars['CLOUDFLARE_TUNNEL_TOKEN']
  if ([string]::IsNullOrWhiteSpace($token) -or $token -like '*your_*token*') {
    throw "CLOUDFLARE_TUNNEL_TOKEN is not set in .env. Either set it (see README 'Public access') or run with -Quick."
  }
  Write-Host "Connecting Cloudflare NAMED tunnel -> http://localhost:8080 ..." -ForegroundColor Cyan
  Write-Host "Public URL = the hostname you set in the Cloudflare dashboard. Ctrl+C to stop." -ForegroundColor Yellow
  & $cf tunnel run --token $token
}
