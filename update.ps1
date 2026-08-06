# DevBrowser Local Rebuild and Update Script

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  DevBrowser Installer Rebuild & Updater   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check dependencies
Write-Host "[1/3] Checking and installing dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install dependencies."
    Exit $LASTEXITCODE
}

# Step 2: Build the distribution packages
Write-Host "[2/3] Building new installer packages..." -ForegroundColor Yellow
npm run dist
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to compile the distribution packages."
    Exit $LASTEXITCODE
}

# Step 3: Run the installer to perform the update
$InstallerPath = "dist\DevBrowser Setup 1.0.0.exe"
if (Test-Path $InstallerPath) {
    Write-Host "[3/3] Launching installer to update DevBrowser..." -ForegroundColor Green
    Write-Host "The installer will open shortly. Please complete the setup wizard to update your installed version." -ForegroundColor Gray
    
    # Launch NSIS installer (will overwrite existing installation, maintaining preferences)
    Start-Process $InstallerPath
} else {
    Write-Error "Could not find the compiled installer at: $InstallerPath"
    Exit 1
}

Write-Host ""
Write-Host "Update script finished successfully!" -ForegroundColor Green
