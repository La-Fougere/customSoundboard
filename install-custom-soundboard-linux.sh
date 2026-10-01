#!/bin/bash -p

if [[ ! -x /usr/bin/env ]]; then
    /usr/bin/printf 'Error: /usr/bin/env is required to validate the inherited shell environment.\n' >&2
    /bin/false
elif ! INHERITED_SHELL_ENVIRONMENT=$'\n'$(/usr/bin/env 2>/dev/null)$'\n'; then
    /usr/bin/printf 'Error: The inherited shell environment could not be inspected safely.\n' >&2
    /bin/false
elif [[ "$-" != *p* || "${BASH_SOURCE[0]}" != "$0" ||
        "$INHERITED_SHELL_ENVIRONMENT" == *$'\nBASH_FUNC_'* ||
        "$INHERITED_SHELL_ENVIRONMENT" == *$'\nBASH_ENV='* ||
        "$INHERITED_SHELL_ENVIRONMENT" == *$'\nENV='* ||
        "$INHERITED_SHELL_ENVIRONMENT" == *$'\nSHELLOPTS='* ||
        "$INHERITED_SHELL_ENVIRONMENT" == *$'\nBASHOPTS='* ||
        "$INHERITED_SHELL_ENVIRONMENT" == *$'\nCDPATH='* ||
        "$INHERITED_SHELL_ENVIRONMENT" == *$'\nGLOBIGNORE='* ]]; then
    /usr/bin/printf 'Error: Refusing to run from a sourced script or with inherited Bash functions or shell startup/options variables.\n' >&2
    /bin/false
else
SAFE_SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PATH=$SAFE_SYSTEM_PATH
export PATH
set -Eeuo pipefail
unset INHERITED_SHELL_ENVIRONMENT

READLINK_EXECUTABLE=/usr/bin/readlink
STAT_EXECUTABLE=/usr/bin/stat
SHA256_EXECUTABLE=/usr/bin/sha256sum
FIND_EXECUTABLE=/usr/bin/find
MKTEMP_EXECUTABLE=/usr/bin/mktemp
RM_EXECUTABLE=/usr/bin/rm
MV_EXECUTABLE=/usr/bin/mv
GREP_SYSTEM_EXECUTABLE=/usr/bin/grep
TAIL_EXECUTABLE=/usr/bin/tail
DIRNAME_EXECUTABLE=/usr/bin/dirname

REPOSITORY_URL="https://github.com/La-Fougere/customSoundboard.git"
EXPECTED_BRANCH="main"
PLUGIN_DIRECTORY_NAME="customSoundboard.vesktop"
SKIP_RESTART=0
VENCORD_PATH=""
SAFE_GIT_ROOT=""
GIT_EXECUTABLE=""
PNPM_EXECUTABLE=""
NODE_EXECUTABLE=""
GIT_PATH_OVERRIDE=""
PNPM_PATH_OVERRIDE=""
NODE_PATH_OVERRIDE=""
VESKTOP_LAUNCHER_KIND=""
declare -a VESKTOP_LAUNCHER=()
VESKTOP_DESKTOP_FILE=""
VESKTOP_DESKTOP_ID=""
VESKTOP_XDG_DATA_HOME=""
VESKTOP_XDG_DATA_DIRS=""
declare -a PNPM_INVOCATION=()
declare -a TRUSTED_TOOL_PREFIXES=()
TRUSTED_STAT_FD=""
TRUSTED_SHA256_FD=""
PGREP_EXECUTABLE=""
PKILL_EXECUTABLE=""
NOHUP_EXECUTABLE=""
SLEEP_EXECUTABLE=""
GREP_EXECUTABLE=""

usage() {
    cat <<'EOF'
Usage: install-custom-soundboard-linux.sh [--skip-restart]
       [--git-path PATH] [--node-path PATH] [--pnpm-path PATH] [VENCORD_PATH]

Installs or updates Custom Soundboard in a Vencord source checkout, builds
Vencord, and restarts Vesktop after a successful build. When VENCORD_PATH is
omitted, the active Vesktop configuration and common source locations are
searched automatically.
EOF
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

assert_safe_git_environment() {
    local name
    while IFS= read -r name; do
        case "$name" in
            HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|CURL_CA_BUNDLE|SSL_CERT_FILE|SSL_CERT_DIR|PAGER|LESS|LV)
                fail "Refusing to run while the inherited transport, credential, pager, or trust environment variable '$name' is set."
                ;;
            LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_*|npm_config_*|PNPM_*|COREPACK_*)
                fail "Refusing to run while the inherited loader, Node.js, npm, pnpm, or Corepack environment variable '$name' is set."
                ;;
            GIT_*)
                fail "Refusing to run while the inherited Git environment variable '$name' is set."
                ;;
        esac
    done < <(compgen -e)
}

resolve_external_executable() {
    local command_name=$1 requested_path=$2 output_variable=$3 resolved
    if [[ -n "$requested_path" ]]; then
        [[ "$requested_path" == /* ]] || fail "The explicit $command_name path must be absolute."
        resolved=$requested_path
    else
        resolved=$(builtin type -P "$command_name" 2>/dev/null) || fail "$command_name is required. Supply --$command_name-path with an absolute path if it is installed outside the trusted system command path."
    fi
    resolved=$("$READLINK_EXECUTABLE" -f -- "$resolved" 2>/dev/null) || fail "The $command_name executable could not be canonicalized."
    [[ -f "$resolved" && -x "$resolved" ]] || fail "The resolved $command_name command is not an executable file."
    printf -v "$output_variable" '%s' "$resolved"
}

resolve_git_executable() {
    resolve_external_executable git "$GIT_PATH_OVERRIDE" GIT_EXECUTABLE
}

initialize_identity_validators() {
    local canonical
    for canonical in "$STAT_EXECUTABLE" "$SHA256_EXECUTABLE"; do
        [[ -f "$canonical" && -x "$canonical" ]] || fail "The fixed identity validator '$canonical' is unavailable."
        [[ "$("$READLINK_EXECUTABLE" -f -- "$canonical")" == "$canonical" ]] || fail "The identity validator '$canonical' must be a canonical regular executable."
    done
    exec {TRUSTED_STAT_FD}<"$STAT_EXECUTABLE"
    exec {TRUSTED_SHA256_FD}<"$SHA256_EXECUTABLE"
}

get_trusted_file_identity() {
    "/proc/$$/fd/$TRUSTED_STAT_FD" -Lc '%d:%i:%s:%f' -- "$1"
}

get_trusted_file_sha256() {
    local output
    output=$("/proc/$$/fd/$TRUSTED_SHA256_FD" -- "$1") || return 1
    printf '%s' "${output%% *}"
}

capture_trusted_tool_identity() {
    local prefix=$1 path=$2 require_executable=${3:-1} canonical identity sha256
    canonical=$("$READLINK_EXECUTABLE" -f -- "$path" 2>/dev/null) || fail "The trusted tool '$path' could not be canonicalized."
    [[ "$canonical" == "$path" && -f "$canonical" ]] || fail "The trusted file '$path' must be a canonical regular file."
    (( require_executable == 0 )) || [[ -x "$canonical" ]] || fail "The trusted tool '$path' must be executable."
    identity=$(get_trusted_file_identity "$canonical") || fail "Recording the stable identity of '$canonical' failed."
    sha256=$(get_trusted_file_sha256 "$canonical") || fail "Recording the SHA-256 of '$canonical' failed."
    printf -v "${prefix}_TRUSTED_PATH" '%s' "$canonical"
    printf -v "${prefix}_TRUSTED_IDENTITY" '%s' "$identity"
    printf -v "${prefix}_TRUSTED_SHA256" '%s' "$sha256"
    printf -v "${prefix}_TRUSTED_REQUIRE_EXECUTABLE" '%s' "$require_executable"
    TRUSTED_TOOL_PREFIXES+=("$prefix")
}

assert_trusted_tool_identity() {
    local path_name="${prefix}_TRUSTED_PATH" identity_name="${prefix}_TRUSTED_IDENTITY" sha_name="${prefix}_TRUSTED_SHA256" executable_name="${prefix}_TRUSTED_REQUIRE_EXECUTABLE"
    local path=${!path_name} expected_identity=${!identity_name} expected_sha256=${!sha_name} require_executable=${!executable_name}
    local canonical current_identity current_sha256
    canonical=$("$READLINK_EXECUTABLE" -f -- "$path" 2>/dev/null) || return 1
    [[ "$canonical" == "$path" && -f "$path" ]] || return 1
    (( require_executable == 0 )) || [[ -x "$path" ]] || return 1
    current_identity=$(get_trusted_file_identity "$path") || return 1
    current_sha256=$(get_trusted_file_sha256 "$path") || return 1
    if [[ "$current_identity" != "$expected_identity" || "$current_sha256" != "$expected_sha256" ]]; then
        printf "Error: Trusted tool '%s' was replaced or modified after validation.\n" "$path" >&2
        return 1
    fi
}

assert_trusted_tool_set() {
    local prefix
    for prefix in "${TRUSTED_TOOL_PREFIXES[@]}"; do
        assert_trusted_tool_identity "$prefix" || return 1
    done
}

capture_all_trusted_tools() {
    capture_trusted_tool_identity GIT "$GIT_EXECUTABLE"
    capture_trusted_tool_identity NODE "$NODE_EXECUTABLE"
    capture_trusted_tool_identity PNPM "$PNPM_EXECUTABLE"
    capture_trusted_tool_identity READLINK "$READLINK_EXECUTABLE"
    capture_trusted_tool_identity STAT "$STAT_EXECUTABLE"
    capture_trusted_tool_identity SHA256 "$SHA256_EXECUTABLE"
    capture_trusted_tool_identity FIND "$FIND_EXECUTABLE"
    capture_trusted_tool_identity MKTEMP "$MKTEMP_EXECUTABLE"
    capture_trusted_tool_identity RM "$RM_EXECUTABLE"
    capture_trusted_tool_identity MV "$MV_EXECUTABLE"
    capture_trusted_tool_identity GREP "$GREP_SYSTEM_EXECUTABLE"
    capture_trusted_tool_identity TAIL "$TAIL_EXECUTABLE"
    capture_trusted_tool_identity DIRNAME "$DIRNAME_EXECUTABLE"
}

get_validated_autocrlf_from_scope() {
    local scope=$1 output status value
    if output=$("$GIT_EXECUTABLE" config "$scope" --no-includes --get-all core.autocrlf 2>/dev/null); then
        :
    else
        status=$?
        [[ $status == 1 ]] && return 0
        fail "Reading Git core.autocrlf from scope '$scope' failed with exit code $status."
    fi
    value=$(printf '%s\n' "$output" | "$TAIL_EXECUTABLE" -n 1)
    value=${value,,}
    case "$value" in
        true|false|input) printf '%s' "$value" ;;
        *) fail "The Git core.autocrlf value '$value' in scope '$scope' is invalid." ;;
    esac
}

get_validated_effective_autocrlf() {
    local system_value global_value
    system_value=$(get_validated_autocrlf_from_scope --system)
    global_value=$(get_validated_autocrlf_from_scope --global)
    if [[ -n "$global_value" ]]; then
        printf '%s' "$global_value"
    else
        printf '%s' "$system_value"
    fi
}

initialize_safe_git_environment() {
    local global_autocrlf=${1:-}
    SAFE_GIT_ROOT=""
    export GIT_CONFIG_NOSYSTEM=1
    export GIT_CONFIG_SYSTEM=/dev/null
    export GIT_CONFIG_GLOBAL=/dev/null
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=core.hooksPath
    export GIT_CONFIG_VALUE_0=/dev/null
    if [[ -n "$global_autocrlf" ]]; then
        export GIT_CONFIG_COUNT=2
        export GIT_CONFIG_KEY_1=core.autocrlf
        export GIT_CONFIG_VALUE_1="$global_autocrlf"
    else
        unset GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1
    fi
    export GIT_NO_REPLACE_OBJECTS=1
    export GIT_TERMINAL_PROMPT=0
}

cleanup_safe_git_environment() {
    SAFE_GIT_ROOT=""
}

is_expected_repo_url() {
    local value=$1
    [[ "$value" == "$REPOSITORY_URL" ]] && return 0
    [[ "$value" != *\\* ]] || return 1
    [[ "$value" == "$REPOSITORY_URL/" ]]
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

get_filesystem_identity() {
    local path=$1 canonical
    canonical=$(cd "$path" && pwd -P) || return 1
    "$STAT_EXECUTABLE" -Lc '%d:%i' -- "$canonical"
}

assert_fresh_checkout_filesystem_identity() {
    local checkout_path=$1 expected_checkout_identity=$2 expected_git_identity=$3
    local current_checkout_identity current_git_identity
    current_checkout_identity=$(get_filesystem_identity "$checkout_path") || return 1
    current_git_identity=$(get_filesystem_identity "$checkout_path/.git") || return 1
    if [[ "$current_checkout_identity" != "$expected_checkout_identity" || "$current_git_identity" != "$expected_git_identity" ]]; then
        printf 'Error: The newly installed plugin checkout or its .git directory was replaced after installation.\n' >&2
        return 1
    fi
}

is_vencord_root() {
    local path=$1
    [[ -f "$path/package.json" && -f "$path/pnpm-lock.yaml" && -d "$path/src/userplugins" ]]
}

assert_vencord_root_paths_safe() {
    local root=$1 canonical_root canonical_src canonical_userplugins
    canonical_root=$(cd "$root" && pwd -P) || return 1
    [[ "$canonical_root" == "$root" ]] || {
        printf "Error: The Vencord root is not canonical: '%s'.\n" "$root" >&2
        return 1
    }
    [[ ! -L "$root/src" && -d "$root/src" ]] || {
        printf "Error: '%s/src' must be a real directory, not a symbolic link.\n" "$root" >&2
        return 1
    }
    canonical_src=$(cd "$root/src" && pwd -P) || return 1
    [[ "$canonical_src" == "$root/src" ]] || {
        printf "Error: The canonical src directory escapes the Vencord root.\n" >&2
        return 1
    }
    [[ ! -L "$root/src/userplugins" && -d "$root/src/userplugins" ]] || {
        printf "Error: '%s/src/userplugins' must be a real directory, not a symbolic link.\n" "$root" >&2
        return 1
    }
    canonical_userplugins=$(cd "$root/src/userplugins" && pwd -P) || return 1
    [[ "$canonical_userplugins" == "$root/src/userplugins" ]] || {
        printf "Error: The canonical userplugins directory escapes the Vencord root.\n" >&2
        return 1
    }
}

is_valid_installed_plugin_candidate() (
    local candidate=$1
    VENCORD_ROOT=$candidate
    assert_vencord_root_paths_safe "$candidate" || return 1
    USERPLUGINS_ROOT="$candidate/src/userplugins"
    PLUGIN_PATH="$USERPLUGINS_ROOT/$PLUGIN_DIRECTORY_NAME"
    [[ -d "$PLUGIN_PATH" && ! -L "$PLUGIN_PATH" ]] || return 1
    assert_plugin_checkout "$PLUGIN_PATH" >/dev/null 2>&1 || return 1
    assert_clean_checkout "$PLUGIN_PATH" >/dev/null 2>&1
)

resolve_vencord_candidate() {
    local candidate=$1 canonical parent
    [[ -n "$candidate" && -d "$candidate" ]] || return 1
    canonical=$(cd "$candidate" 2>/dev/null && pwd -P) || return 1
    if is_vencord_root "$canonical" && assert_vencord_root_paths_safe "$canonical" 2>/dev/null; then
        printf '%s' "$canonical"
        return 0
    fi
    if [[ "${canonical##*/}" == "dist" ]]; then
        parent=${canonical%/*}
        if is_vencord_root "$parent" && assert_vencord_root_paths_safe "$parent" 2>/dev/null; then
            printf '%s' "$parent"
            return 0
        fi
    fi
    return 1
}

read_vencord_dir_from_state() {
    local state_file=$1
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/dev/null \
    npm_config_userconfig=/dev/null \
    npm_config_globalconfig=/dev/null \
    "$NODE_EXECUTABLE" -e '
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof state.vencordDir !== "string" || state.vencordDir.length === 0) process.exit(1);
process.stdout.write(state.vencordDir);
' "$state_file"
}

select_vencord_candidate() {
    local -a candidates=("$@") plugin_candidates=()
    local candidate selected index
    if (( ${#candidates[@]} == 0 )); then
        return 1
    fi
    if (( ${#candidates[@]} == 1 )); then
        printf '%s' "${candidates[0]}"
        return 0
    fi
    for candidate in "${candidates[@]}"; do
        is_valid_installed_plugin_candidate "$candidate" && plugin_candidates+=("$candidate")
    done
    if (( ${#plugin_candidates[@]} == 1 )); then
        printf '%s' "${plugin_candidates[0]}"
        return 0
    fi
    if [[ -t 0 ]]; then
        printf 'Several Vencord source checkouts were found:\n' >&2
        index=1
        for candidate in "${candidates[@]}"; do
            printf '  %d. %s\n' "$index" "$candidate" >&2
            ((index += 1))
        done
        read -r -p "Select the Vencord checkout to use: " selected
        [[ "$selected" =~ ^[0-9]+$ && selected -ge 1 && selected -le ${#candidates[@]} ]] || return 1
        printf '%s' "${candidates[selected - 1]}"
        return 0
    fi
    printf 'Several Vencord source checkouts were found; supply VENCORD_PATH explicitly.\n' >&2
    return 1
}

find_vencord_ancestor() {
    local current=$1 candidate
    [[ -n "$current" && -d "$current" ]] || return 1
    current=$(cd "$current" 2>/dev/null && pwd -P) || return 1
    while :; do
        candidate=$(resolve_vencord_candidate "$current" 2>/dev/null || true)
        if [[ -n "$candidate" ]]; then
            printf '%s' "$candidate"
            return 0
        fi
        [[ "$current" != "/" ]] || break
        current=${current%/*}
        [[ -n "$current" ]] || current="/"
    done
    return 1
}

find_automatic_vencord_root() {
    local state_file configured candidate input existing selected script_dir
    local -a candidates=() inputs=()

    local config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
    local -a state_files=(
        "$config_home/vesktop/state.json"
        "$HOME/.config/vesktop/state.json"
        "$HOME/.var/app/dev.vencord.Vesktop/config/vesktop/state.json"
        "$HOME/snap/vesktop/current/.config/vesktop/state.json"
    )
    for state_file in "${state_files[@]}"; do
        [[ -f "$state_file" ]] || continue
        configured=$(read_vencord_dir_from_state "$state_file" 2>/dev/null || true)
        candidate=$(resolve_vencord_candidate "$configured" 2>/dev/null || true)
        [[ -n "$candidate" ]] || continue
        for existing in "${candidates[@]}"; do
            [[ "$existing" != "$candidate" ]] || continue 2
        done
        candidates+=("$candidate")
    done

    script_dir=$(cd "$("$DIRNAME_EXECUTABLE" "${BASH_SOURCE[0]}")" && pwd -P)
    inputs+=(
        "$(find_vencord_ancestor "$PWD" 2>/dev/null || true)"
        "$(find_vencord_ancestor "$script_dir" 2>/dev/null || true)"
        "$HOME/Vencord"
        "$HOME/vencord"
        "$HOME/Documents/Vencord"
        "$HOME/Projects/Vencord"
        "$HOME/projects/Vencord"
        "$HOME/src/Vencord"
        "$HOME/git/Vencord"
    )

    for input in "${inputs[@]}"; do
        candidate=$(resolve_vencord_candidate "$input" 2>/dev/null || true)
        [[ -n "$candidate" ]] || continue
        for existing in "${candidates[@]}"; do
            [[ "$existing" != "$candidate" ]] || continue 2
        done
        candidates+=("$candidate")
    done

    if (( ${#candidates[@]} == 0 )); then
        while IFS= read -r -d '' input; do
            candidate=$(resolve_vencord_candidate "$input" 2>/dev/null || true)
            [[ -n "$candidate" ]] || continue
            for existing in "${candidates[@]}"; do
                [[ "$existing" != "$candidate" ]] || continue 2
            done
            candidates+=("$candidate")
        done < <("$FIND_EXECUTABLE" "$HOME" -maxdepth 8 \
            \( -type d \( -name .git -o -name node_modules -o -name .cache -o -name Cache \) -prune \) -o \
            \( -type d -iname Vencord -print0 \) 2>/dev/null)
    fi

    select_vencord_candidate "${candidates[@]}"
}

run_build() {
    (
        cd "$VENCORD_ROOT"
        eval "exec ${TRUSTED_STAT_FD}<&- ${TRUSTED_SHA256_FD}<&-"
        PATH="$SAFE_SYSTEM_PATH" \
        NPM_CONFIG_USERCONFIG=/dev/null \
        NPM_CONFIG_GLOBALCONFIG=/dev/null \
        npm_config_userconfig=/dev/null \
        npm_config_globalconfig=/dev/null \
        GIT_CONFIG_NOSYSTEM=1 \
        GIT_CONFIG_SYSTEM=/dev/null \
        GIT_CONFIG_GLOBAL=/dev/null \
        GIT_CONFIG_COUNT=1 \
        GIT_CONFIG_KEY_0=core.hooksPath \
        GIT_CONFIG_VALUE_0=/dev/null \
        GIT_NO_REPLACE_OBJECTS=1 \
        GIT_TERMINAL_PROMPT=0 \
            "${PNPM_INVOCATION[@]}" build
    )
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

    local canonical_git_dir unsafe_git_path unsafe_hardlink_path alternates_path commondir_path
    canonical_git_dir=$(cd "$checkout_path/.git" && pwd -P) || return 1
    [[ "$canonical_git_dir" == "$checkout_path/.git" ]] || {
        printf 'Error: The canonical .git directory escapes the plugin checkout.\n' >&2
        return 1
    }

    commondir_path="$checkout_path/.git/commondir"
    if [[ -e "$commondir_path" || -L "$commondir_path" ]]; then
        printf 'Error: The plugin repository must not contain a .git/commondir file.\n' >&2
        return 1
    fi

    alternates_path="$checkout_path/.git/objects/info/alternates"
    if [[ -e "$alternates_path" || -L "$alternates_path" ]]; then
        printf "Error: The plugin repository must not use Git object alternates ('%s').\n" "$alternates_path" >&2
        return 1
    fi

    unsafe_git_path=$("$FIND_EXECUTABLE" -P "$checkout_path/.git" -mindepth 1 -type l -print -quit) || {
        printf 'Error: The plugin repository Git metadata could not be inspected safely.\n' >&2
        return 1
    }
    if [[ -n "$unsafe_git_path" ]]; then
        printf "Error: Git metadata path '%s' must not be a symbolic link.\n" "$unsafe_git_path" >&2
        return 1
    fi

    unsafe_hardlink_path=$(cd "$checkout_path/.git" && "$FIND_EXECUTABLE" -P . \
        -path './objects' -prune -o \
        -type f -links +1 -print -quit) || {
        printf 'Error: The plugin repository Git metadata hardlink state could not be inspected safely.\n' >&2
        return 1
    }
    if [[ -n "$unsafe_hardlink_path" ]]; then
        printf "Error: Mutable Git metadata file '%s' must not be a hardlink.\n" "$unsafe_hardlink_path" >&2
        return 1
    fi
}

assert_safe_local_git_config() {
    local checkout_path=${1:-$PLUGIN_PATH}
    local config_file="$checkout_path/.git/config"
    local key normalized value lower_value valid
    local -a keys=() values=()

    [[ -f "$config_file" && ! -L "$config_file" ]] || {
        printf 'Error: The plugin repository has an unsafe or missing local Git config file.\n' >&2
        return 1
    }

    mapfile -t keys < <("$GIT_EXECUTABLE" config --file "$config_file" --no-includes --name-only --list) || {
        printf 'Error: The plugin repository local Git config could not be inspected safely.\n' >&2
        return 1
    }

    for key in "${keys[@]}"; do
        normalized=${key,,}
        mapfile -t values < <("$GIT_EXECUTABLE" config --file "$config_file" --no-includes --get-all "$key") || return 1
        if (( ${#values[@]} == 0 )); then
            printf "Error: The plugin repository local Git config key '%s' has no inspectable value.\n" "$key" >&2
            return 1
        fi
        if [[ "$normalized" == remote.origin.fetch ]]; then
            for value in "${values[@]}"; do
                if [[ ! "$value" =~ ^\+refs/heads/[^:\ ]+:refs/remotes/origin/[^:\ ]+$ ]]; then
                    printf 'Error: The plugin repository local Git config contains an unsafe fetch refspec.\n' >&2
                    return 1
                fi
            done
            continue
        fi
        if (( ${#values[@]} != 1 )); then
            printf "Error: The plugin repository local Git config key '%s' must have exactly one value.\n" "$key" >&2
            return 1
        fi
        value=${values[0]}
        lower_value=${value,,}
        valid=0
        case "$normalized" in
            core.repositoryformatversion) [[ "$value" == 0 ]] && valid=1 ;;
            core.filemode|core.logallrefupdates|core.ignorecase|core.precomposeunicode|core.symlinks)
                [[ "$lower_value" == true || "$lower_value" == false ]] && valid=1 ;;
            core.bare) [[ "$lower_value" == false ]] && valid=1 ;;
            core.autocrlf) [[ "$lower_value" == true || "$lower_value" == false || "$lower_value" == input ]] && valid=1 ;;
            core.eol) [[ "$lower_value" == native || "$lower_value" == lf || "$lower_value" == crlf ]] && valid=1 ;;
            core.safecrlf) [[ "$lower_value" == true || "$lower_value" == false || "$lower_value" == warn ]] && valid=1 ;;
            remote.origin.url) is_expected_repo_url "$value" && valid=1 ;;
            branch.main.remote) [[ "$value" == origin ]] && valid=1 ;;
            branch.main.merge) [[ "$value" == "refs/heads/$EXPECTED_BRANCH" ]] && valid=1 ;;
        esac
        if (( valid == 0 )); then
            printf "Error: The plugin repository local Git config contains forbidden key '%s'.\n" "$key" >&2
            return 1
        fi
    done
}

assert_no_replace_refs() {
    local checkout_path=${1:-$PLUGIN_PATH} replace_refs
    replace_refs=$("$GIT_EXECUTABLE" -C "$checkout_path" for-each-ref --format='%(refname)' refs/replace) || return 1
    if [[ -n "$replace_refs" ]]; then
        printf 'Error: The plugin repository contains forbidden Git replacement refs.\n' >&2
        return 1
    fi
}

assert_git_resolved_checkout_paths() {
    local checkout_path=${1:-$PLUGIN_PATH}
    local canonical_checkout canonical_git_dir resolved_top_level resolved_git_dir resolved_common_dir
    canonical_checkout=$(cd "$checkout_path" && pwd -P) || return 1
    canonical_git_dir=$(cd "$checkout_path/.git" && pwd -P) || return 1
    resolved_top_level=$("$GIT_EXECUTABLE" -C "$checkout_path" rev-parse --show-toplevel) || return 1
    resolved_top_level=$(cd "$resolved_top_level" && pwd -P) || return 1
    resolved_git_dir=$("$GIT_EXECUTABLE" -C "$checkout_path" rev-parse --absolute-git-dir) || return 1
    resolved_git_dir=$(cd "$resolved_git_dir" && pwd -P) || return 1
    resolved_common_dir=$("$GIT_EXECUTABLE" -C "$checkout_path" rev-parse --git-common-dir) || return 1
    resolved_common_dir=$(cd "$checkout_path" && cd "$resolved_common_dir" && pwd -P) || return 1
    [[ "$resolved_top_level" == "$canonical_checkout" ]] || {
        printf 'Error: Git resolves the plugin working tree outside the plugin destination.\n' >&2
        return 1
    }
    [[ "$resolved_git_dir" == "$canonical_git_dir" ]] || {
        printf 'Error: Git resolves the plugin directory outside the plugin checkout.\n' >&2
        return 1
    }
    [[ "$resolved_common_dir" == "$canonical_git_dir" ]] || {
        printf 'Error: Git resolves the plugin common directory outside the plugin checkout.\n' >&2
        return 1
    }
}

assert_git_mutation_safe() {
    local checkout_path=${1:-$PLUGIN_PATH}
    assert_checkout_paths_safe "$checkout_path" || return 1
    assert_safe_local_git_config "$checkout_path" || return 1
    assert_no_replace_refs "$checkout_path" || return 1
    assert_git_resolved_checkout_paths "$checkout_path" || return 1
    assert_checkout_paths_safe "$checkout_path"
}

assert_plugin_checkout() {
    local checkout_path=${1:-$PLUGIN_PATH}
    assert_checkout_paths_safe "$checkout_path" || return 1
    assert_safe_local_git_config "$checkout_path" || return 1
    assert_no_replace_refs "$checkout_path" || return 1
    assert_git_resolved_checkout_paths "$checkout_path" || return 1

    local actual_remote branch upstream required_file
    actual_remote=$("$GIT_EXECUTABLE" -C "$checkout_path" remote get-url origin) || return 1
    is_expected_repo_url "$actual_remote" || {
        printf "Error: '%s' points to '%s', not '%s'. Refusing to modify it.\n" "$checkout_path" "$actual_remote" "$REPOSITORY_URL" >&2
        return 1
    }

    branch=$("$GIT_EXECUTABLE" -C "$checkout_path" symbolic-ref --quiet --short HEAD) || {
        printf 'Error: The existing plugin clone has a detached HEAD.\n' >&2
        return 1
    }
    [[ "$branch" == "$EXPECTED_BRANCH" ]] || {
        printf "Error: The plugin clone must be on the '%s' branch, not '%s'.\n" "$EXPECTED_BRANCH" "$branch" >&2
        return 1
    }

    upstream=$("$GIT_EXECUTABLE" -C "$checkout_path" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}') || {
        printf 'Error: The plugin branch has no upstream.\n' >&2
        return 1
    }
    [[ "$upstream" == "origin/$EXPECTED_BRANCH" ]] || {
        printf "Error: The plugin branch must track 'origin/%s', not '%s'.\n" "$EXPECTED_BRANCH" "$upstream" >&2
        return 1
    }

    CHECKOUT_HEAD=$("$GIT_EXECUTABLE" -C "$checkout_path" rev-parse --verify 'HEAD^{commit}') || {
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

assert_head_worktree_clean() {
    local checkout_path=$1
    local temporary_index_root temporary_index working_tree
    temporary_index_root=$("$MKTEMP_EXECUTABLE" -d "${TMPDIR:-/tmp}/.XXXXXXXX") || return 1
    temporary_index="$temporary_index_root/index"

    if ! GIT_INDEX_FILE="$temporary_index" "$GIT_EXECUTABLE" -C "$checkout_path" -c core.fsmonitor=false read-tree HEAD >/dev/null 2>&1; then
        "$RM_EXECUTABLE" -rf -- "$temporary_index_root" || true
        return 1
    fi
    if ! working_tree=$(GIT_INDEX_FILE="$temporary_index" "$GIT_EXECUTABLE" -C "$checkout_path" -c core.fsmonitor=false status --porcelain --untracked-files=all --ignored=matching); then
        "$RM_EXECUTABLE" -rf -- "$temporary_index_root" || true
        return 1
    fi
    "$RM_EXECUTABLE" -rf -- "$temporary_index_root" || return 1
    [[ -z "$working_tree" ]]
}

assert_clean_checkout() {
    local checkout_path=${1:-$PLUGIN_PATH}
    local index_state
    index_state=$("$GIT_EXECUTABLE" -C "$checkout_path" ls-files -v) || return 1
    if "$GREP_SYSTEM_EXECUTABLE" -Eq '^(S|[a-z]) ' <<< "$index_state"; then
        printf 'Error: The existing plugin clone contains assume-unchanged or skip-worktree index entries.\n' >&2
        return 1
    fi
    "$GIT_EXECUTABLE" -C "$checkout_path" diff-index --cached --quiet HEAD -- || {
        printf 'Error: The existing plugin clone has staged tracked changes.\n' >&2
        return 1
    }
    assert_head_worktree_clean "$checkout_path" || {
        printf 'Error: The existing plugin clone has tracked, untracked, or ignored local data. Commit, stash, or remove it before updating.\n' >&2
        return 1
    }
}

assert_completely_clean_checkout() {
    local checkout_path=${1:-$PLUGIN_PATH}
    local index_state
    index_state=$("$GIT_EXECUTABLE" -C "$checkout_path" ls-files -v) || return 1
    if "$GREP_SYSTEM_EXECUTABLE" -Eq '^(S|[a-z]) ' <<< "$index_state"; then
        printf 'Error: The newly installed plugin checkout contains assume-unchanged or skip-worktree index entries.\n' >&2
        return 1
    fi
    "$GIT_EXECUTABLE" -C "$checkout_path" diff-index --cached --quiet HEAD -- || {
        printf 'Error: The newly installed plugin checkout has staged tracked changes.\n' >&2
        return 1
    }
    assert_head_worktree_clean "$checkout_path" || {
        printf 'Error: The newly installed plugin checkout contains tracked, untracked, or ignored changes.\n' >&2
        return 1
    }
}

assert_installer_owned_fresh_checkout() {
    local checkout_path=$1 expected_commit=$2 expected_identity=$3 identity_path actual_identity
    assert_plugin_checkout "$checkout_path" || return 1
    [[ "$CHECKOUT_HEAD" == "$expected_commit" ]] || {
        printf 'Error: The installed plugin commit changed after validation.\n' >&2
        return 1
    }
    assert_completely_clean_checkout "$checkout_path" || return 1
    identity_path="$checkout_path/.git/custom-soundboard-installer-identity"
    [[ -f "$identity_path" && ! -L "$identity_path" ]] || {
        printf 'Error: The installer-owned checkout identity marker is missing or unsafe.\n' >&2
        return 1
    }
    actual_identity=$(<"$identity_path")
    [[ "$actual_identity" == "$expected_identity" ]] || {
        printf 'Error: The installer-owned checkout identity marker changed.\n' >&2
        return 1
    }
    assert_checkout_paths_safe "$checkout_path"
}

remove_validated_git_checkout_tree() {
    local path=$1 unsafe_path
    assert_safe_child_destination "$path" || return 1
    unsafe_path=$("$FIND_EXECUTABLE" -P "$path" -mindepth 1 -type l -print -quit) || return 1
    if [[ -n "$unsafe_path" ]]; then
        printf "Error: Refusing to remove '%s' because '%s' is a symbolic link.\n" "$path" "$unsafe_path" >&2
        return 1
    fi
    assert_checkout_paths_safe "$path" || return 1
    "$RM_EXECUTABLE" -rf -- "$path"
}

assert_existing_checkout_identity_and_state() {
    local checkout_path=$1 expected_directory_identity=$2 expected_git_identity=$3 expected_commit=$4
    assert_fresh_checkout_filesystem_identity "$checkout_path" "$expected_directory_identity" "$expected_git_identity" || return 1
    assert_plugin_checkout "$checkout_path" || return 1
    [[ "$CHECKOUT_HEAD" == "$expected_commit" ]] || {
        printf 'Error: The existing plugin checkout commit changed unexpectedly.\n' >&2
        return 1
    }
    assert_clean_checkout "$checkout_path"
}

rollback_swapped_checkout() {
    local failed_path
    assert_fresh_checkout_filesystem_identity "$PLUGIN_PATH" "$CREATED_PLUGIN_DIRECTORY_IDENTITY" "$CREATED_PLUGIN_GIT_DIRECTORY_IDENTITY" || return 1
    assert_installer_owned_fresh_checkout "$PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || return 1
    assert_existing_checkout_identity_and_state "$BACKUP_PLUGIN_PATH" "$PREVIOUS_DIRECTORY_IDENTITY" "$PREVIOUS_GIT_DIRECTORY_IDENTITY" "$PREVIOUS_COMMIT" || return 1

    failed_path="$USERPLUGINS_ROOT/.${PLUGIN_DIRECTORY_NAME}.failed.$(< /proc/sys/kernel/random/uuid)"
    assert_safe_child_destination "$failed_path" || return 1
    [[ ! -e "$failed_path" && ! -L "$failed_path" ]] || return 1
    "$MV_EXECUTABLE" -T -- "$PLUGIN_PATH" "$failed_path" || return 1
    if ! "$MV_EXECUTABLE" -T -- "$BACKUP_PLUGIN_PATH" "$PLUGIN_PATH"; then
        if [[ ! -e "$PLUGIN_PATH" && ! -L "$PLUGIN_PATH" ]]; then
            "$MV_EXECUTABLE" -T -- "$failed_path" "$PLUGIN_PATH" || true
        fi
        return 1
    fi
    BACKUP_PLUGIN_PATH=""

    assert_existing_checkout_identity_and_state "$PLUGIN_PATH" "$PREVIOUS_DIRECTORY_IDENTITY" "$PREVIOUS_GIT_DIRECTORY_IDENTITY" "$PREVIOUS_COMMIT" || return 1
    assert_fresh_checkout_filesystem_identity "$failed_path" "$CREATED_PLUGIN_DIRECTORY_IDENTITY" "$CREATED_PLUGIN_GIT_DIRECTORY_IDENTITY" || return 1
    assert_installer_owned_fresh_checkout "$failed_path" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || return 1
    remove_validated_git_checkout_tree "$failed_path"
}

remove_validated_backup_checkout() {
    assert_existing_checkout_identity_and_state "$BACKUP_PLUGIN_PATH" "$PREVIOUS_DIRECTORY_IDENTITY" "$PREVIOUS_GIT_DIRECTORY_IDENTITY" "$PREVIOUS_COMMIT" || return 1
    remove_validated_git_checkout_tree "$BACKUP_PLUGIN_PATH" || return 1
    BACKUP_PLUGIN_PATH=""
}

cleanup_temporary_checkout() {
    local temporary_path=${TEMP_PLUGIN_PATH:-}
    [[ -n "$temporary_path" ]] || return 0
    if [[ -e "$temporary_path" || -L "$temporary_path" ]]; then
        assert_safe_child_destination "$temporary_path" || return 1
        "$RM_EXECUTABLE" -rf -- "$temporary_path" || return 1
    fi
    TEMP_PLUGIN_PATH=""
}

resolve_required_external_command() {
    local variable_name=$1 command_name=$2 resolved
    resolved=$(builtin type -P "$command_name" 2>/dev/null) || fail "$command_name is required to restart Vesktop."
    resolved=$("$READLINK_EXECUTABLE" -f -- "$resolved" 2>/dev/null) || fail "The $command_name executable could not be canonicalized."
    [[ -f "$resolved" && -x "$resolved" ]] || fail "The resolved $command_name command is not an executable file."
    printf -v "$variable_name" '%s' "$resolved"
}

find_vesktop_launcher() {
    local command_path canonical_command_path candidate flatpak_path snap_path gtk_path desktop_file original_desktop_file desktop_id
    command_path=$(builtin type -P vesktop 2>/dev/null || true)
    if [[ -n "$command_path" ]]; then
        canonical_command_path=$("$READLINK_EXECUTABLE" -f -- "$command_path" 2>/dev/null) || return 1
        [[ -f "$canonical_command_path" && -x "$canonical_command_path" ]] || return 1
        VESKTOP_LAUNCHER=("$canonical_command_path")
        if [[ "$canonical_command_path" == *.AppImage || "$canonical_command_path" == *.appimage ]]; then
            VESKTOP_LAUNCHER_KIND="appimage"
        else
            VESKTOP_LAUNCHER_KIND="command"
        fi
        return 0
    fi

    flatpak_path=$(builtin type -P flatpak 2>/dev/null || true)
    if [[ -n "$flatpak_path" ]]; then
        flatpak_path=$("$READLINK_EXECUTABLE" -f -- "$flatpak_path" 2>/dev/null || true)
        if [[ -n "$flatpak_path" && -f "$flatpak_path" && -x "$flatpak_path" ]] && "$flatpak_path" info dev.vencord.Vesktop >/dev/null 2>&1; then
            VESKTOP_LAUNCHER_KIND="flatpak"
            VESKTOP_LAUNCHER=("$flatpak_path" run dev.vencord.Vesktop)
            return 0
        fi
    fi

    snap_path=$(builtin type -P snap 2>/dev/null || true)
    if [[ -n "$snap_path" ]]; then
        snap_path=$("$READLINK_EXECUTABLE" -f -- "$snap_path" 2>/dev/null || true)
        if [[ -n "$snap_path" && -f "$snap_path" && -x "$snap_path" ]] && "$snap_path" list vesktop >/dev/null 2>&1; then
            VESKTOP_LAUNCHER_KIND="command"
            VESKTOP_LAUNCHER=("$snap_path" run vesktop)
            return 0
        fi
    fi

    for candidate in \
        "$HOME/Applications/Vesktop.AppImage" \
        "$HOME/Applications/vesktop.AppImage" \
        "$HOME/.local/bin/Vesktop.AppImage" \
        "$HOME/.local/bin/vesktop.AppImage"; do
        if [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]]; then
            canonical_command_path=$("$READLINK_EXECUTABLE" -f -- "$candidate" 2>/dev/null) || continue
            [[ "$canonical_command_path" == "$candidate" ]] || continue
            VESKTOP_LAUNCHER_KIND="appimage"
            VESKTOP_LAUNCHER=("$canonical_command_path")
            return 0
        fi
    done

    gtk_path=$(builtin type -P gtk-launch 2>/dev/null || true)
    if [[ -n "$gtk_path" ]]; then
        gtk_path=$("$READLINK_EXECUTABLE" -f -- "$gtk_path" 2>/dev/null || true)
        [[ -n "$gtk_path" && -f "$gtk_path" && -x "$gtk_path" ]] || return 1
        for desktop_file in \
            "$HOME/.local/share/applications/"*vesktop*.desktop \
            "$HOME/.local/share/applications/"*Vesktop*.desktop \
            /usr/share/applications/*vesktop*.desktop \
            /usr/share/applications/*Vesktop*.desktop; do
            [[ -f "$desktop_file" && ! -L "$desktop_file" ]] || continue
            original_desktop_file=$desktop_file
            desktop_file=$("$READLINK_EXECUTABLE" -f -- "$desktop_file" 2>/dev/null) || continue
            [[ "$desktop_file" == "$original_desktop_file" ]] || continue
            desktop_id=${desktop_file##*/}
            desktop_id=${desktop_id%.desktop}
            VESKTOP_LAUNCHER_KIND="desktop"
            VESKTOP_LAUNCHER=("$gtk_path" "$desktop_id")
            VESKTOP_DESKTOP_FILE="$desktop_file"
            VESKTOP_DESKTOP_ID="$desktop_id"
            if [[ "$desktop_file" == "$HOME/.local/share/applications/"* ]]; then
                VESKTOP_XDG_DATA_HOME="$HOME/.local/share"
                VESKTOP_XDG_DATA_DIRS="/usr/local/share:/usr/share"
            else
                VESKTOP_XDG_DATA_HOME="/nonexistent/custom-soundboard-xdg-data"
                VESKTOP_XDG_DATA_DIRS="/usr/share"
            fi
            return 0
        done
    fi

    return 1
}

preflight_restart_requirements() {
    (( SKIP_RESTART == 0 )) || return 0
    resolve_required_external_command PGREP_EXECUTABLE pgrep
    resolve_required_external_command PKILL_EXECUTABLE pkill
    resolve_required_external_command NOHUP_EXECUTABLE nohup
    resolve_required_external_command SLEEP_EXECUTABLE sleep
    GREP_EXECUTABLE=$GREP_SYSTEM_EXECUTABLE
    find_vesktop_launcher || fail "No valid Vesktop launcher was found. Use --skip-restart to build without restarting."
}

capture_restart_trusted_tools() {
    (( SKIP_RESTART == 0 )) || return 0
    capture_trusted_tool_identity PGREP "$PGREP_EXECUTABLE"
    capture_trusted_tool_identity PKILL "$PKILL_EXECUTABLE"
    capture_trusted_tool_identity NOHUP "$NOHUP_EXECUTABLE"
    capture_trusted_tool_identity SLEEP "$SLEEP_EXECUTABLE"
    capture_trusted_tool_identity VESKTOP_LAUNCHER "${VESKTOP_LAUNCHER[0]}"
    if [[ "$VESKTOP_LAUNCHER_KIND" == desktop ]]; then
        [[ -n "$VESKTOP_DESKTOP_FILE" ]] || fail "The selected Vesktop desktop entry was not recorded."
        capture_trusted_tool_identity VESKTOP_DESKTOP_FILE "$VESKTOP_DESKTOP_FILE" 0
    fi
}

vesktop_process_running() {
    "$PGREP_EXECUTABLE" -x vesktop >/dev/null 2>&1 ||
        "$PGREP_EXECUTABLE" -x Vesktop >/dev/null 2>&1 ||
        "$PGREP_EXECUTABLE" -x vesktop.bin >/dev/null 2>&1
}

restart_vesktop() {
    local process_name
    for process_name in vesktop Vesktop vesktop.bin; do
        "$PKILL_EXECUTABLE" -x "$process_name" 2>/dev/null || true
    done

    local attempts=0
    while (( attempts < 50 )); do
        if ! vesktop_process_running; then
            break
        fi
        "$SLEEP_EXECUTABLE" 0.2
        ((attempts += 1))
    done

    if vesktop_process_running; then
        fail "Vesktop did not stop within 10 seconds."
    fi

    if [[ "$VESKTOP_LAUNCHER_KIND" == desktop ]]; then
        XDG_DATA_HOME="$VESKTOP_XDG_DATA_HOME" XDG_DATA_DIRS="$VESKTOP_XDG_DATA_DIRS" \
            "$NOHUP_EXECUTABLE" "${VESKTOP_LAUNCHER[@]}" >/dev/null 2>&1 &
    else
        "$NOHUP_EXECUTABLE" "${VESKTOP_LAUNCHER[@]}" >/dev/null 2>&1 &
    fi
    local launcher_pid=$!
    "$SLEEP_EXECUTABLE" 2

    if [[ "$VESKTOP_LAUNCHER_KIND" == "flatpak" ]]; then
        if ! "${VESKTOP_LAUNCHER[0]}" ps --columns=application 2>/dev/null | "$GREP_EXECUTABLE" -Fxq "dev.vencord.Vesktop"; then
            fail "Vesktop did not become visible after the Flatpak launch request."
        fi
    elif [[ "$VESKTOP_LAUNCHER_KIND" == "appimage" ]]; then
        attempts=0
        while (( attempts < 50 )); do
            if vesktop_process_running; then
                return 0
            fi
            kill -0 "$launcher_pid" 2>/dev/null || break
            "$SLEEP_EXECUTABLE" 0.2
            ((attempts += 1))
        done
        fail "Vesktop was launched from the AppImage, but no Vesktop process became visible."
    else
        attempts=0
        while (( attempts < 50 )); do
            if vesktop_process_running; then
                return 0
            fi
            "$SLEEP_EXECUTABLE" 0.2
            ((attempts += 1))
        done
        fail "Vesktop was launched but no recognized Vesktop process became visible."
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-restart)
            SKIP_RESTART=1
            ;;
        --git-path|--node-path|--pnpm-path)
            [[ $# -ge 2 ]] || fail "Option '$1' requires an absolute path."
            case "$1" in
                --git-path) GIT_PATH_OVERRIDE=$2 ;;
                --node-path) NODE_PATH_OVERRIDE=$2 ;;
                --pnpm-path) PNPM_PATH_OVERRIDE=$2 ;;
            esac
            shift
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

trap 'cleanup_temporary_checkout || true; cleanup_safe_git_environment || true' EXIT
assert_safe_git_environment
initialize_identity_validators
resolve_git_executable
resolve_external_executable pnpm "$PNPM_PATH_OVERRIDE" PNPM_EXECUTABLE
resolve_external_executable node "$NODE_PATH_OVERRIDE" NODE_EXECUTABLE
case "$PNPM_EXECUTABLE" in
    *.js|*.cjs|*.mjs) PNPM_INVOCATION=("$NODE_EXECUTABLE" "$PNPM_EXECUTABLE") ;;
    *) PNPM_INVOCATION=("$PNPM_EXECUTABLE") ;;
esac
capture_all_trusted_tools
EFFECTIVE_AUTOCRLF=$(get_validated_effective_autocrlf)
initialize_safe_git_environment "$EFFECTIVE_AUTOCRLF"
preflight_restart_requirements
capture_restart_trusted_tools
assert_trusted_tool_set || fail "A trusted installer tool changed during preflight."

if [[ -z "$VENCORD_PATH" ]]; then
    VENCORD_PATH=$(find_automatic_vencord_root || true)
    if [[ -n "$VENCORD_PATH" ]]; then
        printf 'Detected Vencord source checkout: %s\n' "$VENCORD_PATH"
    elif [[ -t 0 ]]; then
        read -r -p "Path to your Vencord source checkout: " VENCORD_PATH
    else
        fail "A Vencord source checkout could not be detected. Supply VENCORD_PATH explicitly."
    fi
fi

[[ -d "$VENCORD_PATH" ]] || fail "Vencord path does not exist: $VENCORD_PATH"
VENCORD_ROOT=$(cd "$VENCORD_PATH" && pwd -P)
is_vencord_root "$VENCORD_ROOT" || fail "'$VENCORD_ROOT' is not a valid Vencord source checkout (package.json, pnpm-lock.yaml, or src/userplugins is missing)."
assert_vencord_root_paths_safe "$VENCORD_ROOT" || fail "The Vencord src/userplugins path is unsafe."
USERPLUGINS_ROOT="$VENCORD_ROOT/src/userplugins"
PLUGIN_PATH="$USERPLUGINS_ROOT/$PLUGIN_DIRECTORY_NAME"
CREATED_PLUGIN_DIRECTORY=0
CREATED_PLUGIN_COMMIT=""
CREATED_PLUGIN_IDENTITY=""
CREATED_PLUGIN_DIRECTORY_IDENTITY=""
CREATED_PLUGIN_GIT_DIRECTORY_IDENTITY=""
PREVIOUS_COMMIT=""
PREVIOUS_DIRECTORY_IDENTITY=""
PREVIOUS_GIT_DIRECTORY_IDENTITY=""
BACKUP_PLUGIN_PATH=""
TEMP_PLUGIN_PATH=""
SWAPPED_EXISTING_CHECKOUT=0
SOURCE_ROLLBACK_REQUIRED=0
INSTALL_ACTION=installed

assert_plugin_destination_safe || fail "The plugin destination is unsafe."

if [[ -e "$PLUGIN_PATH" || -L "$PLUGIN_PATH" ]]; then
    INSTALL_ACTION=updated
    assert_plugin_checkout || fail "The existing plugin checkout is invalid."
    assert_clean_checkout || fail "The existing plugin checkout is not clean."
    PREVIOUS_COMMIT=$CHECKOUT_HEAD
    PREVIOUS_DIRECTORY_IDENTITY=$(get_filesystem_identity "$PLUGIN_PATH") || fail "Recording the existing plugin directory identity failed."
    PREVIOUS_GIT_DIRECTORY_IDENTITY=$(get_filesystem_identity "$PLUGIN_PATH/.git") || fail "Recording the existing plugin .git identity failed."

    printf 'Preparing a verified Custom Soundboard update candidate...\n'
    TEMP_PLUGIN_PATH=$("$MKTEMP_EXECUTABLE" -d "$USERPLUGINS_ROOT/.${PLUGIN_DIRECTORY_NAME}.install.XXXXXXXX") || fail "Creating a temporary checkout directory failed."
    assert_safe_child_destination "$TEMP_PLUGIN_PATH" || fail "The temporary checkout destination is unsafe."
    if ! "$GIT_EXECUTABLE" clone --branch "$EXPECTED_BRANCH" --single-branch -- "$REPOSITORY_URL" "$TEMP_PLUGIN_PATH"; then
        cleanup_temporary_checkout || fail "Cloning origin/$EXPECTED_BRANCH failed, and cleaning the temporary checkout also failed."
        fail "Cloning origin/$EXPECTED_BRANCH failed. The existing checkout was not changed."
    fi
    if ! assert_plugin_checkout "$TEMP_PLUGIN_PATH" || ! assert_clean_checkout "$TEMP_PLUGIN_PATH"; then
        cleanup_temporary_checkout || fail "The update candidate was invalid, and cleaning it also failed."
        fail "The update candidate was invalid. The existing checkout was not changed."
    fi
    CREATED_PLUGIN_COMMIT=$CHECKOUT_HEAD
    CREATED_PLUGIN_IDENTITY=$(< /proc/sys/kernel/random/uuid) || fail "Generating an installer-owned checkout identity failed."
    printf '%s' "$CREATED_PLUGIN_IDENTITY" > "$TEMP_PLUGIN_PATH/.git/custom-soundboard-installer-identity" || fail "Recording the installer-owned checkout identity failed."
    assert_installer_owned_fresh_checkout "$TEMP_PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || fail "The update candidate changed unexpectedly and was preserved for inspection."

    if [[ "$CREATED_PLUGIN_COMMIT" == "$PREVIOUS_COMMIT" ]]; then
        INSTALL_ACTION="already up to date"
        remove_validated_git_checkout_tree "$TEMP_PLUGIN_PATH" || fail "The no-update candidate could not be removed safely and was preserved for inspection."
        TEMP_PLUGIN_PATH=""
    else
        "$GIT_EXECUTABLE" -C "$TEMP_PLUGIN_PATH" merge-base --is-ancestor "$PREVIOUS_COMMIT" "$CREATED_PLUGIN_COMMIT" || fail "origin/$EXPECTED_BRANCH does not fast-forward the installed commit. The existing checkout was not changed."
        assert_existing_checkout_identity_and_state "$PLUGIN_PATH" "$PREVIOUS_DIRECTORY_IDENTITY" "$PREVIOUS_GIT_DIRECTORY_IDENTITY" "$PREVIOUS_COMMIT" || fail "The existing checkout changed before the update swap. No update was installed."
        assert_installer_owned_fresh_checkout "$TEMP_PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || fail "The update candidate changed before the update swap."
        BACKUP_PLUGIN_PATH="$USERPLUGINS_ROOT/.${PLUGIN_DIRECTORY_NAME}.backup.$(< /proc/sys/kernel/random/uuid)"
        assert_safe_child_destination "$BACKUP_PLUGIN_PATH" || fail "The backup checkout destination is unsafe."
        [[ ! -e "$BACKUP_PLUGIN_PATH" && ! -L "$BACKUP_PLUGIN_PATH" ]] || fail "The backup checkout destination already exists."
        "$MV_EXECUTABLE" -T -- "$PLUGIN_PATH" "$BACKUP_PLUGIN_PATH" || fail "Moving the existing checkout to its transaction backup failed."
        if ! "$MV_EXECUTABLE" -T -- "$TEMP_PLUGIN_PATH" "$PLUGIN_PATH"; then
            if [[ ! -e "$PLUGIN_PATH" && ! -L "$PLUGIN_PATH" ]]; then
                "$MV_EXECUTABLE" -T -- "$BACKUP_PLUGIN_PATH" "$PLUGIN_PATH" || true
            fi
            fail "Installing the verified update candidate failed. The transaction paths were preserved."
        fi
        TEMP_PLUGIN_PATH=""
        SWAPPED_EXISTING_CHECKOUT=1
        SOURCE_ROLLBACK_REQUIRED=1
        CREATED_PLUGIN_DIRECTORY_IDENTITY=$(get_filesystem_identity "$PLUGIN_PATH") || fail "Recording the updated plugin directory identity failed. Both transaction paths were preserved."
        CREATED_PLUGIN_GIT_DIRECTORY_IDENTITY=$(get_filesystem_identity "$PLUGIN_PATH/.git") || fail "Recording the updated plugin .git identity failed. Both transaction paths were preserved."
        assert_installer_owned_fresh_checkout "$PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || fail "The installed update candidate failed validation. Both transaction paths were preserved."
        assert_existing_checkout_identity_and_state "$BACKUP_PLUGIN_PATH" "$PREVIOUS_DIRECTORY_IDENTITY" "$PREVIOUS_GIT_DIRECTORY_IDENTITY" "$PREVIOUS_COMMIT" || fail "The transaction backup failed validation. Both transaction paths were preserved."
    fi
else
    printf 'Installing Custom Soundboard...\n'
    TEMP_PLUGIN_PATH=$("$MKTEMP_EXECUTABLE" -d "$USERPLUGINS_ROOT/.${PLUGIN_DIRECTORY_NAME}.install.XXXXXXXX") || fail "Creating a temporary checkout directory failed."
    assert_safe_child_destination "$TEMP_PLUGIN_PATH" || fail "The temporary checkout destination is unsafe."

    if ! "$GIT_EXECUTABLE" clone --branch "$EXPECTED_BRANCH" --single-branch -- "$REPOSITORY_URL" "$TEMP_PLUGIN_PATH"; then
        cleanup_temporary_checkout || fail "Cloning origin/$EXPECTED_BRANCH failed, and cleaning the temporary checkout also failed."
        fail "Cloning origin/$EXPECTED_BRANCH failed."
    fi
    if ! assert_plugin_checkout "$TEMP_PLUGIN_PATH" || ! assert_clean_checkout "$TEMP_PLUGIN_PATH"; then
        cleanup_temporary_checkout || fail "The cloned plugin checkout was invalid, and cleaning it also failed."
        fail "The cloned plugin checkout was invalid and has been removed."
    fi
    CREATED_PLUGIN_COMMIT=$CHECKOUT_HEAD
    CREATED_PLUGIN_IDENTITY=$(< /proc/sys/kernel/random/uuid) || fail "Generating an installer-owned checkout identity failed."
    printf '%s' "$CREATED_PLUGIN_IDENTITY" > "$TEMP_PLUGIN_PATH/.git/custom-soundboard-installer-identity" || fail "Recording the installer-owned checkout identity failed."

    assert_plugin_destination_safe || {
        cleanup_temporary_checkout || true
        fail "The plugin destination became unsafe before installation."
    }
    if ! assert_installer_owned_fresh_checkout "$TEMP_PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY"; then
        cleanup_temporary_checkout || fail "The cloned plugin checkout changed before installation, and cleaning it also failed."
        fail "The cloned plugin checkout changed before installation and has been removed."
    fi
    "$MV_EXECUTABLE" -Tn -- "$TEMP_PLUGIN_PATH" "$PLUGIN_PATH" || {
        cleanup_temporary_checkout || true
        fail "Atomically installing the validated plugin checkout failed."
    }
    [[ ! -e "$TEMP_PLUGIN_PATH" && ! -L "$TEMP_PLUGIN_PATH" ]] || fail "The validated temporary checkout was not installed atomically."
    TEMP_PLUGIN_PATH=""
    CREATED_PLUGIN_DIRECTORY=1
    SOURCE_ROLLBACK_REQUIRED=1
    assert_installer_owned_fresh_checkout "$PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || fail "The installed plugin checkout failed post-move validation. It was preserved and must be inspected manually."
    CREATED_PLUGIN_DIRECTORY_IDENTITY=$(get_filesystem_identity "$PLUGIN_PATH") || fail "Recording the installed plugin directory identity failed. The checkout was preserved for manual inspection."
    CREATED_PLUGIN_GIT_DIRECTORY_IDENTITY=$(get_filesystem_identity "$PLUGIN_PATH/.git") || fail "Recording the installed plugin .git directory identity failed. The checkout was preserved for manual inspection."
fi

printf 'Building Vencord...\n'
assert_trusted_tool_set || fail "A trusted installer tool changed before the Vencord build."
if ! run_build; then
    assert_trusted_tool_set || fail "The Vencord build replaced or modified a trusted installer tool. The source transaction was preserved; no rollback, cleanup, recovery build, or restart was attempted."
    printf 'The Vencord build failed. Validating the source transaction before rollback...\n' >&2

    if (( SWAPPED_EXISTING_CHECKOUT == 1 )); then
        rollback_swapped_checkout || fail "The build failed and the update transaction changed unexpectedly. The installed and backup paths were preserved; no destructive rollback or recovery build was attempted."
    elif (( CREATED_PLUGIN_DIRECTORY == 1 )); then
        assert_fresh_checkout_filesystem_identity "$PLUGIN_PATH" "$CREATED_PLUGIN_DIRECTORY_IDENTITY" "$CREATED_PLUGIN_GIT_DIRECTORY_IDENTITY" || fail "The build failed, and the newly installed plugin directory was replaced. It was preserved; no recovery build was attempted."
        assert_installer_owned_fresh_checkout "$PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || fail "The build failed, and the newly installed plugin directory changed. It was preserved; no recovery build was attempted."
        remove_validated_git_checkout_tree "$PLUGIN_PATH" || fail "The build failed, but the installed plugin checkout became unsafe to remove. It was preserved; no recovery build was attempted."
    else
        fail "The Vencord build failed before any plugin source mutation. The checkout was preserved and no recovery build was attempted."
    fi

    if (( SOURCE_ROLLBACK_REQUIRED == 1 )); then
        if ! run_build; then
            assert_trusted_tool_set || fail "The recovery build replaced or modified a trusted installer tool. The restored source was preserved and Vesktop was not restarted."
            fail "The update failed and rebuilding the restored Vencord state also failed."
        fi
        assert_trusted_tool_set || fail "The recovery build replaced or modified a trusted installer tool. The restored source was preserved and Vesktop was not restarted."
        if (( SWAPPED_EXISTING_CHECKOUT == 1 )); then
            assert_existing_checkout_identity_and_state "$PLUGIN_PATH" "$PREVIOUS_DIRECTORY_IDENTITY" "$PREVIOUS_GIT_DIRECTORY_IDENTITY" "$PREVIOUS_COMMIT" || fail "The recovery build changed the restored plugin checkout. The altered path was preserved and Vesktop was not restarted."
        elif (( CREATED_PLUGIN_DIRECTORY == 1 )); then
            [[ ! -e "$PLUGIN_PATH" && ! -L "$PLUGIN_PATH" ]] || fail "The recovery build recreated the removed plugin path. The unexpected path was preserved for inspection and the rollback was not considered clean."
        fi
    fi
    fail "The update was rolled back because the Vencord build failed."
fi

assert_trusted_tool_set || fail "The Vencord build replaced or modified a trusted installer tool. The source transaction was preserved; no Git validation, cleanup, or restart was attempted."

if (( SWAPPED_EXISTING_CHECKOUT == 1 )); then
    assert_fresh_checkout_filesystem_identity "$PLUGIN_PATH" "$CREATED_PLUGIN_DIRECTORY_IDENTITY" "$CREATED_PLUGIN_GIT_DIRECTORY_IDENTITY" || fail "The build succeeded, but the installed update candidate or its .git directory changed. Both transaction paths were preserved and Vesktop was not restarted."
    assert_installer_owned_fresh_checkout "$PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || fail "The build succeeded, but the installed update candidate changed. Both transaction paths were preserved and Vesktop was not restarted."
    assert_existing_checkout_identity_and_state "$BACKUP_PLUGIN_PATH" "$PREVIOUS_DIRECTORY_IDENTITY" "$PREVIOUS_GIT_DIRECTORY_IDENTITY" "$PREVIOUS_COMMIT" || fail "The build succeeded, but the transaction backup changed. Both transaction paths were preserved and Vesktop was not restarted."
elif (( CREATED_PLUGIN_DIRECTORY == 1 )); then
    assert_fresh_checkout_filesystem_identity "$PLUGIN_PATH" "$CREATED_PLUGIN_DIRECTORY_IDENTITY" "$CREATED_PLUGIN_GIT_DIRECTORY_IDENTITY" || fail "The build succeeded, but the newly installed plugin checkout or its .git directory changed. It was preserved and Vesktop was not restarted."
    assert_installer_owned_fresh_checkout "$PLUGIN_PATH" "$CREATED_PLUGIN_COMMIT" "$CREATED_PLUGIN_IDENTITY" || fail "The build succeeded, but the newly installed plugin checkout changed. It was preserved and Vesktop was not restarted."
else
    assert_existing_checkout_identity_and_state "$PLUGIN_PATH" "$PREVIOUS_DIRECTORY_IDENTITY" "$PREVIOUS_GIT_DIRECTORY_IDENTITY" "$PREVIOUS_COMMIT" || fail "The build succeeded, but the existing plugin checkout changed. It was preserved and Vesktop was not restarted."
fi

if (( SWAPPED_EXISTING_CHECKOUT == 1 )); then
    remove_validated_backup_checkout || fail "The build succeeded, but the transaction backup changed unexpectedly. It was preserved and Vesktop was not restarted."
fi

if (( SKIP_RESTART == 1 )); then
    printf 'Custom Soundboard was %s and built successfully. Restart Vesktop manually.\n' "$INSTALL_ACTION"
else
    assert_trusted_tool_set || fail "A trusted installer or restart tool changed before Vesktop restart. Vesktop was not restarted."
    printf 'Restarting Vesktop...\n'
    restart_vesktop
    printf 'Custom Soundboard was %s, built, and Vesktop was restarted successfully.\n' "$INSTALL_ACTION"
fi
fi
