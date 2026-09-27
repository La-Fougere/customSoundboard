#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="https://github.com/La-Fougere/customSoundboard.git"
EXPECTED_BRANCH="main"
PLUGIN_DIRECTORY_NAME="customSoundboard.vesktop"
SKIP_RESTART=0
VENCORD_PATH=""

usage() {
    cat <<'EOF'
Usage: install-custom-soundboard-linux.sh [--skip-restart] [VENCORD_PATH]

Installs or updates Custom Soundboard in a Vencord source checkout, builds
Vencord, and restarts Vesktop after a successful build.
EOF
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

assert_safe_git_environment() {
    local name
    for name in \
        GIT_DIR \
        GIT_WORK_TREE \
        GIT_INDEX_FILE \
        GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES \
        GIT_COMMON_DIR; do
        [[ ! -v "$name" ]] || fail "Refusing to run while the inherited Git environment variable '$name' is set."
    done

    while IFS= read -r name; do
        case "$name" in
            GIT_CONFIG|GIT_CONFIG_*)
                fail "Refusing to run while the inherited Git environment variable '$name' is set."
                ;;
        esac
    done < <(compgen -e)
}

normalize_repo_url() {
    local value=${1//\\//}
    value=${value%/}
    value=${value%.git}
    printf '%s' "${value,,}"
}

assert_safe_child_destination() {
    local path=$1
    local parent name canonical_path
    parent=${path%/*}
    name=${path##*/}

    [[ "$parent" == "$USERPLUGINS_ROOT" && -n "$name" && "$name" != "." && "$name" != ".." ]] || {
        printf "Error: The checkout destination is not contained directly under '%s'.\n" "$USERPLUGINS_ROOT" >&2
        return 1
    }
    [[ ! -L "$path" ]] || {
        printf "Error: '%s' must not be a symbolic link.\n" "$path" >&2
        return 1
    }

    if [[ -e "$path" ]]; then
        [[ -d "$path" ]] || {
            printf "Error: '%s' exists but is not a directory.\n" "$path" >&2
            return 1
        }
        canonical_path=$(cd "$path" && pwd -P) || return 1
        [[ "$canonical_path" == "$path" ]] || {
            printf "Error: The canonical checkout destination escapes '%s'.\n" "$USERPLUGINS_ROOT" >&2
            return 1
        }
    fi
}

assert_plugin_destination_safe() {
    [[ "$PLUGIN_PATH" == "$USERPLUGINS_ROOT/$PLUGIN_DIRECTORY_NAME" ]] || {
        printf "Error: The plugin destination is not contained directly under '%s'.\n" "$USERPLUGINS_ROOT" >&2
        return 1
    }
    assert_safe_child_destination "$PLUGIN_PATH"
}

is_vencord_root() {
    local path=$1
    [[ -f "$path/package.json" && -f "$path/pnpm-lock.yaml" && -d "$path/src/userplugins" ]]
}

run_build() {
    (cd "$VENCORD_ROOT" && pnpm build)
}

assert_checkout_paths_safe() {
    local checkout_path=${1:-$PLUGIN_PATH}
    assert_safe_child_destination "$checkout_path" || return 1
    [[ ! -L "$checkout_path/.git" ]] || {
        printf "Error: '%s/.git' must not be a symbolic link.\n" "$checkout_path" >&2
        return 1
    }
    [[ -d "$checkout_path/.git" ]] || {
        printf "Error: '%s' is not a Git clone.\n" "$checkout_path" >&2
        return 1
    }

    local canonical_git_dir
    canonical_git_dir=$(cd "$checkout_path/.git" && pwd -P) || return 1
    [[ "$canonical_git_dir" == "$checkout_path/.git" ]] || {
        printf 'Error: The canonical .git directory escapes the plugin checkout.\n' >&2
        return 1
    }
}

assert_plugin_checkout() {
    local checkout_path=${1:-$PLUGIN_PATH}
    assert_checkout_paths_safe "$checkout_path" || return 1

    local actual_remote branch upstream required_file
    actual_remote=$(git -C "$checkout_path" remote get-url origin) || return 1
    [[ "$(normalize_repo_url "$actual_remote")" == "$(normalize_repo_url "$REPOSITORY_URL")" ]] || {
        printf "Error: '%s' points to '%s', not '%s'. Refusing to modify it.\n" "$checkout_path" "$actual_remote" "$REPOSITORY_URL" >&2
        return 1
    }

    branch=$(git -C "$checkout_path" symbolic-ref --quiet --short HEAD) || {
        printf 'Error: The existing plugin clone has a detached HEAD.\n' >&2
        return 1
    }
    [[ "$branch" == "$EXPECTED_BRANCH" ]] || {
        printf "Error: The plugin clone must be on the '%s' branch, not '%s'.\n" "$EXPECTED_BRANCH" "$branch" >&2
        return 1
    }

    upstream=$(git -C "$checkout_path" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}') || {
        printf 'Error: The plugin branch has no upstream.\n' >&2
        return 1
    }
    [[ "$upstream" == "origin/$EXPECTED_BRANCH" ]] || {
        printf "Error: The plugin branch must track 'origin/%s', not '%s'.\n" "$EXPECTED_BRANCH" "$upstream" >&2
        return 1
    }

    CHECKOUT_HEAD=$(git -C "$checkout_path" rev-parse --verify 'HEAD^{commit}') || {
        printf 'Error: The plugin repository has no valid commit.\n' >&2
        return 1
    }

    for required_file in index.ts README.md LICENSE; do
        [[ -f "$checkout_path/$required_file" ]] || {
            printf "Error: The plugin checkout is missing required file '%s'.\n" "$required_file" >&2
            return 1
        }
    done
}

assert_clean_checkout() {
    local checkout_path=${1:-$PLUGIN_PATH}
    [[ -z "$(git -C "$checkout_path" status --porcelain --untracked-files=all)" ]] || {
        printf 'Error: The existing plugin clone has local changes. Commit, stash, or remove them before updating.\n' >&2
        return 1
    }
}

restore_plugin_checkout() {
    local commit=$1
    assert_checkout_paths_safe "$PLUGIN_PATH" || return 1
    git -C "$PLUGIN_PATH" reset --hard "$commit" || return 1
    git -C "$PLUGIN_PATH" clean -fdx || return 1
    assert_plugin_checkout || return 1
    [[ "$CHECKOUT_HEAD" == "$commit" ]] || return 1
    assert_clean_checkout
}

cleanup_temporary_checkout() {
    local temporary_path=${TEMP_PLUGIN_PATH:-}
    [[ -n "$temporary_path" ]] || return 0
    if [[ -e "$temporary_path" || -L "$temporary_path" ]]; then
        assert_safe_child_destination "$temporary_path" || return 1
        rm -rf -- "$temporary_path" || return 1
    fi
    TEMP_PLUGIN_PATH=""
}

find_vesktop_launcher() {
    local command_path canonical_command_path
    command_path=$(type -P vesktop 2>/dev/null || true)
    if [[ -n "$command_path" ]]; then
        canonical_command_path=$(readlink -f -- "$command_path" 2>/dev/null) || return 1
        [[ -x "$canonical_command_path" ]] || return 1
        VESKTOP_LAUNCHER=("$canonical_command_path")
        if [[ "$canonical_command_path" == *.AppImage || "$canonical_command_path" == *.appimage ]]; then
            VESKTOP_LAUNCHER_KIND="appimage"
        else
            VESKTOP_LAUNCHER_KIND="command"
        fi
        return 0
    fi

    if command -v flatpak >/dev/null 2>&1 && flatpak info dev.vencord.Vesktop >/dev/null 2>&1; then
        VESKTOP_LAUNCHER_KIND="flatpak"
        VESKTOP_LAUNCHER=(flatpak run dev.vencord.Vesktop)
        return 0
    fi

    if command -v snap >/dev/null 2>&1 && snap list vesktop >/dev/null 2>&1; then
        VESKTOP_LAUNCHER_KIND="command"
        VESKTOP_LAUNCHER=(snap run vesktop)
        return 0
    fi

    local candidate
    for candidate in \
        "$HOME/Applications/Vesktop.AppImage" \
        "$HOME/Applications/vesktop.AppImage" \
        "$HOME/.local/bin/Vesktop.AppImage" \
        "$HOME/.local/bin/vesktop.AppImage"; do
        if [[ -x "$candidate" ]]; then
            VESKTOP_LAUNCHER_KIND="appimage"
            VESKTOP_LAUNCHER=("$candidate")
            return 0
        fi
    done

    if command -v gtk-launch >/dev/null 2>&1; then
        local desktop_file desktop_id
        for desktop_file in \
            "$HOME/.local/share/applications/"*vesktop*.desktop \
            "$HOME/.local/share/applications/"*Vesktop*.desktop \
            /usr/share/applications/*vesktop*.desktop \
            /usr/share/applications/*Vesktop*.desktop; do
            [[ -f "$desktop_file" ]] || continue
            desktop_id=${desktop_file##*/}
            desktop_id=${desktop_id%.desktop}
            VESKTOP_LAUNCHER_KIND="desktop"
            VESKTOP_LAUNCHER=(gtk-launch "$desktop_id")
            return 0
        done
    fi

    return 1
}

vesktop_process_running() {
    pgrep -x vesktop >/dev/null 2>&1 ||
        pgrep -x Vesktop >/dev/null 2>&1 ||
        pgrep -x vesktop.bin >/dev/null 2>&1
}

restart_vesktop() {
    command -v pgrep >/dev/null 2>&1 || fail "pgrep is required to restart Vesktop."
    command -v pkill >/dev/null 2>&1 || fail "pkill is required to restart Vesktop."

    if ! find_vesktop_launcher; then
        fail "The plugin was built successfully, but no Vesktop launcher was found. Start Vesktop manually."
    fi

    local process_name
    for process_name in vesktop Vesktop vesktop.bin; do
        pkill -x "$process_name" 2>/dev/null || true
    done

    local attempts=0
    while (( attempts < 50 )); do
        if ! vesktop_process_running; then
            break
        fi
        sleep 0.2
        ((attempts += 1))
    done

    if vesktop_process_running; then
        fail "Vesktop did not stop within 10 seconds."
    fi

    nohup "${VESKTOP_LAUNCHER[@]}" >/dev/null 2>&1 &
    local launcher_pid=$!
    sleep 2

    if [[ "$VESKTOP_LAUNCHER_KIND" == "flatpak" ]]; then
        if ! flatpak ps --columns=application 2>/dev/null | grep -Fxq "dev.vencord.Vesktop"; then
            fail "Vesktop did not become visible after the Flatpak launch request."
        fi
    elif [[ "$VESKTOP_LAUNCHER_KIND" == "appimage" ]]; then
        attempts=0
        while (( attempts < 50 )); do
            if vesktop_process_running; then
                return 0
            fi
            kill -0 "$launcher_pid" 2>/dev/null || break
            sleep 0.2
            ((attempts += 1))
        done
        fail "Vesktop was launched from the AppImage, but no Vesktop process became visible."
    elif ! kill -0 "$launcher_pid" 2>/dev/null && ! vesktop_process_running; then
        fail "Vesktop was launched but no Vesktop process became visible."
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-restart)
            SKIP_RESTART=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --*)
            fail "Unknown option: $1"
            ;;
        *)
            [[ -z "$VENCORD_PATH" ]] || fail "Only one Vencord path may be supplied."
            VENCORD_PATH=$1
            ;;
    esac
    shift
done

assert_safe_git_environment
command -v git >/dev/null 2>&1 || fail "git is required."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required."

if [[ -z "$VENCORD_PATH" ]]; then
    if is_vencord_root "$PWD"; then
        VENCORD_PATH=$PWD
    elif [[ -t 0 ]]; then
        read -r -p "Path to your Vencord source checkout: " VENCORD_PATH
    else
        fail "A Vencord source path is required."
    fi
fi

[[ -d "$VENCORD_PATH" ]] || fail "Vencord path does not exist: $VENCORD_PATH"
VENCORD_ROOT=$(cd "$VENCORD_PATH" && pwd -P)
is_vencord_root "$VENCORD_ROOT" || fail "'$VENCORD_ROOT' is not a valid Vencord source checkout (package.json, pnpm-lock.yaml, or src/userplugins is missing)."

USERPLUGINS_ROOT=$(cd "$VENCORD_ROOT/src/userplugins" && pwd -P)
PLUGIN_PATH="$USERPLUGINS_ROOT/$PLUGIN_DIRECTORY_NAME"
CREATED_PLUGIN_DIRECTORY=0
PREVIOUS_COMMIT=""
TEMP_PLUGIN_PATH=""
trap 'cleanup_temporary_checkout || true' EXIT

assert_plugin_destination_safe || fail "The plugin destination is unsafe."

if [[ -e "$PLUGIN_PATH" ]]; then
    assert_plugin_checkout || fail "The existing plugin checkout is invalid."
    assert_clean_checkout || fail "The existing plugin checkout is not clean."
    PREVIOUS_COMMIT=$CHECKOUT_HEAD

    printf 'Updating Custom Soundboard from the verified origin/main...\n'
    UPDATE_ERROR=""
    if ! git -C "$PLUGIN_PATH" fetch --force --prune origin "refs/heads/$EXPECTED_BRANCH:refs/remotes/origin/$EXPECTED_BRANCH"; then
        UPDATE_ERROR="Fetching origin/$EXPECTED_BRANCH failed."
    elif ! REMOTE_COMMIT=$(git -C "$PLUGIN_PATH" rev-parse --verify "refs/remotes/origin/$EXPECTED_BRANCH^{commit}"); then
        UPDATE_ERROR="origin/$EXPECTED_BRANCH has no valid commit."
    elif ! git -C "$PLUGIN_PATH" merge-base --is-ancestor "$PREVIOUS_COMMIT" "$REMOTE_COMMIT"; then
        UPDATE_ERROR="origin/$EXPECTED_BRANCH does not fast-forward the installed commit."
    elif ! git -C "$PLUGIN_PATH" merge --ff-only "refs/remotes/origin/$EXPECTED_BRANCH"; then
        UPDATE_ERROR="Fast-forwarding from origin/$EXPECTED_BRANCH failed."
    elif ! assert_plugin_checkout || ! assert_clean_checkout; then
        UPDATE_ERROR="The updated plugin checkout failed validation."
    fi

    if [[ -n "$UPDATE_ERROR" ]]; then
        restore_plugin_checkout "$PREVIOUS_COMMIT" || fail "$UPDATE_ERROR Restoring the previous plugin checkout also failed."
        fail "$UPDATE_ERROR The previous plugin checkout was restored."
    fi
else
    printf 'Installing Custom Soundboard...\n'
    TEMP_PLUGIN_PATH=$(mktemp -d "$USERPLUGINS_ROOT/.${PLUGIN_DIRECTORY_NAME}.install.XXXXXXXX") || fail "Creating a temporary checkout directory failed."
    assert_safe_child_destination "$TEMP_PLUGIN_PATH" || fail "The temporary checkout destination is unsafe."

    if ! git clone --branch "$EXPECTED_BRANCH" --single-branch -- "$REPOSITORY_URL" "$TEMP_PLUGIN_PATH"; then
        cleanup_temporary_checkout || fail "Cloning origin/$EXPECTED_BRANCH failed, and cleaning the temporary checkout also failed."
        fail "Cloning origin/$EXPECTED_BRANCH failed."
    fi
    if ! assert_plugin_checkout "$TEMP_PLUGIN_PATH" || ! assert_clean_checkout "$TEMP_PLUGIN_PATH"; then
        cleanup_temporary_checkout || fail "The cloned plugin checkout was invalid, and cleaning the temporary checkout also failed."
        fail "The cloned plugin checkout was invalid and has been removed."
    fi

    assert_plugin_destination_safe || {
        cleanup_temporary_checkout || true
        fail "The plugin destination became unsafe before installation."
    }
    mv -Tn -- "$TEMP_PLUGIN_PATH" "$PLUGIN_PATH" || {
        cleanup_temporary_checkout || true
        fail "Atomically installing the validated plugin checkout failed."
    }
    if [[ -e "$TEMP_PLUGIN_PATH" || -L "$TEMP_PLUGIN_PATH" ]]; then
        cleanup_temporary_checkout || true
        fail "The plugin destination appeared during installation; the validated temporary checkout was not installed."
    fi
    TEMP_PLUGIN_PATH=""
    CREATED_PLUGIN_DIRECTORY=1
fi

printf 'Building Vencord...\n'
if ! run_build; then
    printf 'The Vencord build failed. Restoring the previous plugin state...\n' >&2

    if (( CREATED_PLUGIN_DIRECTORY == 1 )); then
        assert_plugin_destination_safe || fail "The build failed, but the installed plugin destination became unsafe to remove."
        rm -rf -- "$PLUGIN_PATH"
    elif [[ -n "$PREVIOUS_COMMIT" ]]; then
        restore_plugin_checkout "$PREVIOUS_COMMIT" || fail "The build failed and restoring the previous plugin checkout also failed."
    fi

    if ! run_build; then
        fail "The update failed and rebuilding the previous Vencord state also failed."
    fi

    fail "The update was rolled back because the Vencord build failed."
fi

if (( SKIP_RESTART == 1 )); then
    printf 'Custom Soundboard was installed and built successfully. Restart Vesktop manually.\n'
else
    printf 'Restarting Vesktop...\n'
    restart_vesktop
    printf 'Custom Soundboard was installed, built, and Vesktop was restarted successfully.\n'
fi
