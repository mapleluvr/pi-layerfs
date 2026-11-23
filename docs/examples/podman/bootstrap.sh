#!/usr/bin/env bash
# Prepare one rootful Podman control container for the projects opened by open-project.sh.
set -euo pipefail
umask 077

if (( $# < 3 || $# > 4 || EUID == 0 )); then
    printf 'Run as your regular user with SDK_ARCHIVE BUNDLE_DIR NODE_ARCHIVE [PAIRING_JSON].\n' >&2
    exit 2
fi
examples=$(dirname -- "$(realpath -- "$0")")
extension=$(cd -- "$examples/../../.." && pwd -P)
sdk=$(realpath -- "$1")
bundle=$(realpath -- "$2")
node_archive=$(realpath -- "$3")
pairing=$(realpath -- "${4:-$extension/integrations/layerfs/pairing.json}")
stage=${PI_LAYERFS_PODMAN_STAGE:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-layerfs-podman-projects}
root=/var/lib/pi-layerfs-podman-projects
name=pi-layerfs-projects
podman=$(command -v podman)
network=${PI_LAYERFS_PODMAN_NETWORK:-none}
[[ $network == none || $network == bridge ]]
test -c /dev/fuse
[[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]]

python3 - "$pairing" "$sdk" "$bundle" "$node_archive" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

pair, sdk, bundle, node = (Path(value) for value in sys.argv[1:])
pairing = json.loads(pair.read_text())


def check(path, expected):
    with path.open('rb') as data:
        actual = hashlib.file_digest(data, 'sha256').hexdigest()
    if actual != expected:
        raise SystemExit(f'SHA-256 mismatch for {path}: {actual}')


check(sdk, pairing['sdk']['archive']['sha256'])
check(node, 'bdebee276e58d0ef5448f3d5ac12c67daa963dd5e0a9bb621a53d1cefbc852fd')
manifest_path = bundle / 'bundle.json'
check(manifest_path, pairing['runtime']['bundleManifestSha256'])
manifest = json.loads(manifest_path.read_text())
assert manifest['platform'] == 'linux-x86_64' and manifest['protocol'] == 3
for name, digest in manifest['files'].items():
    file = bundle / name
    assert file.resolve().is_relative_to(bundle)
    check(file, digest)
print('SDK, Node archive and native runtime identities verified.')
PY

sudo -v
if sudo -n test -e "$root"; then
    printf 'The control deployment already exists at %s. Use open-project.sh to import projects.\n' "$root" >&2
    exit 1
fi
install -d -m 0700 -- "$stage" "$stage/incoming"
stage=$(realpath -- "$stage")
[[ $stage != *,* ]]
prepared=$(mktemp -d "$stage/runtime.XXXXXXXX")
trap 'rm -rf --one-file-system -- "$prepared"' EXIT
install -d -m 0755 -- "$prepared/projects" "$prepared/extension"
tar --extract --file="$node_archive" --directory="$prepared" --strip-components=1 \
    --no-same-owner --same-permissions node-v24.12.0-linux-x64/bin/node
install -m 0644 -- "$examples/project.mjs" "$examples/attach-view.pl" "$examples/project-shell.ts" "$prepared/projects/"
cp -R -- "$extension/index.ts" "$extension/src" "$extension/package.json" "$prepared/extension/"
npm install --prefix "$prepared" --ignore-scripts --no-audit --no-fund --no-save --package-lock=false \
    '@earendil-works/pi-coding-agent@1.5.2' 'typebox@1.3.27' "$sdk"
expected_addon=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sdk"]["nativeAddon"]["sha256"])' "$pairing")
printf '%s  %s\n' "$expected_addon" "$prepared/node_modules/@layerfs/node/layerfs.node" | sha256sum --check --quiet

sudo bash -s -- "$root" "$bundle" "$prepared" "$stage/incoming" "$podman" "$name" "$network" <<'ROOT'
set -euo pipefail
umask 077
root=$1
bundle=$2
runtime=$3
incoming=$4
podman=$5
name=$6
network=$7
if "$podman" --remote=false container exists "$name"; then
    printf 'The container name %s is already in use.\n' "$name" >&2
    exit 1
else
    [[ $? -eq 1 ]]
fi
mkdir -m 0700 -- "$root"
install -d -m 0755 -- "$root/rootfs"
install -d -m 0711 -- "$root/data"
cp -R -- "$runtime" "$root/runtime"
cp -a -- "$bundle" "$root/bundle"
chmod -R go-w -- "$root/runtime" "$root/bundle"
tar -xOf "$root/bundle/sandbox-image.tar" 0/layer.tar |
    tar --extract --file=- --numeric-owner --same-permissions --directory="$root/rootfs"
install -m 0644 -- "$root/bundle/runtime/lib/libssl.so.3" "$root/bundle/runtime/lib/libcrypto.so.3" \
    "$root/rootfs/usr/lib/x86_64-linux-gnu/"
"$podman" --remote=false run --detach --init --name "$name" --label pi.layerfs.guide=projects \
    --privileged --userns=host --pid=private --ipc=private --cgroupns=private --network="$network" \
    --log-driver=none \
    --mount "type=bind,source=$root/bundle,target=/layerfs-bundle,ro,bind-propagation=rprivate" \
    --mount "type=bind,source=$root/runtime,target=/runtime,ro,bind-propagation=rprivate" \
    --mount "type=bind,source=$root/data,target=/persist,bind-propagation=rprivate" \
    --mount "type=bind,source=$incoming,target=/incoming,ro,bind-propagation=rprivate" \
    --env LAYERFS_BUNDLE=/layerfs-bundle --env LAYERFS_HOME=/persist/layerfs \
    --rootfs "$root/rootfs" /usr/bin/sleep infinity > "$root/container.id"
IFS= read -r container < "$root/container.id"
"$podman" --remote=false exec "$container" /bin/bash -euc '
    test -c /dev/fuse
    test -w /sys/fs/cgroup
    /usr/bin/setpriv --reuid=501 --regid=20 --clear-groups -- /usr/bin/test -x /persist
    /runtime/bin/node --version
'
printf 'Podman is ready. Open the first checkout with open-project.sh.\n'
ROOT
