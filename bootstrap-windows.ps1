[CmdletBinding()]
param(
  [string]$ProjectDirectory = "",
  [string]$Ref = "main",
  [switch]$Copilot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Repository = "KevinYoung23/Canvasly"
$TemporaryDirectory = $null

if ([string]::IsNullOrWhiteSpace($ProjectDirectory)) {
  $ProjectDirectory = Join-Path $HOME "Canvasly"
}
$ProjectDirectory = [System.IO.Path]::GetFullPath($ProjectDirectory)

if ($Ref -notmatch "^[A-Za-z0-9._/-]+$") {
  throw "The Git ref contains unsupported characters: $Ref"
}

function Write-CanvaslyStep {
  param([string]$Message)
  Write-Host ""
  Write-Host "[Canvasly] $Message" -ForegroundColor Cyan
}

function Test-CanvaslyProject {
  param([string]$Path)
  return (
    (Test-Path -LiteralPath (Join-Path $Path "compose.yaml") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Path "install.ps1") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Path "package.json") -PathType Leaf)
  )
}

function Get-TemporaryDirectory {
  if (-not $script:TemporaryDirectory) {
    $script:TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) (
      "canvasly-bootstrap-" + [System.Guid]::NewGuid().ToString("N")
    )
    New-Item -ItemType Directory -Path $script:TemporaryDirectory | Out-Null
  }
  return $script:TemporaryDirectory
}

function Install-CanvaslyProject {
  param([string]$Destination)

  if (Test-CanvaslyProject $Destination) {
    Write-CanvaslyStep "Using the existing Canvasly project at $Destination"
    return
  }

  if (Test-Path -LiteralPath $Destination) {
    throw @"
The install location already exists but is not a Canvasly project:
  $Destination
Move or rename that folder, then run this installer again.
"@
  }

  $temp = Get-TemporaryDirectory
  $archive = Join-Path $temp "canvasly.zip"
  $expanded = Join-Path $temp "expanded"
  $archiveUrl = "https://codeload.github.com/$Repository/zip/refs/heads/$Ref"

  Write-CanvaslyStep "Downloading Canvasly"
  $oldProgressPreference = $ProgressPreference
  try {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archive
  }
  finally {
    $ProgressPreference = $oldProgressPreference
  }

  Expand-Archive -LiteralPath $archive -DestinationPath $expanded
  $roots = @(Get-ChildItem -LiteralPath $expanded -Directory)
  if ($roots.Count -ne 1 -or -not (Test-CanvaslyProject $roots[0].FullName)) {
    throw "The downloaded archive is not a valid Canvasly project."
  }

  $parent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  Move-Item -LiteralPath $roots[0].FullName -Destination $Destination
  Write-CanvaslyStep "Canvasly was installed at $Destination"
}

function Get-DockerDesktopPath {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
    (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  return $null
}

function Get-DockerExecutable {
  $command = Get-Command "docker.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"),
    (Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  return $null
}

function Test-DockerReady {
  param([string]$DockerExecutable)
  if ([string]::IsNullOrWhiteSpace($DockerExecutable)) {
    return $false
  }
  & $DockerExecutable info *> $null
  return $LASTEXITCODE -eq 0
}

function Test-WslReady {
  $wsl = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
  if (-not $wsl) {
    return $false
  }
  & $wsl.Source --version *> $null
  return $LASTEXITCODE -eq 0
}

function Enable-Wsl {
  if (Test-WslReady) {
    return
  }

  $wsl = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
  if (-not $wsl) {
    throw "WSL 2 is unavailable. Install current Windows updates, restart, and run this installer again."
  }

  Write-CanvaslyStep "Enabling WSL 2 (Windows will ask for administrator approval)"
  $process = Start-Process -FilePath $wsl.Source -Verb RunAs -Wait -PassThru -ArgumentList @(
    "--install",
    "--no-distribution"
  )
  if (Test-WslReady) {
    return
  }

  $updateProcess = Start-Process -FilePath $wsl.Source -Verb RunAs -Wait -PassThru -ArgumentList @(
    "--update"
  )
  if (Test-WslReady) {
    return
  }

  if ($process.ExitCode -ne 0 -and $updateProcess.ExitCode -ne 0) {
    throw "WSL 2 installation failed or was cancelled."
  }

  throw @"
Canvasly and Docker Desktop are installed, but Windows must restart to finish enabling WSL 2.
Restart Windows, then run the same Canvasly installer command again.
"@
}

function Install-DockerDesktop {
  $architecture = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
  }
  else {
    $env:PROCESSOR_ARCHITECTURE
  }

  switch ($architecture.ToUpperInvariant()) {
    "AMD64" {
      $dockerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
    }
    "ARM64" {
      $dockerUrl = "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
    }
    default {
      throw "Docker Desktop does not support this Windows architecture: $architecture"
    }
  }

  $dockerInstaller = Join-Path (Get-TemporaryDirectory) "Docker Desktop Installer.exe"
  Write-CanvaslyStep "Downloading Docker Desktop from docker.com"
  Write-Host "The Docker Desktop download can take several minutes."
  $oldProgressPreference = $ProgressPreference
  try {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -UseBasicParsing -Uri $dockerUrl -OutFile $dockerInstaller
  }
  finally {
    $ProgressPreference = $oldProgressPreference
  }

  $signature = Get-AuthenticodeSignature -FilePath $dockerInstaller
  if (
    $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    -not $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -notmatch "Docker"
  ) {
    throw "The downloaded Docker Desktop installer does not have a valid Docker signature."
  }

  Write-CanvaslyStep "Installing Docker Desktop for the current user"
  $process = Start-Process -FilePath $dockerInstaller -Wait -PassThru -ArgumentList @(
    "install",
    "--user",
    "--backend=wsl-2"
  )
  if ($process.ExitCode -ne 0) {
    throw "Docker Desktop installation failed with exit code $($process.ExitCode)."
  }
}

function Wait-ForDocker {
  $dockerExecutable = Get-DockerExecutable
  if (Test-DockerReady $dockerExecutable) {
    return $dockerExecutable
  }

  $dockerDesktop = Get-DockerDesktopPath
  if (-not $dockerDesktop) {
    Install-DockerDesktop
    $dockerDesktop = Get-DockerDesktopPath
  }
  if (-not $dockerDesktop) {
    throw "Docker Desktop was installed but its application could not be found."
  }

  Enable-Wsl

  Write-CanvaslyStep "Starting Docker Desktop"
  Start-Process -FilePath $dockerDesktop | Out-Null
  Write-Host "Complete any first-run Docker Desktop or WSL prompts. This installer will continue automatically."

  $attempt = 0
  while ($attempt -lt 300) {
    $dockerExecutable = Get-DockerExecutable
    if (Test-DockerReady $dockerExecutable) {
      return $dockerExecutable
    }
    $attempt += 1
    if ($attempt % 15 -eq 0) {
      Write-Host "[Canvasly] Still waiting for Docker Desktop..."
    }
    Start-Sleep -Seconds 2
  }

  throw @"
Docker Desktop did not become ready within 10 minutes.
Finish the setup shown in Docker Desktop, then run this installer again.
If Windows asks for WSL 2, open PowerShell as Administrator, run 'wsl --install',
restart Windows, and rerun the same Canvasly installer command. Also verify that
CPU virtualization is enabled in BIOS/UEFI.
"@
}

try {
  if (Test-CanvaslyProject $PSScriptRoot) {
    $ProjectDirectory = $PSScriptRoot
    Write-CanvaslyStep "Using the Canvasly project at $ProjectDirectory"
  }
  else {
    Install-CanvaslyProject $ProjectDirectory
  }

  $dockerExecutable = Wait-ForDocker
  $dockerDirectory = Split-Path -Parent $dockerExecutable
  if (($env:PATH -split ";") -notcontains $dockerDirectory) {
    $env:PATH = "$dockerDirectory;$env:PATH"
  }

  & $dockerExecutable compose version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose is unavailable. Update Docker Desktop and run this installer again."
  }

  Write-CanvaslyStep "Building and starting Canvasly"
  $installArguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $ProjectDirectory "install.ps1")
  )
  if ($Copilot) {
    $installArguments += "--copilot"
  }
  & powershell.exe @installArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Canvasly installation failed with exit code $LASTEXITCODE."
  }
}
finally {
  if ($TemporaryDirectory -and (Test-Path -LiteralPath $TemporaryDirectory)) {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
  }
}
