#!/usr/bin/env bash
# Open a Git checkout in the Podman control container set up by the guide.
set -euo pipefail
umask 077

if [[ ${1:-} == --check ]]; then
    mode=check
    shift
else
    mode=open
fi
if (( $# > 1 )); then
    printf 'Usage of %s is [--check] [git-checkout]\n' "$0" >&2
    exit 2
fi
repo=${1:-.}
tools=$(dirname -- "$(realpath -- "$0")")
stage=${PI_LAYERFS_PODMAN_STAGE:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-layerfs-podman-projects}
if [[ ! -d "$stage/incoming" ]]; then
    printf 'Prepare this machine with bootstrap.sh from the Podman setup guide.\n' >&2
    exit 1
fi
podman=$(command -v podman)
sudo -v
exec 9>"$stage/launch.lock"
flock -n 9

container=$(sudo -n "$podman" --remote=false inspect \
    --format '{{if and .State.Running (eq (index .Config.Labels "pi.layerfs.guide") "projects")}}{{.Id}}{{end}}' \
    pi-layerfs-projects)
if [[ ! $container =~ ^[a-f0-9]{64}$ ]]; then
    printf 'Start the Podman control container prepared by the setup guide before opening projects.\n' >&2
    exit 1
fi
launch() {
    sudo -n "$podman" --remote=false exec "$@" "$container" \
        /usr/bin/flock -n /persist/session.lock /usr/bin/unshare --mount --propagation private \
        /runtime/bin/node /runtime/projects/project.mjs "${project_args[@]}"
}
identity=$(python3 "$tools/git-snapshot.py" "$repo")
key=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])' <<<"$identity")
project_args=(status "$key")
record=$(launch)
state=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])' <<<"$record")
case "$state" in
    new)
        request=$(python3 -c 'import secrets; print(secrets.token_hex(6))')
        incoming=$stage/incoming/$request
        mkdir -m 0700 "$incoming"
        trap 'rm -rf --one-file-system -- "$incoming"' EXIT
        python3 "$tools/git-snapshot.py" "$repo" "$incoming/snapshot" >/dev/null
        project_args=(init "$key" "/incoming/$request/snapshot")
        trap - EXIT
        if ! launch; then
            printf 'The import snapshot is retained at %s.\n' "$incoming" >&2
            exit 1
        fi
        rm -rf --one-file-system -- "$incoming"
        ;;
    ready)
        python3 - "$identity" "$record" <<'PY'
import json
import sys
source, saved = (json.loads(value) for value in sys.argv[1:])
if saved['path'] != source['path']:
    raise SystemExit('The saved binding belongs to a different Git checkout.')
if saved['commit'] != source['commit']:
    print(f'Resuming the saved Workspace from {saved["commit"][:12]}. Host HEAD is {source["commit"][:12]}.')
PY
        ;;
    *) printf 'Inspect the incomplete import in /var/lib/pi-layerfs-podman-projects/data/projects/%s before retrying.\n' "$key" >&2; exit 1 ;;
esac

project_args=("$mode" "$key")
if [[ $mode == check ]]; then
    launch
else
    launch --interactive --tty --env "TERM=${TERM:-xterm-256color}"
fi
