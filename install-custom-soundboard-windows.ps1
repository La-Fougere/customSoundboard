[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$VencordPath,

    [switch]$SkipRestart,

    [string]$GitPath,

    [string]$NodePath,

    [string]$PnpmPath
)

$__commandLineArgs = [System.Environment]::GetCommandLineArgs()
$__expectedHost = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine(
    [System.Environment]::SystemDirectory,
    "WindowsPowerShell\v1.0\powershell.exe"
))
$__actualHost = if ($__commandLineArgs.Length -gt 0) { [System.IO.Path]::GetFullPath($__commandLineArgs[0]) } else { "" }
$__noProfileIndexes = @()
$__nonInteractiveIndexes = @()
$__fileIndexes = @()
for ($__index = 1; $__index -lt $__commandLineArgs.Length; $__index++) {
    if ([string]::Equals($__commandLineArgs[$__index], "-NoProfile", [System.StringComparison]::OrdinalIgnoreCase)) { $__noProfileIndexes += $__index }
    if ([string]::Equals($__commandLineArgs[$__index], "-NonInteractive", [System.StringComparison]::OrdinalIgnoreCase)) { $__nonInteractiveIndexes += $__index }
    if ([string]::Equals($__commandLineArgs[$__index], "-File", [System.StringComparison]::OrdinalIgnoreCase)) { $__fileIndexes += $__index }
}
$__invocationValid = $__actualHost.Equals($__expectedHost, [System.StringComparison]::OrdinalIgnoreCase) -and
    $__noProfileIndexes.Count -eq 1 -and $__nonInteractiveIndexes.Count -eq 1 -and $__fileIndexes.Count -eq 1 -and
    $__noProfileIndexes[0] -lt $__fileIndexes[0] -and $__nonInteractiveIndexes[0] -lt $__fileIndexes[0] -and
    $__fileIndexes[0] + 1 -lt $__commandLineArgs.Length -and
    ([System.IO.Path]::GetFullPath($__commandLineArgs[$__fileIndexes[0] + 1])).Equals(
        [System.IO.Path]::GetFullPath($PSCommandPath),
        [System.StringComparison]::OrdinalIgnoreCase
    ) -and $MyInvocation.InvocationName -ne "."
if (-not $__invocationValid) {
    [System.Console]::Error.WriteLine("Error: Start a new powershell.exe process with the exact -NoProfile -NonInteractive -File <this-script> arguments. Dot-sourcing and existing PowerShell sessions are refused.")
    [System.Environment]::Exit(1)
}

Microsoft.PowerShell.Core\Set-StrictMode -Version Latest
$global:LASTEXITCODE = 0
$ErrorActionPreference = "Stop"

$RepositoryUrl = "https://github.com/La-Fougere/customSoundboard.git"
$ExpectedBranch = "main"
$PluginDirectoryName = "customSoundboard.vesktop"

if (-not ("CustomSoundboardInstaller.NativePath" -as [type])) {
    Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
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

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            IntPtr file, out ByHandleFileInformation information);

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

        public static string GetFileIdentity(string path) {
            IntPtr handle = CreateFile(path, 0, 7, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics, IntPtr.Zero);
            if (handle == new IntPtr(-1)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try {
                ByHandleFileInformation information;
                if (!GetFileInformationByHandle(handle, out information)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return information.VolumeSerialNumber.ToString("X8") + ":" +
                    information.FileIndexHigh.ToString("X8") + information.FileIndexLow.ToString("X8");
            } finally {
                CloseHandle(handle);
            }
        }
    }
}
'@
}

function Assert-SafeGitEnvironment {
    $unsafeNonGitVariables = @(
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE",
        "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "PAGER", "LESS", "LV", "NODE_OPTIONS", "NODE_PATH"
    )
    foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
        $originalName = [string]$entry.Key
        $name = $originalName.ToUpperInvariant()
        if ($name -in $unsafeNonGitVariables) {
            throw "Refusing to run while the inherited transport, credential, pager, trust, Node.js, npm, pnpm, or Corepack environment variable '$originalName' is set."
        }
        # Environment names are case-insensitive on Windows, so npm_config_* is matched by NPM_CONFIG_.
        if ($name.StartsWith("GIT_", [System.StringComparison]::Ordinal) -or
            $name.StartsWith("NPM_CONFIG_", [System.StringComparison]::Ordinal) -or
            $name.StartsWith("PNPM_", [System.StringComparison]::Ordinal) -or
            $name.StartsWith("COREPACK_", [System.StringComparison]::Ordinal)) {
            throw "Refusing to run while the inherited Git, Node.js, npm, pnpm, or Corepack environment variable '$originalName' is set."
        }
    }
}

function Get-ValidatedAutoCrlfFromScope {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][ValidateSet("--system", "--global")][string]$Scope
    )

    $values = @(& $Git config $Scope --no-includes --get-all core.autocrlf 2>$null)
    $status = $LASTEXITCODE
    if ($status -eq 1 -or $values.Count -eq 0) {
        return $null
    }
    if ($status -ne 0) {
        throw "Reading Git core.autocrlf from scope '$Scope' failed with exit code $status."
    }
    $value = ($values | Select-Object -Last 1).Trim().ToLowerInvariant()
    if ($value -notin @("true", "false", "input")) {
        throw "The Git core.autocrlf value '$value' in scope '$Scope' is invalid."
    }
    return $value
}

function Get-ValidatedEffectiveAutoCrlf {
    param([Parameter(Mandatory = $true)][string]$Git)

    $systemValue = Get-ValidatedAutoCrlfFromScope -Git $Git -Scope "--system"
    $globalValue = Get-ValidatedAutoCrlfFromScope -Git $Git -Scope "--global"
    if (-not [string]::IsNullOrWhiteSpace($globalValue)) {
        return $globalValue
    }
    return $systemValue
}

function Initialize-SafeGitEnvironment {
    param([AllowNull()][string]$GlobalAutoCrlf)

    $script:safeGitRoot = $null
    $env:GIT_CONFIG_NOSYSTEM = "1"
    $env:GIT_CONFIG_SYSTEM = "NUL"
    $env:GIT_CONFIG_GLOBAL = "NUL"
    $env:GIT_CONFIG_COUNT = "1"
    $env:GIT_CONFIG_KEY_0 = "core.hooksPath"
    $env:GIT_CONFIG_VALUE_0 = "NUL"
    if (-not [string]::IsNullOrWhiteSpace($GlobalAutoCrlf)) {
        $env:GIT_CONFIG_COUNT = "2"
        $env:GIT_CONFIG_KEY_1 = "core.autocrlf"
        $env:GIT_CONFIG_VALUE_1 = $GlobalAutoCrlf
    } else {
        Remove-Item Env:GIT_CONFIG_KEY_1 -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_CONFIG_VALUE_1 -ErrorAction SilentlyContinue
    }
    $env:GIT_NO_REPLACE_OBJECTS = "1"
    $env:GIT_TERMINAL_PROMPT = "0"
}

function Remove-SafeGitEnvironment {
    $script:safeGitRoot = $null
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

function Get-StableFileSystemIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)

    $canonical = Get-CanonicalExistingPath -Path $Path
    return [CustomSoundboardInstaller.NativePath]::GetFileIdentity($canonical)
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Get-TrustedToolIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $canonical = Get-CanonicalExistingPath -Path $Path
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not $canonical.Equals($fullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Test-ReparsePoint -Path $canonical)) {
        throw "The trusted $Name tool path contains a symbolic link, junction, or reparse indirection."
    }
    return [pscustomobject]@{
        Name = $Name
        Path = $canonical
        StableIdentity = Get-StableFileSystemIdentity -Path $canonical
        SHA256 = Get-FileSha256 -Path $canonical
    }
}

function Assert-TrustedToolIdentity {
    param([Parameter(Mandatory = $true)]$Identity)

    $canonical = Get-CanonicalExistingPath -Path $Identity.Path
    if (-not $canonical.Equals($Identity.Path, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Test-ReparsePoint -Path $Identity.Path) -or
        (Get-StableFileSystemIdentity -Path $Identity.Path) -cne $Identity.StableIdentity -or
        (Get-FileSha256 -Path $Identity.Path) -cne $Identity.SHA256) {
        throw "Trusted tool '$($Identity.Name)' at '$($Identity.Path)' was replaced or modified after validation."
    }
}

function Assert-TrustedToolSet {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Identities)

    foreach ($identity in $Identities) {
        Assert-TrustedToolIdentity -Identity $identity
    }
}

function Assert-FreshCheckoutFileSystemIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$PluginPath,
        [Parameter(Mandatory = $true)][string]$PluginIdentity,
        [Parameter(Mandatory = $true)][string]$GitDirectoryIdentity
    )

    $currentPluginIdentity = Get-StableFileSystemIdentity -Path $PluginPath
    $currentGitIdentity = Get-StableFileSystemIdentity -Path (Join-Path $PluginPath ".git")
    if ($currentPluginIdentity -cne $PluginIdentity -or $currentGitIdentity -cne $GitDirectoryIdentity) {
        throw "The newly installed plugin checkout or its .git directory was replaced after installation."
    }
}

function Test-ReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}

function Resolve-TrustedExecutablePath {
    param(
        [string]$RequestedPath,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$DefaultCandidates
    )

    $candidates = if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        if (-not [System.IO.Path]::IsPathRooted($RequestedPath)) {
            throw "The explicit $Name path must be absolute."
        }
        @($RequestedPath)
    } else {
        @($DefaultCandidates)
    }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        if (Test-ReparsePoint -Path $candidate) {
            throw "The $Name executable must not be a symbolic link, junction, or reparse point."
        }
        $fullPath = [System.IO.Path]::GetFullPath($candidate)
        $canonical = Get-CanonicalExistingPath -Path $fullPath
        if ($canonical -cne $fullPath.TrimEnd('\', '/')) {
            throw "The $Name executable path contains a symbolic link, junction, or reparse indirection."
        }
        if ([string]::IsNullOrWhiteSpace($RequestedPath) -and [System.IO.Path]::GetExtension($canonical) -ine ".exe") {
            throw "The automatically selected $Name command is not a native .exe executable."
        }
        return $canonical
    }

    throw "$Name is required. Supply its absolute path explicitly if it is installed outside the supported locations."
}

function Resolve-PnpmInvocation {
    param(
        [string]$RequestedPath,
        [Parameter(Mandatory = $true)][string]$NodeExecutable
    )

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        $resolved = Resolve-TrustedExecutablePath -RequestedPath $RequestedPath -Name "pnpm" -DefaultCandidates @()
        $extension = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
        if ($extension -in @(".js", ".cjs", ".mjs")) {
            return [pscustomobject]@{ Executable = $NodeExecutable; PrefixArguments = @($resolved); IdentityPaths = @($NodeExecutable, $resolved) }
        }
        return [pscustomobject]@{ Executable = $resolved; PrefixArguments = @(); IdentityPaths = @($resolved) }
    }

    $nodeRoot = Split-Path -Parent $NodeExecutable
    $scriptCandidates = @(
        (Join-Path $nodeRoot "node_modules\corepack\dist\pnpm.js"),
        (Join-Path $nodeRoot "node_modules\pnpm\bin\pnpm.cjs"),
        (Join-Path $nodeRoot "node_modules\pnpm\bin\pnpm.mjs")
    )
    foreach ($candidate in $scriptCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            if (Test-ReparsePoint -Path $candidate) {
                throw "The pnpm entry point must not be a symbolic link, junction, or reparse point."
            }
            $fullPath = [System.IO.Path]::GetFullPath($candidate)
            $canonical = Get-CanonicalExistingPath -Path $fullPath
            if ($canonical -cne $fullPath.TrimEnd('\', '/')) {
                throw "The pnpm entry point contains a symbolic link, junction, or reparse indirection."
            }
            return [pscustomobject]@{ Executable = $NodeExecutable; PrefixArguments = @($canonical); IdentityPaths = @($NodeExecutable, $canonical) }
        }
    }

    throw "pnpm is required. Supply -PnpmPath with an absolute native executable or JavaScript entry point."
}

function Get-FirstReparsePointUnderPath {
    param([Parameter(Mandatory = $true)][string]$RootPath)

    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($RootPath)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $attributes = [System.IO.File]::GetAttributes($entry)
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                return $entry
            }
            if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                $pending.Push($entry)
            }
        }
    }
    return $null
}

function Get-FirstMutableGitMetadataHardLink {
    param([Parameter(Mandatory = $true)][string]$GitDirectory)

    $objectsDirectory = [System.IO.Path]::GetFullPath((Join-Path $GitDirectory "objects")).TrimEnd('\', '/')
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($GitDirectory)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
            try {
                $item = Get-Item -LiteralPath $entry -Force -ErrorAction Stop
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    continue
                }
                if (($item.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                    $fullDirectory = [System.IO.Path]::GetFullPath($item.FullName).TrimEnd('\', '/')
                    if (-not $fullDirectory.Equals($objectsDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
                        $pending.Push($item.FullName)
                    }
                    continue
                }
                $linkTypeProperty = $item.PSObject.Properties["LinkType"]
                $targetProperty = $item.PSObject.Properties["Target"]
                if ($null -eq $linkTypeProperty -or $null -eq $targetProperty) {
                    throw "PowerShell did not expose LinkType and Target."
                }
                if ($item.LinkType -eq "HardLink") {
                    return $item.FullName
                }
            } catch {
                throw "Git metadata hardlink inspection failed for '$entry': $($_.Exception.Message)"
            }
        }
    }
    return $null
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
        if ($null -eq $output) {
            return ""
        }
        if ($output -is [System.Array]) {
            return [string]::Join("`n", [string[]]$output)
        }
        return [string]$output
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
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $Executable @Arguments *> $null
        $exitCode = $LASTEXITCODE
        return $exitCode -eq 0
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
}

function Invoke-VencordBuild {
    param(
        [Parameter(Mandatory = $true)][string]$Pnpm,
        [string[]]$PnpmPrefixArguments = @(),
        [Parameter(Mandatory = $true)][string]$VencordRoot
    )

    $names = @(
        "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
        "GIT_NO_REPLACE_OBJECTS", "GIT_TERMINAL_PROMPT", "PATH",
        "NODE_OPTIONS", "NODE_PATH", "PNPM_HOME", "COREPACK_HOME",
        "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG"
    )
    $saved = @{}
    foreach ($name in $names) {
        $saved[$name] = [System.Environment]::GetEnvironmentVariable($name, [System.EnvironmentVariableTarget]::Process)
    }
    try {
        [System.Environment]::SetEnvironmentVariable("GIT_CONFIG_NOSYSTEM", "1", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("GIT_CONFIG_SYSTEM", "NUL", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("GIT_CONFIG_GLOBAL", "NUL", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("GIT_CONFIG_COUNT", "1", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("GIT_CONFIG_KEY_0", "core.hooksPath", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("GIT_CONFIG_VALUE_0", "NUL", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("GIT_NO_REPLACE_OBJECTS", "1", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("GIT_TERMINAL_PROMPT", "0", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("PATH", [System.Environment]::SystemDirectory, [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("NODE_PATH", $null, [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("PNPM_HOME", $null, [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("COREPACK_HOME", $null, [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("NPM_CONFIG_USERCONFIG", "NUL", [System.EnvironmentVariableTarget]::Process)
        [System.Environment]::SetEnvironmentVariable("NPM_CONFIG_GLOBALCONFIG", "NUL", [System.EnvironmentVariableTarget]::Process)
        Invoke-CheckedCommand -Executable $Pnpm -Arguments @($PnpmPrefixArguments + @("build")) -WorkingDirectory $VencordRoot
    } finally {
        foreach ($name in $names) {
            [System.Environment]::SetEnvironmentVariable($name, $saved[$name], [System.EnvironmentVariableTarget]::Process)
        }
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

function Assert-VencordRootPathsSafe {
    param([Parameter(Mandatory = $true)][string]$Path)

    $canonicalRoot = Get-CanonicalExistingPath -Path $Path
    $requestedRoot = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not $canonicalRoot.Equals($requestedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The Vencord root is not canonical."
    }
    $srcPath = Join-Path $canonicalRoot "src"
    $userPluginsPath = Join-Path $srcPath "userplugins"
    foreach ($entry in @($srcPath, $userPluginsPath)) {
        if (-not (Test-Path -LiteralPath $entry -PathType Container)) {
            throw "'$entry' must be a directory."
        }
        if (Test-ReparsePoint -Path $entry) {
            throw "'$entry' must not be a symbolic link, junction, or reparse point."
        }
    }
    $canonicalSrc = Get-CanonicalExistingPath -Path $srcPath
    $canonicalUserPlugins = Get-CanonicalExistingPath -Path $userPluginsPath
    $expectedSrc = [System.IO.Path]::GetFullPath($srcPath).TrimEnd('\', '/')
    $expectedUserPlugins = [System.IO.Path]::GetFullPath($userPluginsPath).TrimEnd('\', '/')
    if (-not $canonicalSrc.Equals($expectedSrc, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $canonicalUserPlugins.Equals($expectedUserPlugins, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The canonical src/userplugins path escapes the Vencord root."
    }
    return $canonicalUserPlugins
}

function Test-ValidInstalledPluginCandidate {
    param([Parameter(Mandatory = $true)][string]$Candidate)

    $savedUserPlugins = $script:userPluginsPath
    try {
        $script:userPluginsPath = Assert-VencordRootPathsSafe -Path $Candidate
        $candidatePlugin = Join-Path $script:userPluginsPath $PluginDirectoryName
        if (-not (Test-Path -LiteralPath $candidatePlugin -PathType Container) -or (Test-ReparsePoint -Path $candidatePlugin)) {
            return $false
        }
        [void](Assert-PluginCheckout -Git $script:git -PluginPath $candidatePlugin)
        Assert-CleanCheckout -Git $script:git -PluginPath $candidatePlugin
        return $true
    } catch {
        return $false
    } finally {
        $script:userPluginsPath = $savedUserPlugins
    }
}

function Resolve-ValidVencordCandidate {
    param([string]$Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate) -or
        -not (Test-Path -LiteralPath $Candidate -PathType Container)) {
        return $null
    }

    try {
        $resolved = (Resolve-Path -LiteralPath $Candidate -ErrorAction Stop).Path
        if ((Test-VencordRoot -Path $resolved)) {
            [void](Assert-VencordRootPathsSafe -Path $resolved)
            return Get-CanonicalExistingPath -Path $resolved
        }

        if ((Split-Path -Leaf $resolved) -eq "dist") {
            $parent = Split-Path -Parent $resolved
            if ((Test-VencordRoot -Path $parent)) {
                [void](Assert-VencordRootPathsSafe -Path $parent)
                return Get-CanonicalExistingPath -Path $parent
            }
        }
    } catch {
        return $null
    }

    return $null
}

function Get-VencordRootsFromVesktopState {
    $stateFiles = @()
    if ($env:APPDATA) {
        $stateFiles += (Join-Path $env:APPDATA "vesktop\state.json")
        $stateFiles += (Join-Path $env:APPDATA "Vesktop\state.json")
    }
    if ($env:LOCALAPPDATA) {
        $stateFiles += (Join-Path $env:LOCALAPPDATA "vesktop\state.json")
        $stateFiles += (Join-Path $env:LOCALAPPDATA "Vesktop\state.json")
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($stateFile in $stateFiles | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
            continue
        }
        try {
            $state = Get-Content -LiteralPath $stateFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $candidate = Resolve-ValidVencordCandidate -Candidate $state.vencordDir
            if ($candidate -and $seen.Add($candidate)) {
                [void]$candidates.Add($candidate)
            }
        } catch {
            continue
        }
    }

    return $candidates.ToArray()
}

function Select-VencordCandidate {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Candidates)

    if ($Candidates.Count -eq 1) {
        return $Candidates[0]
    }
    if ($Candidates.Count -eq 0) {
        return $null
    }

    $withPlugin = @($Candidates | Where-Object { Test-ValidInstalledPluginCandidate -Candidate $_ })
    if ($withPlugin.Count -eq 1) {
        return $withPlugin[0]
    }

    if (-not [Console]::IsInputRedirected) {
        Write-Host "Several Vencord source checkouts were found:"
        for ($index = 0; $index -lt $Candidates.Count; $index++) {
            Write-Host "  $($index + 1). $($Candidates[$index])"
        }
        $selection = Read-Host "Select the Vencord checkout to use"
        $selectedIndex = 0
        if ([int]::TryParse($selection, [ref]$selectedIndex) -and
            $selectedIndex -ge 1 -and $selectedIndex -le $Candidates.Count) {
            return $Candidates[$selectedIndex - 1]
        }
        throw "No valid Vencord checkout was selected."
    }

    throw "Several Vencord source checkouts were found. Supply -VencordPath explicitly."
}

function Get-VencordAncestorCandidate {
    param([string]$StartingPath)

    if ([string]::IsNullOrWhiteSpace($StartingPath)) {
        return $null
    }

    try {
        $current = (Resolve-Path -LiteralPath $StartingPath -ErrorAction Stop).Path
    } catch {
        return $null
    }

    while (-not [string]::IsNullOrWhiteSpace($current)) {
        $candidate = Resolve-ValidVencordCandidate -Candidate $current
        if ($candidate) {
            return $candidate
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
            break
        }
        $current = $parent
    }

    return $null
}

function Find-AutomaticVencordRoot {
    $candidates = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $candidateInputs = @(
        @(Get-VencordRootsFromVesktopState)
    ) + @(
        (Get-VencordAncestorCandidate -StartingPath (Get-Location).Path),
        (Get-VencordAncestorCandidate -StartingPath $PSScriptRoot)
    )
    if ($HOME) {
        $candidateInputs += @(
            (Join-Path $HOME "Vencord"),
            (Join-Path $HOME "vencord"),
            (Join-Path $HOME "Documents\Vencord"),
            (Join-Path $HOME "Projects\Vencord"),
            (Join-Path $HOME "projects\Vencord"),
            (Join-Path $HOME "source\repos\Vencord"),
            (Join-Path $HOME "src\Vencord"),
            (Join-Path $HOME "git\Vencord")
        )
    }

    foreach ($inputPath in $candidateInputs) {
        $candidate = Resolve-ValidVencordCandidate -Candidate $inputPath
        if ($candidate -and $seen.Add($candidate)) {
            [void]$candidates.Add($candidate)
        }
    }

    return Select-VencordCandidate -Candidates $candidates.ToArray()
}

function Resolve-VencordRoot {
    param([string]$RequestedPath)

    $candidate = $RequestedPath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = Find-AutomaticVencordRoot
        if ($candidate) {
            Write-Host "Detected Vencord source checkout: $candidate"
        } elseif (-not [Console]::IsInputRedirected) {
            $candidate = Read-Host "Path to your Vencord source checkout"
        } else {
            throw "A Vencord source checkout could not be detected. Supply -VencordPath explicitly."
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

function Test-ExpectedRepositoryUrl {
    param([Parameter(Mandatory = $true)][string]$Url)

    if (-not $RepositoryUrl.StartsWith("https://", [System.StringComparison]::Ordinal)) {
        try {
            $actualPath = [System.IO.Path]::GetFullPath($Url).TrimEnd('\', '/')
            $expectedPath = [System.IO.Path]::GetFullPath($RepositoryUrl).TrimEnd('\', '/')
            return $actualPath.Equals($expectedPath, [System.StringComparison]::OrdinalIgnoreCase)
        } catch {
            return $false
        }
    }
    if ($Url -ceq $RepositoryUrl) {
        return $true
    }
    if ($Url.Contains("\")) {
        return $false
    }
    return $Url -ceq "$RepositoryUrl/"
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

    $commondirPath = Join-Path $gitDirectory "commondir"
    if (Test-Path -LiteralPath $commondirPath) {
        throw "The plugin repository must not contain a .git/commondir file."
    }

    $alternatesPath = Join-Path $gitDirectory "objects\info\alternates"
    if ([System.IO.File]::Exists($alternatesPath) -or [System.IO.Directory]::Exists($alternatesPath)) {
        throw "The plugin repository must not use Git object alternates ('$alternatesPath')."
    }

    $unsafeGitPath = Get-FirstReparsePointUnderPath -RootPath $gitDirectory
    if ($unsafeGitPath) {
        throw "Git metadata path '$unsafeGitPath' must not be a symbolic link, junction, or reparse point."
    }

    $unsafeHardLink = Get-FirstMutableGitMetadataHardLink -GitDirectory $gitDirectory
    if ($unsafeHardLink) {
        throw "Mutable Git metadata file '$unsafeHardLink' must not be a hardlink."
    }

    return $canonicalPlugin
}

function Assert-SafeLocalGitConfig {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    $configPath = Join-Path $PluginPath ".git\config"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or (Test-ReparsePoint -Path $configPath)) {
        throw "The plugin repository has an unsafe or missing local Git config file."
    }

    $keys = Get-CommandOutput -Executable $Git -Arguments @("config", "--file", $configPath, "--no-includes", "--name-only", "--list") -WorkingDirectory $PluginPath
    foreach ($key in @($keys -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $normalized = $key.ToLowerInvariant()
        $values = @(& $Git config --file $configPath --no-includes --get-all $key)
        if ($LASTEXITCODE -ne 0 -or $values.Count -eq 0) {
            throw "The plugin repository local Git config key '$key' has no inspectable value."
        }
        if ($normalized -eq "remote.origin.fetch") {
            foreach ($fetchValue in $values) {
                if ($fetchValue -notmatch '^\+refs/heads/[^:\s]+:refs/remotes/origin/[^:\s]+$') {
                    throw "The plugin repository local Git config contains an unsafe fetch refspec."
                }
            }
            continue
        }
        if ($values.Count -ne 1) {
            throw "The plugin repository local Git config key '$key' must have exactly one value."
        }
        $value = [string]$values[0]
        $lowerValue = $value.ToLowerInvariant()
        $valid = switch -Regex ($normalized) {
            '^core\.repositoryformatversion$' { $value -eq "0"; break }
            '^core\.(filemode|logallrefupdates|ignorecase|precomposeunicode|symlinks)$' { $lowerValue -in @("true", "false"); break }
            '^core\.bare$' { $lowerValue -eq "false"; break }
            '^core\.autocrlf$' { $lowerValue -in @("true", "false", "input"); break }
            '^core\.eol$' { $lowerValue -in @("native", "lf", "crlf"); break }
            '^core\.safecrlf$' { $lowerValue -in @("true", "false", "warn"); break }
            '^remote\.origin\.url$' { Test-ExpectedRepositoryUrl -Url $value; break }
            '^branch\.main\.remote$' { $value -ceq "origin"; break }
            '^branch\.main\.merge$' { $value -ceq "refs/heads/$ExpectedBranch"; break }
            default { $false }
        }
        if (-not $valid) {
            throw "The plugin repository local Git config contains forbidden key '$key'."
        }
    }
}

function Assert-NoReplaceRefs {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    $replaceRefs = Get-CommandOutput -Executable $Git -Arguments @("for-each-ref", "--format=%(refname)", "refs/replace") -WorkingDirectory $PluginPath
    if (-not [string]::IsNullOrWhiteSpace($replaceRefs)) {
        throw "The plugin repository contains forbidden Git replacement refs."
    }
}

function Assert-GitResolvedCheckoutPaths {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    $canonicalPlugin = Get-CanonicalExistingPath -Path $PluginPath
    $expectedGitDirectory = Get-CanonicalExistingPath -Path (Join-Path $PluginPath ".git")
    $resolvedTopLevel = Get-CanonicalExistingPath -Path (Get-CommandOutput -Executable $Git -Arguments @("rev-parse", "--show-toplevel") -WorkingDirectory $PluginPath)
    $resolvedGitDirectory = Get-CanonicalExistingPath -Path (Get-CommandOutput -Executable $Git -Arguments @("rev-parse", "--absolute-git-dir") -WorkingDirectory $PluginPath)
    $commonDirectoryOutput = Get-CommandOutput -Executable $Git -Arguments @("rev-parse", "--git-common-dir") -WorkingDirectory $PluginPath
    if (-not [System.IO.Path]::IsPathRooted($commonDirectoryOutput)) {
        $commonDirectoryOutput = Join-Path $PluginPath $commonDirectoryOutput
    }
    $resolvedCommonDirectory = Get-CanonicalExistingPath -Path $commonDirectoryOutput
    if (-not $resolvedTopLevel.Equals($canonicalPlugin, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Git resolves the plugin working tree outside the plugin destination."
    }
    if (-not $resolvedGitDirectory.Equals($expectedGitDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Git resolves the plugin directory outside the plugin checkout."
    }
    if (-not $resolvedCommonDirectory.Equals($expectedGitDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Git resolves the plugin common directory outside the plugin checkout."
    }
}

function Assert-GitMutationSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    [void](Assert-SafeCheckoutPaths -PluginPath $PluginPath)
    Assert-SafeLocalGitConfig -Git $Git -PluginPath $PluginPath
    Assert-NoReplaceRefs -Git $Git -PluginPath $PluginPath
    Assert-GitResolvedCheckoutPaths -Git $Git -PluginPath $PluginPath
    [void](Assert-SafeCheckoutPaths -PluginPath $PluginPath)
}

function Remove-SafeCheckoutTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$UserPluginsPath
    )

    [void](Assert-SafeChildDestination -ChildPath $Path -UserPluginsPath $UserPluginsPath)
    $unsafePath = Get-FirstReparsePointUnderPath -RootPath $Path
    if ($unsafePath) {
        throw "Refusing to remove '$Path' because '$unsafePath' is a symbolic link, junction, or reparse point."
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Assert-PluginCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    [void](Assert-SafeCheckoutPaths -PluginPath $PluginPath)
    Assert-SafeLocalGitConfig -Git $Git -PluginPath $PluginPath
    Assert-NoReplaceRefs -Git $Git -PluginPath $PluginPath
    Assert-GitResolvedCheckoutPaths -Git $Git -PluginPath $PluginPath

    $actualRemote = Get-CommandOutput -Executable $Git -Arguments @("remote", "get-url", "origin") -WorkingDirectory $PluginPath
    if (-not (Test-ExpectedRepositoryUrl -Url $actualRemote)) {
        throw "'$PluginPath' points to '$actualRemote', not '$RepositoryUrl'. Refusing to modify it."
    }

    $branch = Get-CommandOutput -Executable $Git -Arguments @("symbolic-ref", "--quiet", "--short", "HEAD") -WorkingDirectory $PluginPath
    if ($branch -cne $ExpectedBranch) {
        throw "The plugin clone must be on the '$ExpectedBranch' branch, not '$branch'."
    }

    $upstream = Get-CommandOutput -Executable $Git -Arguments @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}") -WorkingDirectory $PluginPath
    if ($upstream -cne "origin/$ExpectedBranch") {
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

function Assert-HeadWorktreeClean {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString("N"))
    $temporaryIndex = Join-Path $temporaryRoot "index"
    $savedIndex = [System.Environment]::GetEnvironmentVariable("GIT_INDEX_FILE", [System.EnvironmentVariableTarget]::Process)
    [void](New-Item -ItemType Directory -Path $temporaryRoot -ErrorAction Stop)
    try {
        [System.Environment]::SetEnvironmentVariable("GIT_INDEX_FILE", $temporaryIndex, [System.EnvironmentVariableTarget]::Process)
        Invoke-CheckedCommand -Executable $Git -Arguments @("-c", "core.fsmonitor=false", "read-tree", "HEAD") -WorkingDirectory $PluginPath
        $workingTree = Get-CommandOutput -Executable $Git -Arguments @("-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all", "--ignored=matching") -WorkingDirectory $PluginPath
        return [string]::IsNullOrWhiteSpace($workingTree)
    } finally {
        [System.Environment]::SetEnvironmentVariable("GIT_INDEX_FILE", $savedIndex, [System.EnvironmentVariableTarget]::Process)
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Assert-CleanCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    $indexState = Get-CommandOutput -Executable $Git -Arguments @("ls-files", "-v") -WorkingDirectory $PluginPath
    foreach ($entry in @($indexState -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        if ($entry[0] -ceq "S" -or [char]::IsLower($entry[0])) {
            throw "The existing plugin clone contains assume-unchanged or skip-worktree index entries."
        }
    }
    if (-not (Test-CommandSuccess -Executable $Git -Arguments @("diff-index", "--cached", "--quiet", "HEAD", "--") -WorkingDirectory $PluginPath)) {
        throw "The existing plugin clone has staged tracked content."
    }
    if (-not (Assert-HeadWorktreeClean -Git $Git -PluginPath $PluginPath)) {
        throw "The existing plugin clone has tracked, untracked, or ignored local data. Commit, stash, or remove it before updating."
    }
}

function Assert-CompletelyCleanCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath
    )

    $indexState = Get-CommandOutput -Executable $Git -Arguments @("ls-files", "-v") -WorkingDirectory $PluginPath
    foreach ($entry in @($indexState -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        if ($entry[0] -ceq "S" -or [char]::IsLower($entry[0])) {
            throw "The newly installed plugin checkout contains assume-unchanged or skip-worktree index entries."
        }
    }
    if (-not (Test-CommandSuccess -Executable $Git -Arguments @("diff-index", "--cached", "--quiet", "HEAD", "--") -WorkingDirectory $PluginPath)) {
        throw "The newly installed plugin checkout has staged tracked content."
    }
    if (-not (Assert-HeadWorktreeClean -Git $Git -PluginPath $PluginPath)) {
        throw "The newly installed plugin checkout contains tracked, untracked, or ignored changes."
    }
}

function Assert-InstallerOwnedFreshCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath,
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][string]$Identity
    )

    $currentCommit = Assert-PluginCheckout -Git $Git -PluginPath $PluginPath
    if ($currentCommit -ne $Commit) {
        throw "The installed plugin commit changed after validation."
    }
    Assert-CompletelyCleanCheckout -Git $Git -PluginPath $PluginPath

    $identityPath = Join-Path $PluginPath ".git\custom-soundboard-installer-identity"
    if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf) -or (Test-ReparsePoint -Path $identityPath)) {
        throw "The installer-owned checkout identity marker is missing or unsafe."
    }
    $actualIdentity = [System.IO.File]::ReadAllText($identityPath)
    if ($actualIdentity -cne $Identity) {
        throw "The installer-owned checkout identity marker changed."
    }
    [void](Assert-SafeCheckoutPaths -PluginPath $PluginPath)
}

function Remove-ValidatedGitCheckoutTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$UserPluginsPath
    )

    [void](Assert-SafeChildDestination -ChildPath $Path -UserPluginsPath $UserPluginsPath)
    $unsafePath = Get-FirstReparsePointUnderPath -RootPath $Path
    if ($unsafePath) {
        throw "Refusing to remove '$Path' because '$unsafePath' is a symbolic link, junction, or reparse point."
    }
    [void](Assert-SafeCheckoutPaths -PluginPath $Path)
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Assert-ExistingCheckoutIdentityAndState {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath,
        [Parameter(Mandatory = $true)][string]$PluginIdentity,
        [Parameter(Mandatory = $true)][string]$GitDirectoryIdentity,
        [Parameter(Mandatory = $true)][string]$Commit
    )

    Assert-FreshCheckoutFileSystemIdentity -PluginPath $PluginPath -PluginIdentity $PluginIdentity -GitDirectoryIdentity $GitDirectoryIdentity
    $currentCommit = Assert-PluginCheckout -Git $Git -PluginPath $PluginPath
    if ($currentCommit -ne $Commit) {
        throw "The existing plugin checkout commit changed unexpectedly."
    }
    Assert-CleanCheckout -Git $Git -PluginPath $PluginPath
}

function Restore-SwappedPluginCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$PluginPath,
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$PreviousCommit,
        [Parameter(Mandatory = $true)][string]$PreviousPluginIdentity,
        [Parameter(Mandatory = $true)][string]$PreviousGitIdentity,
        [Parameter(Mandatory = $true)][string]$CandidateCommit,
        [Parameter(Mandatory = $true)][string]$CandidateMarker,
        [Parameter(Mandatory = $true)][string]$CandidatePluginIdentity,
        [Parameter(Mandatory = $true)][string]$CandidateGitIdentity
    )

    Assert-FreshCheckoutFileSystemIdentity -PluginPath $PluginPath -PluginIdentity $CandidatePluginIdentity -GitDirectoryIdentity $CandidateGitIdentity
    Assert-InstallerOwnedFreshCheckout -Git $Git -PluginPath $PluginPath -Commit $CandidateCommit -Identity $CandidateMarker
    Assert-ExistingCheckoutIdentityAndState -Git $Git -PluginPath $BackupPath -PluginIdentity $PreviousPluginIdentity -GitDirectoryIdentity $PreviousGitIdentity -Commit $PreviousCommit

    $failedPath = Join-Path $script:userPluginsPath (".$PluginDirectoryName.failed." + [Guid]::NewGuid().ToString("N"))
    [void](Assert-SafeChildDestination -ChildPath $failedPath -UserPluginsPath $script:userPluginsPath)
    if (Test-Path -LiteralPath $failedPath) {
        throw "The failed-candidate preservation path already exists."
    }
    [System.IO.Directory]::Move($PluginPath, $failedPath)
    try {
        [System.IO.Directory]::Move($BackupPath, $PluginPath)
    } catch {
        if (-not (Test-Path -LiteralPath $PluginPath)) {
            try { [System.IO.Directory]::Move($failedPath, $PluginPath) } catch { }
        }
        throw
    }

    Assert-ExistingCheckoutIdentityAndState -Git $Git -PluginPath $PluginPath -PluginIdentity $PreviousPluginIdentity -GitDirectoryIdentity $PreviousGitIdentity -Commit $PreviousCommit
    Assert-FreshCheckoutFileSystemIdentity -PluginPath $failedPath -PluginIdentity $CandidatePluginIdentity -GitDirectoryIdentity $CandidateGitIdentity
    Assert-InstallerOwnedFreshCheckout -Git $Git -PluginPath $failedPath -Commit $CandidateCommit -Identity $CandidateMarker
    Remove-ValidatedGitCheckoutTree -Path $failedPath -UserPluginsPath $script:userPluginsPath
}

function Remove-ValidatedBackupCheckout {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][string]$PluginIdentity,
        [Parameter(Mandatory = $true)][string]$GitDirectoryIdentity
    )

    Assert-ExistingCheckoutIdentityAndState -Git $Git -PluginPath $BackupPath -PluginIdentity $PluginIdentity -GitDirectoryIdentity $GitDirectoryIdentity -Commit $Commit
    Remove-ValidatedGitCheckoutTree -Path $BackupPath -UserPluginsPath $script:userPluginsPath
}

function Find-VesktopExecutable {
    $candidates = New-Object System.Collections.Generic.List[string]
    $programFiles = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles)
    $programFilesX86 = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)
    $localApplicationData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
    if (-not [string]::IsNullOrWhiteSpace($localApplicationData)) {
        [void]$candidates.Add((Join-Path $localApplicationData "vesktop\Vesktop.exe"))
        [void]$candidates.Add((Join-Path $localApplicationData "Programs\Vesktop\Vesktop.exe"))
    }
    if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
        [void]$candidates.Add((Join-Path $programFiles "Vesktop\Vesktop.exe"))
    }
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        [void]$candidates.Add((Join-Path $programFilesX86 "Vesktop\Vesktop.exe"))
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        if (Test-ReparsePoint -Path $candidate) {
            continue
        }
        $canonical = Get-CanonicalExistingPath -Path $candidate
        if ([System.IO.Path]::GetExtension($canonical) -ine ".exe" -or
            -not (Test-Path -LiteralPath $canonical -PathType Leaf) -or
            (Test-ReparsePoint -Path $canonical)) {
            continue
        }
        return $canonical
    }

    return $null
}

function Restart-Vesktop {
    param([Parameter(Mandatory = $true)][string]$Executable)

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

    Start-Process -FilePath $Executable | Out-Null
    Start-Sleep -Seconds 2
    if (@(Get-Process -Name "Vesktop" -ErrorAction SilentlyContinue).Count -eq 0) {
        throw "Vesktop was launched but no Vesktop process became visible."
    }
}

$script:safeGitRoot = $null
$script:userPluginsPath = $null
$script:git = $null
try {
    Assert-SafeGitEnvironment
    $programFiles = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles)
    $programFilesX86 = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)
    $gitCandidates = @(
        $(if (-not [string]::IsNullOrWhiteSpace($programFiles)) { Join-Path $programFiles "Git\cmd\git.exe" }),
        $(if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) { Join-Path $programFilesX86 "Git\cmd\git.exe" })
    )
    $nodeCandidates = @(
        $(if (-not [string]::IsNullOrWhiteSpace($programFiles)) { Join-Path $programFiles "nodejs\node.exe" }),
        $(if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) { Join-Path $programFilesX86 "nodejs\node.exe" })
    )
    $git = Resolve-TrustedExecutablePath -RequestedPath $GitPath -Name "git" -DefaultCandidates $gitCandidates
    $node = Resolve-TrustedExecutablePath -RequestedPath $NodePath -Name "node" -DefaultCandidates $nodeCandidates
    $pnpmInvocation = Resolve-PnpmInvocation -RequestedPath $PnpmPath -NodeExecutable $node
    $pnpm = $pnpmInvocation.Executable
    $pnpmPrefixArguments = @($pnpmInvocation.PrefixArguments)
    $trustedToolIdentities = New-Object System.Collections.Generic.List[object]
    $trustedToolPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($tool in @(
        [pscustomobject]@{ Name = "Git"; Path = $git },
        [pscustomobject]@{ Name = "Node.js"; Path = $node }
    )) {
        if ($trustedToolPaths.Add($tool.Path)) {
            [void]$trustedToolIdentities.Add((Get-TrustedToolIdentity -Name $tool.Name -Path $tool.Path))
        }
    }
    foreach ($identityPath in @($pnpmInvocation.IdentityPaths)) {
        if ($trustedToolPaths.Add($identityPath)) {
            [void]$trustedToolIdentities.Add((Get-TrustedToolIdentity -Name "pnpm entry point" -Path $identityPath))
        }
    }
    $effectiveAutoCrlf = Get-ValidatedEffectiveAutoCrlf -Git $git
    Initialize-SafeGitEnvironment -GlobalAutoCrlf $effectiveAutoCrlf
    $vesktopExecutable = $null
    if (-not $SkipRestart) {
        $vesktopExecutable = Find-VesktopExecutable
        if ([string]::IsNullOrWhiteSpace($vesktopExecutable)) {
            throw "A valid canonical Vesktop.exe launcher is required before installation. Use -SkipRestart to build without restarting."
        }
        if ($trustedToolPaths.Add($vesktopExecutable)) {
            [void]$trustedToolIdentities.Add((Get-TrustedToolIdentity -Name "Vesktop launcher" -Path $vesktopExecutable))
        }
    }
    Assert-TrustedToolSet -Identities $trustedToolIdentities.ToArray()
    $vencordRoot = Resolve-VencordRoot -RequestedPath $VencordPath
    $userPluginsPath = Assert-VencordRootPathsSafe -Path $vencordRoot
    $pluginPath = Join-Path $userPluginsPath $PluginDirectoryName

    $createdPluginDirectory = $false
    $createdPluginCommit = $null
    $createdPluginIdentity = $null
    $createdPluginDirectoryIdentity = $null
    $createdPluginGitDirectoryIdentity = $null
    $previousCommit = $null
    $previousPluginDirectoryIdentity = $null
    $previousPluginGitDirectoryIdentity = $null
    $backupPluginPath = $null
    $swappedExistingCheckout = $false
    $sourceRollbackRequired = $false
    $operation = "installed"

    [void](Assert-SafePluginDestination -PluginPath $pluginPath -UserPluginsPath $userPluginsPath)

    if (Test-Path -LiteralPath $pluginPath) {
        $operation = "updated"
        $previousCommit = Assert-PluginCheckout -Git $git -PluginPath $pluginPath
        Assert-CleanCheckout -Git $git -PluginPath $pluginPath
        $previousPluginDirectoryIdentity = Get-StableFileSystemIdentity -Path $pluginPath
        $previousPluginGitDirectoryIdentity = Get-StableFileSystemIdentity -Path (Join-Path $pluginPath ".git")

        Write-Host "Preparing a verified Custom Soundboard update candidate..."
        $temporaryName = ".$PluginDirectoryName.install.$([Guid]::NewGuid().ToString('N'))"
        $temporaryPluginPath = Join-Path $userPluginsPath $temporaryName
        [void](New-Item -ItemType Directory -Path $temporaryPluginPath -ErrorAction Stop)
        $removeTemporaryPlugin = $true
        try {
            [void](Assert-SafeChildDestination -ChildPath $temporaryPluginPath -UserPluginsPath $userPluginsPath)
            Invoke-CheckedCommand -Executable $git -Arguments @("clone", "--branch", $ExpectedBranch, "--single-branch", "--", $RepositoryUrl, $temporaryPluginPath) -WorkingDirectory $userPluginsPath
            $createdPluginCommit = Assert-PluginCheckout -Git $git -PluginPath $temporaryPluginPath
            Assert-CleanCheckout -Git $git -PluginPath $temporaryPluginPath
            $createdPluginIdentity = [Guid]::NewGuid().ToString("N")
            [System.IO.File]::WriteAllText((Join-Path $temporaryPluginPath ".git\custom-soundboard-installer-identity"), $createdPluginIdentity)
            Assert-InstallerOwnedFreshCheckout -Git $git -PluginPath $temporaryPluginPath -Commit $createdPluginCommit -Identity $createdPluginIdentity

            if ($createdPluginCommit -eq $previousCommit) {
                $operation = "already up to date"
                Remove-ValidatedGitCheckoutTree -Path $temporaryPluginPath -UserPluginsPath $userPluginsPath
                $removeTemporaryPlugin = $false
            } else {
                if (-not (Test-CommandSuccess -Executable $git -Arguments @("merge-base", "--is-ancestor", $previousCommit, $createdPluginCommit) -WorkingDirectory $temporaryPluginPath)) {
                    throw "origin/$ExpectedBranch does not fast-forward the installed commit. The existing checkout was not changed."
                }
                Assert-ExistingCheckoutIdentityAndState -Git $git -PluginPath $pluginPath -PluginIdentity $previousPluginDirectoryIdentity -GitDirectoryIdentity $previousPluginGitDirectoryIdentity -Commit $previousCommit
                Assert-InstallerOwnedFreshCheckout -Git $git -PluginPath $temporaryPluginPath -Commit $createdPluginCommit -Identity $createdPluginIdentity
                $backupPluginPath = Join-Path $userPluginsPath (".$PluginDirectoryName.backup." + [Guid]::NewGuid().ToString("N"))
                [void](Assert-SafeChildDestination -ChildPath $backupPluginPath -UserPluginsPath $userPluginsPath)
                if (Test-Path -LiteralPath $backupPluginPath) {
                    throw "The transaction backup destination already exists."
                }
                [System.IO.Directory]::Move($pluginPath, $backupPluginPath)
                try {
                    [System.IO.Directory]::Move($temporaryPluginPath, $pluginPath)
                } catch {
                    if (-not (Test-Path -LiteralPath $pluginPath)) {
                        try { [System.IO.Directory]::Move($backupPluginPath, $pluginPath) } catch { }
                    }
                    throw "Installing the verified update candidate failed. The transaction paths were preserved: $($_.Exception.Message)"
                }
                $removeTemporaryPlugin = $false
                $swappedExistingCheckout = $true
                $sourceRollbackRequired = $true
                $createdPluginDirectoryIdentity = Get-StableFileSystemIdentity -Path $pluginPath
                $createdPluginGitDirectoryIdentity = Get-StableFileSystemIdentity -Path (Join-Path $pluginPath ".git")
                Assert-InstallerOwnedFreshCheckout -Git $git -PluginPath $pluginPath -Commit $createdPluginCommit -Identity $createdPluginIdentity
                Assert-ExistingCheckoutIdentityAndState -Git $git -PluginPath $backupPluginPath -PluginIdentity $previousPluginDirectoryIdentity -GitDirectoryIdentity $previousPluginGitDirectoryIdentity -Commit $previousCommit
            }
        } finally {
            if ($removeTemporaryPlugin -and (Test-Path -LiteralPath $temporaryPluginPath)) {
                Remove-SafeCheckoutTree -Path $temporaryPluginPath -UserPluginsPath $userPluginsPath
            }
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
            $createdPluginCommit = Assert-PluginCheckout -Git $git -PluginPath $temporaryPluginPath
            Assert-CleanCheckout -Git $git -PluginPath $temporaryPluginPath
            $createdPluginIdentity = [Guid]::NewGuid().ToString("N")
            [System.IO.File]::WriteAllText((Join-Path $temporaryPluginPath ".git\custom-soundboard-installer-identity"), $createdPluginIdentity)
            [void](Assert-SafePluginDestination -PluginPath $pluginPath -UserPluginsPath $userPluginsPath)
            Assert-InstallerOwnedFreshCheckout -Git $git -PluginPath $temporaryPluginPath -Commit $createdPluginCommit -Identity $createdPluginIdentity
            [System.IO.Directory]::Move($temporaryPluginPath, $pluginPath)
            $removeTemporaryPlugin = $false
            $createdPluginDirectory = $true
            $sourceRollbackRequired = $true
            try {
                Assert-InstallerOwnedFreshCheckout -Git $git -PluginPath $pluginPath -Commit $createdPluginCommit -Identity $createdPluginIdentity
                $createdPluginDirectoryIdentity = Get-StableFileSystemIdentity -Path $pluginPath
                $createdPluginGitDirectoryIdentity = Get-StableFileSystemIdentity -Path (Join-Path $pluginPath ".git")
            } catch {
                throw "The installed plugin checkout failed post-move validation. It was preserved and must be inspected manually: $($_.Exception.Message)"
            }
        } finally {
            if ($removeTemporaryPlugin -and (Test-Path -LiteralPath $temporaryPluginPath)) {
                Remove-SafeCheckoutTree -Path $temporaryPluginPath -UserPluginsPath $userPluginsPath
            }
        }
    }

    Write-Host "Building Vencord..."
    Assert-TrustedToolSet -Identities $trustedToolIdentities.ToArray()
    try {
        Invoke-VencordBuild -Pnpm $pnpm -PnpmPrefixArguments $pnpmPrefixArguments -VencordRoot $vencordRoot
    } catch {
        $buildFailure = $_
        try {
            Assert-TrustedToolSet -Identities $trustedToolIdentities.ToArray()
        } catch {
            throw "The Vencord build replaced or modified a trusted installer tool. The source transaction was preserved; no Git validation, rollback, cleanup, recovery build, or restart was attempted: $($_.Exception.Message)"
        }
        Write-Warning "The Vencord build failed. Validating the source transaction before rollback..."

        if ($swappedExistingCheckout) {
            try {
                Restore-SwappedPluginCheckout -Git $git -PluginPath $pluginPath -BackupPath $backupPluginPath -PreviousCommit $previousCommit -PreviousPluginIdentity $previousPluginDirectoryIdentity -PreviousGitIdentity $previousPluginGitDirectoryIdentity -CandidateCommit $createdPluginCommit -CandidateMarker $createdPluginIdentity -CandidatePluginIdentity $createdPluginDirectoryIdentity -CandidateGitIdentity $createdPluginGitDirectoryIdentity
                $backupPluginPath = $null
            } catch {
                throw "The build failed and the update transaction changed unexpectedly. The installed and backup paths were preserved; no destructive rollback or recovery build was attempted. Original build error: $($buildFailure.Exception.Message) Validation error: $($_.Exception.Message)"
            }
        } elseif ($createdPluginDirectory) {
            try {
                Assert-FreshCheckoutFileSystemIdentity -PluginPath $pluginPath -PluginIdentity $createdPluginDirectoryIdentity -GitDirectoryIdentity $createdPluginGitDirectoryIdentity
                Assert-InstallerOwnedFreshCheckout -Git $git -PluginPath $pluginPath -Commit $createdPluginCommit -Identity $createdPluginIdentity
            } catch {
                throw "The build failed, and the newly installed plugin directory changed. It was preserved; no recovery build was attempted. Original build error: $($buildFailure.Exception.Message) Validation error: $($_.Exception.Message)"
            }
            Remove-ValidatedGitCheckoutTree -Path $pluginPath -UserPluginsPath $userPluginsPath
        } else {
            throw "The Vencord build failed before any plugin source mutation. The checkout was preserved and no recovery build was attempted: $($buildFailure.Exception.Message)"
        }

        if ($sourceRollbackRequired) {
            try {
                Invoke-VencordBuild -Pnpm $pnpm -PnpmPrefixArguments $pnpmPrefixArguments -VencordRoot $vencordRoot
                Assert-TrustedToolSet -Identities $trustedToolIdentities.ToArray()
                if ($swappedExistingCheckout) {
                    Assert-ExistingCheckoutIdentityAndState -Git $git -PluginPath $pluginPath -PluginIdentity $previousPluginDirectoryIdentity -GitDirectoryIdentity $previousPluginGitDirectoryIdentity -Commit $previousCommit
                } elseif ($createdPluginDirectory) {
                    $unexpectedPluginPath = Microsoft.PowerShell.Management\Get-Item -LiteralPath $pluginPath -Force -ErrorAction SilentlyContinue
                    if ($null -ne $unexpectedPluginPath) {
                        throw "The recovery build recreated the removed plugin path. The unexpected path was preserved for inspection and the rollback was not considered clean."
                    }
                }
            } catch {
                throw "The update failed and rebuilding the restored Vencord state also failed. Original build error: $($buildFailure.Exception.Message). Recovery error: $($_.Exception.Message)"
            }
        }
        throw "The update was rolled back because the Vencord build failed: $($buildFailure.Exception.Message)"
    }

    Assert-TrustedToolSet -Identities $trustedToolIdentities.ToArray()

    if ($swappedExistingCheckout) {
        Assert-FreshCheckoutFileSystemIdentity -PluginPath $pluginPath -PluginIdentity $createdPluginDirectoryIdentity -GitDirectoryIdentity $createdPluginGitDirectoryIdentity
        Assert-InstallerOwnedFreshCheckout -Git $git -PluginPath $pluginPath -Commit $createdPluginCommit -Identity $createdPluginIdentity
        Assert-ExistingCheckoutIdentityAndState -Git $git -PluginPath $backupPluginPath -PluginIdentity $previousPluginDirectoryIdentity -GitDirectoryIdentity $previousPluginGitDirectoryIdentity -Commit $previousCommit
    } elseif ($createdPluginDirectory) {
        Assert-FreshCheckoutFileSystemIdentity -PluginPath $pluginPath -PluginIdentity $createdPluginDirectoryIdentity -GitDirectoryIdentity $createdPluginGitDirectoryIdentity
        Assert-InstallerOwnedFreshCheckout -Git $git -PluginPath $pluginPath -Commit $createdPluginCommit -Identity $createdPluginIdentity
    } else {
        Assert-ExistingCheckoutIdentityAndState -Git $git -PluginPath $pluginPath -PluginIdentity $previousPluginDirectoryIdentity -GitDirectoryIdentity $previousPluginGitDirectoryIdentity -Commit $previousCommit
    }

    if ($swappedExistingCheckout) {
        try {
            Remove-ValidatedBackupCheckout -Git $git -BackupPath $backupPluginPath -Commit $previousCommit -PluginIdentity $previousPluginDirectoryIdentity -GitDirectoryIdentity $previousPluginGitDirectoryIdentity
            $backupPluginPath = $null
        } catch {
            throw "The build succeeded, but the transaction backup changed unexpectedly. It was preserved and Vesktop was not restarted: $($_.Exception.Message)"
        }
    }

    if ($SkipRestart) {
        Write-Host "Custom Soundboard was $operation and built successfully. Restart Vesktop manually."
    } else {
        Assert-TrustedToolSet -Identities $trustedToolIdentities
        Write-Host "Restarting Vesktop..."
        Restart-Vesktop -Executable $vesktopExecutable
        Write-Host "Custom Soundboard was $operation, built, and Vesktop was restarted successfully."
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    Remove-SafeGitEnvironment
}
