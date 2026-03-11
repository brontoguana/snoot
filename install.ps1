$ErrorActionPreference = "Stop"

$repo = "brontoguana/snoot"
$installDir = "$env:LOCALAPPDATA\snoot"

Write-Host "Installing Snoot..."
Write-Host ""

# Create install directory
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

# Download latest release
Write-Host "Downloading latest release..."
$url = "https://github.com/$repo/releases/latest/download/snoot-windows-x64.exe"
Invoke-WebRequest -Uri $url -OutFile "$installDir\snoot.exe" -UseBasicParsing
Write-Host "  Installed to $installDir\snoot.exe"

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$installDir;$userPath", "User")
    $env:PATH = "$installDir;$env:PATH"
    Write-Host "  Added $installDir to user PATH"
    Write-Host "  (restart your terminal for this to take effect in new windows)"
} else {
    Write-Host "  $installDir already in PATH"
}

# Check for Claude CLI
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "  Claude CLI found"
} else {
    Write-Host ""
    Write-Host "  Claude CLI not found"
    Write-Host "  Install it: npm install -g @anthropic-ai/claude-code"
    Write-Host "  Snoot will work once claude is on your PATH."
}

Write-Host ""
Write-Host "Done! Next steps:"
Write-Host "  snoot set-user <recipient-session-id>    # one-time setup"
Write-Host "  cd C:\your\project"
Write-Host "  snoot MyChannel                          # start a channel"
Write-Host ""
