[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$VencordPath,

    [switch]$SkipRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryUrl = "https://github.com/La-Fougere/customSoundboard.git"
$ExpectedBranch = "main"
$PluginDirectoryName = "customSoundboard.vesktop"

if (-not ("CustomSoundboardInstaller.NativePath" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace CustomSoundboardInstaller {
    public static class NativePath {
        private const uint OpenExisting = 3;
        private const uint FileFlagBackupSemantics = 0x02000000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(
            string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
            uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(
            IntPtr file, StringBuilder filePath, uint filePathSize, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static string GetFinalPath(string path) {
            IntPtr handle = CreateFile(path, 0, 7, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics, IntPtr.Zero);
            if (handle == new IntPtr(-1)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try {
                StringBuilder buffer = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0 || length >= buffer.Capacity) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return buffer.ToString();
            } finally {
                CloseHandle(handle);
            }
        }
    }
}
'@
}

function Assert-SafeGitEnvironment {
    $redirectVariables = @(
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR"
    )

    foreach ($entry in Get-ChildItem Env:) {
        if (($redirectVariables -contains $entry.Name) -or
            $entry.Name -eq "GIT_CONFIG" -or
            $entry.Name.StartsWith("GIT_CONFIG_", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to run while the inherited Git environment variable '$($entry.Name)' is set."
        }
    }
}

function Get-CanonicalExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $canonical = [CustomSoundboardInstaller.NativePath]::GetFinalPath($Path)
    if ($canonical.StartsWith("\\?\UNC\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $canonical = "\\" + $canonical.Substring(8)
    } elseif ($canonical.StartsWith("\\?\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $canonical = $canonical.Substring(4)
    }
    return [System.IO.Path]::GetFullPath($canonical).TrimEnd('\', '/')
}

function Test-ReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}

function Assert-SafeChildDestination {
    param(
        [Parameter(Mandatory = $true)][string]$ChildPath,
        [Parameter(Mandatory = $true)][string]$UserPluginsPath
    )

    $canonicalUserPlugins = Get-CanonicalExistingPath -Path $UserPluginsPath
    $leafName = Split-Path -Leaf $ChildPath
    if ([string]::IsNullOrWhiteSpace($leafName) -or $leafName -eq "." -or $leafName -eq "..") {
        throw "The checkout destination must be a direct child of '$canonicalUserPlugins'."
    }
    $expectedChild = [System.IO.Path]::GetFullPath((Join-Path $canonicalUserPlugins $leafName)).TrimEnd('\', '/')
    $requestedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $ChildPath)).TrimEnd('\', '/')
    if (-not $requestedParent.Equals($canonicalUserPlugins, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The checkout destination is not contained directly under '$canonicalUserPlugins'."
    }

    if (Test-Path -LiteralPath $ChildPath) {
        if (Test-ReparsePoint -Path $ChildPath) {
            throw "'$ChildPath' must not be a symbolic link, junction, or reparse point."
        }
        if (-not (Test-Path -LiteralPath $ChildPath -PathType Container)) {
            throw "'$ChildPath' exists but is not a directory."
        }
        $canonicalChild = Get-CanonicalExistingPath -Path $ChildPath
        if (-not $canonicalChild.Equals($expectedChild, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "The canonical checkout destination is not contained directly under '$canonicalUserPlugins'."
        }
    }

    return $expectedChild
}

function Assert-SafePluginDestination {
    param(
        [Parameter(Mandatory = $true)][string]$PluginPath,
        [Parameter(Mandatory = $true)][string]$UserPluginsPath
    )

    if ((Split-Path -Leaf $PluginPath) -ne $PluginDirectoryName) {
        throw "The plugin destination must be named '$PluginDirectoryName'."
    }
    return Assert-SafeChildDestination -ChildPath $PluginPath -UserPluginsPath $UserPluginsPath
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $Executable $($Arguments -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

function Get-CommandOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        $output = & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $Executable $($Arguments -join ' ')"
        }
        return ($output | Out-String).Trim()
    } finally {
        Pop-Location
    }
}

function Test-CommandSuccess {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $Executable @Arguments *> $null
        return $LASTEXITCODE -eq 0
    } finally {
        Pop-Location
    }
}

function Test-VencordRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (
        (Test-Path -LiteralPath (Join-Path $Path "package.json") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Path "pnpm-lock.yaml") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Path "src\userplugins") -PathType Container)
    )
}

function Resolve-VencordRoot {
    param([string]$RequestedPath)

    $candidate = $RequestedPath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $current = (Get-Location).Path
        if (Test-VencordRoot -Path $current) {
            $candidate = $current
        } else {
            $candidate = Read-Host "Path to your Vencord source checkout"
        }
    }

    if ([string]::IsNullOrWhiteSpace($candidate)) {
        throw "A Vencord source path is required."
    }

    $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    if (-not (Test-VencordRoot -Path $resolved)) {
        throw "'$resolved' is not a valid Vencord source checkout (package.json, pnpm-lock.yaml, or src\userplugins is missing)."
    }

    return Get-CanonicalExistingPath -Path $resolved
}

function Normalize-RepositoryUrl {
    param([Parameter(Mandatory = $true)][string]$Url)

    $normalized = $Url.Trim().Replace("\", "/").TrimEnd("/")
    if ($normalized.EndsWith(".git", [System.StringComparison]::OrdinalIgnoreCase)) {
        $normalized = $normalized.Substring(0, $normalized.Length - 4)
    }
    return $normalized.ToLowerInvariant()
}

function Assert-SafeCheckoutPaths {
    param([Parameter(Mandatory = $true)][string]$PluginPath)

    $canonicalPlugin = Assert-SafeChildDestination -ChildPath $PluginPath -UserPluginsPath $script:userPluginsPath
    $gitDirectory = Join-Path $PluginPath ".git"
    if (Test-Path -LiteralPath $gitDirectory) {
        if (Test-ReparsePoint -Path $gitDirectory) {
            throw "'$gitDirectory' must not be a symbolic link, junction, or reparse point."
        }
    }
    if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container)) {
        throw "'$PluginPath' is not a Git clone."
    }
    $canonicalGitDirectory = Get-CanonicalExistingPath -Path $gitDirectory
    $expectedGitDirectory = [System.IO.Path]::GetFullPath((Join-Path $canonicalPlugin ".git")).TrimEnd('\', '/')
    if (-not $canonicalGitDirectory.Equals($expectedGitDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The canonical .git directory escapes the plugin checkout."
    }

    return $canonicalPlugin
}

function Assert-PluginCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    [void](Assert-SafeCheckoutPaths -PluginPath $PluginPath)

    $actualRemote = Get-CommandOutput -Executable $Git -Arguments @("remote", "get-url", "origin") -WorkingDirectory $PluginPath
    if ((Normalize-RepositoryUrl -Url $actualRemote) -ne (Normalize-RepositoryUrl -Url $RepositoryUrl)) {
        throw "'$PluginPath' points to '$actualRemote', not '$RepositoryUrl'. Refusing to modify it."
    }

    $branch = Get-CommandOutput -Executable $Git -Arguments @("symbolic-ref", "--quiet", "--short", "HEAD") -WorkingDirectory $PluginPath
    if ($branch -ne $ExpectedBranch) {
        throw "The plugin clone must be on the '$ExpectedBranch' branch, not '$branch'."
    }

    $upstream = Get-CommandOutput -Executable $Git -Arguments @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}") -WorkingDirectory $PluginPath
    if ($upstream -ne "origin/$ExpectedBranch") {
        throw "The plugin branch must track 'origin/$ExpectedBranch', not '$upstream'."
    }

    $head = Get-CommandOutput -Executable $Git -Arguments @("rev-parse", "--verify", "HEAD^{commit}") -WorkingDirectory $PluginPath
    if ([string]::IsNullOrWhiteSpace($head)) {
        throw "The plugin repository has no valid commit."
    }

    foreach ($requiredFile in @("index.ts", "README.md", "LICENSE")) {
        if (-not (Test-Path -LiteralPath (Join-Path $PluginPath $requiredFile) -PathType Leaf)) {
            throw "The plugin checkout is missing required file '$requiredFile'."
        }
    }

    return $head
}

function Assert-CleanCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    $workingTree = Get-CommandOutput -Executable $Git -Arguments @("status", "--porcelain", "--untracked-files=all") -WorkingDirectory $PluginPath
    if (-not [string]::IsNullOrWhiteSpace($workingTree)) {
        throw "The existing plugin clone has local changes. Commit, stash, or remove them before updating."
    }
}

function Restore-PluginCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath,
        [Parameter(Mandatory = $true)][string]$Commit
    )

    [void](Assert-SafeCheckoutPaths -PluginPath $PluginPath)
    Invoke-CheckedCommand -Executable $Git -Arguments @("reset", "--hard", $Commit) -WorkingDirectory $PluginPath
    Invoke-CheckedCommand -Executable $Git -Arguments @("clean", "-fdx") -WorkingDirectory $PluginPath
    $restored = Assert-PluginCheckout -Git $Git -PluginPath $PluginPath
    if ($restored -ne $Commit) {
        throw "The plugin checkout could not be restored to commit $Commit."
    }
    Assert-CleanCheckout -Git $Git -PluginPath $PluginPath
}

function Find-VesktopExecutable {
    $command = Get-Command "Vesktop.exe" -ErrorAction SilentlyContinue
    if ($null -ne $command -and $command.Source) {
        return $command.Source
    }

    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA "vesktop\Vesktop.exe")
        $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Vesktop\Vesktop.exe")
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles "Vesktop\Vesktop.exe")
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} "Vesktop\Vesktop.exe")
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

function Restart-Vesktop {
    $executable = Find-VesktopExecutable
    if ([string]::IsNullOrWhiteSpace($executable)) {
        throw "The plugin was built successfully, but Vesktop.exe could not be found. Start Vesktop manually."
    }

    $running = @(Get-Process -Name "Vesktop" -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        $running | Stop-Process -Force
        $deadline = (Get-Date).AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 200
            $stillRunning = @(Get-Process -Name "Vesktop" -ErrorAction SilentlyContinue)
        } while ($stillRunning.Count -gt 0 -and (Get-Date) -lt $deadline)

        if ($stillRunning.Count -gt 0) {
            throw "Vesktop did not stop within 10 seconds."
        }
    }

    Start-Process -FilePath $executable | Out-Null
    Start-Sleep -Seconds 2
    if (@(Get-Process -Name "Vesktop" -ErrorAction SilentlyContinue).Count -eq 0) {
        throw "Vesktop was launched but no Vesktop process became visible."
    }
}

Assert-SafeGitEnvironment
$git = (Get-Command "git" -ErrorAction Stop).Source
$pnpm = (Get-Command "pnpm" -ErrorAction Stop).Source
$vencordRoot = Resolve-VencordRoot -RequestedPath $VencordPath
$userPluginsPath = Get-CanonicalExistingPath -Path (Join-Path $vencordRoot "src\userplugins")
$pluginPath = Join-Path $userPluginsPath $PluginDirectoryName
$createdPluginDirectory = $false
$previousCommit = $null

[void](Assert-SafePluginDestination -PluginPath $pluginPath -UserPluginsPath $userPluginsPath)

try {
    if (Test-Path -LiteralPath $pluginPath) {
        $previousCommit = Assert-PluginCheckout -Git $git -PluginPath $pluginPath
        Assert-CleanCheckout -Git $git -PluginPath $pluginPath

        Write-Host "Updating Custom Soundboard from the verified origin/main..."
        try {
            Invoke-CheckedCommand -Executable $git -Arguments @("fetch", "--force", "--prune", "origin", "refs/heads/$ExpectedBranch`:refs/remotes/origin/$ExpectedBranch") -WorkingDirectory $pluginPath
            $remoteCommit = Get-CommandOutput -Executable $git -Arguments @("rev-parse", "--verify", "refs/remotes/origin/$ExpectedBranch^{commit}") -WorkingDirectory $pluginPath
            if (-not (Test-CommandSuccess -Executable $git -Arguments @("merge-base", "--is-ancestor", $previousCommit, $remoteCommit) -WorkingDirectory $pluginPath)) {
                throw "origin/$ExpectedBranch does not fast-forward the installed commit."
            }
            Invoke-CheckedCommand -Executable $git -Arguments @("merge", "--ff-only", "refs/remotes/origin/$ExpectedBranch") -WorkingDirectory $pluginPath
            [void](Assert-PluginCheckout -Git $git -PluginPath $pluginPath)
            Assert-CleanCheckout -Git $git -PluginPath $pluginPath
        } catch {
            Restore-PluginCheckout -Git $git -PluginPath $pluginPath -Commit $previousCommit
            throw
        }
    } else {
        Write-Host "Installing Custom Soundboard..."
        $temporaryName = ".$PluginDirectoryName.install.$([Guid]::NewGuid().ToString('N'))"
        $temporaryPluginPath = Join-Path $userPluginsPath $temporaryName
        [void](New-Item -ItemType Directory -Path $temporaryPluginPath -ErrorAction Stop)
        $removeTemporaryPlugin = $true
        try {
            [void](Assert-SafeChildDestination -ChildPath $temporaryPluginPath -UserPluginsPath $userPluginsPath)
            Invoke-CheckedCommand -Executable $git -Arguments @("clone", "--branch", $ExpectedBranch, "--single-branch", "--", $RepositoryUrl, $temporaryPluginPath) -WorkingDirectory $userPluginsPath
            [void](Assert-PluginCheckout -Git $git -PluginPath $temporaryPluginPath)
            Assert-CleanCheckout -Git $git -PluginPath $temporaryPluginPath
            [void](Assert-SafePluginDestination -PluginPath $pluginPath -UserPluginsPath $userPluginsPath)
            [System.IO.Directory]::Move($temporaryPluginPath, $pluginPath)
            $removeTemporaryPlugin = $false
            $createdPluginDirectory = $true
        } finally {
            if ($removeTemporaryPlugin -and (Test-Path -LiteralPath $temporaryPluginPath)) {
                [void](Assert-SafeChildDestination -ChildPath $temporaryPluginPath -UserPluginsPath $userPluginsPath)
                Remove-Item -LiteralPath $temporaryPluginPath -Recurse -Force
            }
        }
    }

    Write-Host "Building Vencord..."
    try {
        Invoke-CheckedCommand -Executable $pnpm -Arguments @("build") -WorkingDirectory $vencordRoot
    } catch {
        $buildFailure = $_
        Write-Warning "The Vencord build failed. Restoring the previous plugin state..."

        if ($createdPluginDirectory) {
            [void](Assert-SafePluginDestination -PluginPath $pluginPath -UserPluginsPath $userPluginsPath)
            Remove-Item -LiteralPath $pluginPath -Recurse -Force
        } elseif ($previousCommit) {
            Restore-PluginCheckout -Git $git -PluginPath $pluginPath -Commit $previousCommit
        }

        try {
            Invoke-CheckedCommand -Executable $pnpm -Arguments @("build") -WorkingDirectory $vencordRoot
        } catch {
            throw "The update failed and rebuilding the previous Vencord state also failed. Original build error: $($buildFailure.Exception.Message). Recovery error: $($_.Exception.Message)"
        }

        throw "The update was rolled back because the Vencord build failed: $($buildFailure.Exception.Message)"
    }

    if ($SkipRestart) {
        Write-Host "Custom Soundboard was installed and built successfully. Restart Vesktop manually."
    } else {
        Write-Host "Restarting Vesktop..."
        Restart-Vesktop
        Write-Host "Custom Soundboard was installed, built, and Vesktop was restarted successfully."
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
