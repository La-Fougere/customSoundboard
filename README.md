# Custom Soundboard for Vencord

> [!CAUTION]
> ## Vesktop only
> This plugin is designed exclusively for **Vesktop**. It is not compatible with the official Discord Desktop client and is not supported by the Vencord or Vesktop teams.

Custom Soundboard is an unofficial Vencord userplugin that imports local audio, organizes it in a searchable library, and mixes playback into Vesktop's outgoing voice stream.

## Features

- Import local audio files or scan a connected folder.
- Search, favorites, custom ordering, names, emojis, per-sound volume, and non-destructive start/end trims.
- Up to eight simultaneous sounds, with separate local-monitor and voice-send volume controls.
- Optional automatic send-level adjustment relative to the user's speaking level.
- Complete ZIP backup and Add/Replace restore modes for audio and metadata.
- Read-only connected-folder access: restore never writes, overwrites, or deletes files in the selected folder; missing backup audio is restored to local plugin storage.
- Explicit mono voice output.
- Self-mute is respected: soundboard playback does not enable the outgoing mixed track or speaking state while muted.
- Optional replacement of Vesktop's native soundboard buttons with the custom soundboard.

## Requirements

1. **Vesktop**.
2. A Vencord source checkout prepared for custom plugins.
3. Git, Node.js, and pnpm as required by the current Vencord source tree.
4. **Restart prerequisites:** for the default automatic restart, Windows must have a valid canonical `Vesktop.exe`; Linux must have a valid canonical Vesktop launcher plus `pgrep`, `pkill`, `nohup`, `sleep`, and `grep`. These restart-only prerequisites are not required with `-SkipRestart` or `--skip-restart`.

Follow the official Vencord custom-plugin setup guide before installing this plugin:

https://docs.vencord.dev/installing/custom-plugins/

## Manual installation

From the root of your Vencord source checkout:

```sh
cd src/userplugins
git clone https://github.com/La-Fougere/customSoundboard.git customSoundboard.vesktop
cd ../..
pnpm build
```

Restart Vesktop after the build succeeds.

The explicit `customSoundboard.vesktop` destination is required because this plugin targets Vesktop only. Vencord's `.web` target is broader and would also include browser, extension, and userscript builds.

## Updating

Use one of the hardened installer scripts below for updates. A short manual `git status`/fetch/merge recipe is intentionally not provided: assume-unchanged or skip-worktree index flags can conceal tracked changes, and safe updating also requires strict origin/config/path checks, ignored and untracked data checks, canonical Git-directory confinement, and transaction-safe rollback. Restart Vesktop only after the mandatory build succeeds. A restart without rebuilding does not install updated TypeScript, TSX, or CSS sources.

## Installer scripts

This repository includes:

- `install-custom-soundboard-windows.ps1`
- `install-custom-soundboard-linux.sh`

Each installer:

1. collects, canonicalizes, and deduplicates every valid Vencord source checkout from all supported Vesktop state files, current/script-directory ancestors, and common source locations before making one global selection;
2. clones this repository into `src/userplugins/customSoundboard.vesktop`, or prepares an independently validated update candidate and swaps it with an existing clean clone only after proving fast-forward ancestry;
3. checks GitHub on every later launch and applies an available fast-forward update;
4. runs `pnpm build` on every successful execution from the Vencord root after validating the current `origin/main` candidate, including when the installed commit is already current;
5. rejects every inherited `GIT_*` variable (including `GIT_TRACE`, all `GIT_TRACE_*` and `GIT_TRACE2*` variants, and `GIT_PAGER`), the generic pager variables `PAGER`, `LESS`, and `LV`, upper- and lower-case proxy variables, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_OPTIONS`, `NODE_PATH`, and all `NPM_CONFIG_*`/`npm_config_*`, `PNPM_*`, and `COREPACK_*` variables; Linux additionally refuses inherited `LD_PRELOAD`, `LD_AUDIT`, and `LD_LIBRARY_PATH`, starts through the absolute `/bin/bash -p` shebang, refuses sourced execution and inherited shell startup/options state, ignores inherited `PATH`, and resolves tools only from a fixed system path or explicit absolute overrides; Windows refuses anything except a new `powershell.exe` process invoked with exact `-NoProfile`, `-NonInteractive`, and `-File` arguments, does not resolve Git, Node.js, or pnpm through inherited `PATH`, obtains machine installation roots from .NET known folders rather than inherited `ProgramFiles` variables, and invokes a discovered pnpm JavaScript entry point through the validated Node executable when available; both builds use only the fixed system command path, do not add override directories to `PATH`, neutralize npm user/global configuration with `NUL` or `/dev/null`, isolate Git behind null configuration, and validate worktree content against `HEAD` through a fresh temporary index with filesystem monitoring disabled;
6. requires Git's canonical top-level, Git-directory, and common-directory paths to match each checkout; rejects `.git/commondir`, object alternates, every symbolic-link/junction/reparse indirection below `.git`, and hardlinked mutable Git metadata outside `.git/objects`; and repeats these checks immediately before transaction swaps, rollback moves, and validated recursive removal;
7. proves canonical `src` and `src/userplugins` remain inside the canonical Vencord root and rejects symbolic links, junctions, or reparse points in that destination chain before creating temporary, backup, or final plugin paths;
8. rejects every existing checkout containing assume-unchanged or skip-worktree index entries, modified or staged tracked content, or untracked or ignored local data before preparing an update candidate or building; gives each candidate a random installer-owned identity marker and revalidates its exact commit, configuration, paths, index state, and completely clean tracked/untracked/ignored worktree before any swap;
9. records stable out-of-tree filesystem identities for the existing checkout, its `.git` directory, the update candidate, and the candidate `.git`; keeps the original checkout as a sibling transaction backup during the build; restores that exact original directory on an ordinary controlled build failure; and, if the installed candidate, its `.git`, or the backup was replaced or gained tracked, untracked, or ignored data, preserves every occupied transaction path and performs neither destructive cleanup nor a recovery build;
10. gives installed-checkout preference during ambiguous autodetection only to one fully valid, clean checkout with the expected strict origin, branch, upstream, structure, local configuration, and confined Git metadata; a plain file, unrelated directory, invalid repository, or wrong-origin clone never breaks an ambiguity tie; and
11. records the canonical path, stable filesystem identity, and SHA-256 of Git, Node.js, the pnpm executable or JavaScript entry point, restart/security tools, and any selected Linux `.desktop` entry before the build; freezes Linux desktop-entry lookup to the selected trusted XDG roots; selects the Windows launcher only from OS-known local-application-data or Program Files roots, never inherited `PATH`, process metadata, or environment path variables; revalidates the captured files immediately when the build returns and again before restart, post-build Git validation, rollback, or cleanup; and resolves all restart-only prerequisites before clone or update-candidate preparation. Restart success still requires observing a recognized Vesktop process or application identity rather than mere launcher survival.

On every reexecution, the installer verifies the existing checkout, clones and validates the current explicit `origin/main` into a temporary sibling, proves fast-forward ancestry, swaps only when needed, runs `pnpm build`, and restarts Vesktop by default. If the installed commit already matches `origin/main`, it reports that Custom Soundboard is already up to date but still builds and restarts; `-SkipRestart` or `--skip-restart` suppresses only the restart. Duplicate state-file paths are deduplicated. If several distinct candidates remain, a fully valid expected plugin checkout is preferred only when it is unique; otherwise an interactive run asks for a choice and noninteractive use must provide the path explicitly.

For a verified existing checkout, the installer uses a swap/backup transaction rather than `reset --hard` plus `clean -fdx`. An ordinary controlled build failure restores the exact original checkout directory and runs one recovery build. If rollback safety cannot be proven because either transaction path or Git directory was replaced or because unexpected tracked, untracked, or ignored data appeared, all occupied paths and bytes are preserved and no recovery build or restart is attempted. Fresh-install cleanup remains conditional on the same exact ownership, identity, configuration, path, and cleanliness proofs.

### Security model

The trust boundary begins only when the installer starts in a clean process as documented below. The installer checks hostile filesystem, tool, environment, and Git states that are present when each validation runs. Immutable Git object files under `.git/objects` may be hardlinked by a normal local clone, so the hardlink rule applies to mutable metadata outside that object directory; `objects/info/alternates` remains forbidden. A separate process running concurrently with the same privileges after the immediate checks could still race later operations; that concurrent same-account tampering is outside the threat model. The build itself is not trusted to replace Git, Node.js, pnpm, their entry point, or the recorded validators and then have the result accepted: tool identity and SHA-256 are checked before post-build validation or restart.

### Windows

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\install-custom-soundboard-windows.ps1
```

Start a new `powershell.exe` exactly as shown. The script refuses dot-sourcing, an existing PowerShell session, abbreviated/missing host arguments, and profile-enabled or interactive invocation. This check cannot undo a profile or other code that was already executed in the launching process, so such a process is outside the selected trust boundary. The script derives candidates from the supported `%APPDATA%` and `%LOCALAPPDATA%` Vesktop `state.json` locations, including a configured `vencordDir`, and also checks current/script-directory ancestors and common Vencord source folders. It combines all valid candidates before selection rather than giving any source priority. If necessary, pass `-VencordPath "C:\path\to\Vencord"`. Git and Node.js are discovered only in supported machine installation locations obtained from .NET known folders, and pnpm is loaded from a validated JavaScript entry point next to Node.js. For other layouts, pass explicit trusted absolute paths with `-GitPath`, `-NodePath`, and `-PnpmPath`; `-PnpmPath` accepts a native executable or a `.js`, `.cjs`, or `.mjs` entry point. Use `-SkipRestart` only when you intentionally want to restart Vesktop yourself.

### Linux

```sh
chmod +x ./install-custom-soundboard-linux.sh
./install-custom-soundboard-linux.sh
```

Run the executable directly as shown; sourcing is intentionally refused, and the absolute privileged shebang prevents Bash startup files and exported functions from being processed by Bash before the script. Linux cannot protect against `LD_PRELOAD`, `LD_AUDIT`, or `LD_LIBRARY_PATH` code that the dynamic loader already executed before Bash started; the script rejects those inherited variables as a preflight signal, but a process in which loader-injected code already ran is outside the selected trust boundary. The script uses Node.js's JSON parser for native, Flatpak, and Snap Vesktop state files, so multiline JSON and escaped `vencordDir` values are handled correctly. It combines those state candidates with current/script-directory ancestors and common Vencord source folders before selection, without source-priority tiers. If necessary, pass `/path/to/Vencord`. Tools installed outside the fixed system command path can be supplied explicitly with `--git-path`, `--node-path`, and `--pnpm-path`, each followed by a trusted absolute path; override directories are not added to the build `PATH`. When several unrelated checkouts remain ambiguous, an interactive run asks which one to use; noninteractive use must then provide the path explicitly. Use `--skip-restart` only when you intentionally want to restart Vesktop yourself.

## Data and network behavior

- Sound metadata and imported audio remain in Vencord's local data storage.
- A connected audio folder is requested with read-only permission.
- The plugin does not upload library audio or use an external catalog API.
- MyInstants is mentioned only as a non-affiliated recommendation in settings; the plugin sends no request to it.

Back up your library from the plugin before major updates or changing devices.

## AI disclosure

The plugin code was produced predominantly with AI assistance under human direction, review, testing, and security auditing. The project is still intended to be maintained and evaluated with the same rigor as manually written software.

## Unofficial plugin notice

This repository is an unofficial community plugin. Install it only if you understand Vencord's custom-plugin build process and trust the source. Support questions should be directed to this repository rather than official Vencord support channels.

## License

Custom Soundboard is licensed under the **GNU General Public License v3.0 or later** (`GPL-3.0-or-later`). See [`LICENSE`](./LICENSE).
