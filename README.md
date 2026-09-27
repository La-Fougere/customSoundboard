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

From the root of your Vencord source checkout:

```sh
cd src/userplugins/customSoundboard.vesktop
test "$(git remote get-url origin)" = "https://github.com/La-Fougere/customSoundboard.git"
test "$(git branch --show-current)" = "main"
test "$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" = "origin/main"
test -z "$(git status --porcelain --untracked-files=all)"
git fetch --force --prune origin refs/heads/main:refs/remotes/origin/main
git merge-base --is-ancestor HEAD refs/remotes/origin/main
git merge --ff-only refs/remotes/origin/main
cd ../../..
pnpm build
```

These commands intentionally stop if the clone has an unexpected origin, branch, upstream, local changes, or non-fast-forward history. Restart Vesktop only after the build succeeds. A restart without rebuilding does not install updated TypeScript, TSX, or CSS sources.

## One-command installers

Release assets include:

- `install-custom-soundboard-windows.ps1`
- `install-custom-soundboard-linux.sh`

Each installer:

1. validates the selected Vencord source checkout;
2. clones this repository into `src/userplugins/customSoundboard.vesktop`, or safely fast-forwards an existing clean clone;
3. runs `pnpm build` from the Vencord root;
4. rolls the plugin source back if the build fails; and
5. restarts Vesktop only after a successful build.

### Windows

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-custom-soundboard-windows.ps1 -VencordPath "C:\path\to\Vencord"
```

If `-VencordPath` is omitted, the script uses the current directory when it is a valid Vencord source checkout; otherwise it prompts for a path. Use `-SkipRestart` only when you intentionally want to restart Vesktop yourself.

### Linux

```sh
chmod +x ./install-custom-soundboard-linux.sh
./install-custom-soundboard-linux.sh /path/to/Vencord
```

If the path is omitted, the script uses the current directory when it is a valid Vencord source checkout. Otherwise it prompts only in an interactive terminal; noninteractive use requires an explicit path. Use `--skip-restart` only when you intentionally want to restart Vesktop yourself.

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
