# Set up pi-layerfs with Podman on Linux

Set up one Podman control container on the machine. Open each Git checkout with the same command to import it on first use and return to its saved LayerFS Workspace and Pi session on subsequent runs.

## 1. Get the runtime and tools

Use Linux x86-64 with cgroup v2, `/dev/fuse`, rootful Podman access through `sudo`, and an ext4 or other LayerFS-compatible local filesystem for `/var/lib`. Install Podman using your distribution's Linux instructions and check these commands in a terminal. The setup uses Podman's local engine directly.

```bash
podman --version
sudo podman --remote=false info --format '{{.Host.Security.Rootless}}'
test -c /dev/fuse
stat -fc %T /sys/fs/cgroup
findmnt -T /var/lib -no FSTYPE
```

The rootful check should print `false`. The cgroup filesystem should print `cgroup2fs`. The setup also uses Git, Python 3.11+, GNU coreutils and tar, `flock` from util-linux, and Node 24+ with npm on the host. Allow several GiB for the runtime, plus your repositories and Workspace changes.

Clone the current `main` checkout of `pi-layerfs` for the deployment examples. The `v0.1.0` tag remains the fixed extension source release; these setup examples are maintained on `main`.

```bash
git clone https://github.com/mapleluvr/pi-layerfs.git
cd pi-layerfs
```

The one-time setup uses three inputs.

| Input | Where to get it |
| --- | --- |
| `layerfs-node-2.0.0-rc.1.tgz` | The built SDK archive for the producer commit and SHA-256 recorded in [the pairing record](../integrations/layerfs/pairing.json). |
| Linux x86-64 LayerFS runtime directory | The same build's sealed directory containing `bundle.json`, `sandbox-image.tar`, `runtime/`, and the LayerFS binaries. |
| `node-v24.12.0-linux-x64.tar.xz` | The [official Node.js archive](https://nodejs.org/dist/v24.12.0/node-v24.12.0-linux-x64.tar.xz). The initializer checks its SHA-256. |

The GitHub source release supplies `pi-layerfs`, its docs and the pairing record. Obtain the two LayerFS inputs from a matching build. The registry package named `@layerfs/node@2.0.0-rc.1` has an older API, so the initializer verifies the archive itself.

### Build the LayerFS inputs when you have source only

Use the LayerFS source at the recorded commit. Follow its worktree preparation and Linux bundle instructions. The producer's bundle builder uses a separate Docker build environment and emits the sealed Linux directory. The default archive in the recorded pair uses a single Debian base layer. [LayerFS build setup](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ed9118963d5235767b53f9f7d084939ce9ee8256/docs/general/parallel-worktrees.md) · [Linux bundle build steps](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ed9118963d5235767b53f9f7d084939ce9ee8256/tools/linux_bundle.py)

In that same source checkout, the Node SDK's build command is `npm --prefix api run build:native`. It stages `api/node/layerfs.node`. Use `(cd api/node && npm pack --ignore-scripts)` to pack the SDK after the addon exists. Supply your build's SDK archive, addon and bundle manifest SHA-256 values in a separate pairing record with the same schema. Pass that file as a fourth argument to the initializer, then run the model-free project check below for the new pairing. The qualified inputs in this repository keep their original hashes. [Producer Node build entry](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ed9118963d5235767b53f9f7d084939ce9ee8256/api/package.json)

## 2. Initialize Podman once

From the cloned `pi-layerfs` checkout, set paths to your prepared inputs and run the initializer as your regular user. It requests `sudo` for the installation and starts one rootful container.

```bash
layerfs_sdk=/absolute/path/to/layerfs-node-2.0.0-rc.1.tgz
layerfs_bundle=/absolute/path/to/bundle/2.0.0/linux-x86_64
layerfs_node=/absolute/path/to/node-v24.12.0-linux-x64.tar.xz

PI_LAYERFS_PODMAN_NETWORK=bridge bash docs/examples/podman/bootstrap.sh \
  "$layerfs_sdk" "$layerfs_bundle" "$layerfs_node"
```

The example uses a Podman bridge network so the separate Pi profile can reach your model provider. Use `PI_LAYERFS_PODMAN_NETWORK=none` for a fully offline installation or a deployment with its own host-side model bridge. The control container is privileged for LayerFS native namespaces and FUSE (Filesystem in Userspace). The example mounts the fixed runtime, an incoming snapshot directory and a persistent data directory. Its LayerFS shell uses the nonroot command user `501`. Use this setup for repos and runtime inputs you trust.

The container is named `pi-layerfs-projects`. Its persistent LayerFS data and Pi files are under `/var/lib/pi-layerfs-podman-projects/data`. The Node dependencies and private snapshot inbox are prepared once. On successful initialization the script prints `Podman is ready`. If you already have a deployment with its own project launcher, continue using that launcher with its running container. This example prepares the separate `pi-layerfs-projects` deployment.

## 3. Open a repository

Run the helper from your Linux terminal, using the path to the `pi-layerfs` checkout. Pass a Git checkout path or run it from a Git checkout with no argument.

```bash
pi_layerfs_source=/absolute/path/to/pi-layerfs
bash "$pi_layerfs_source/docs/examples/podman/open-project.sh" --check /path/to/repo
bash "$pi_layerfs_source/docs/examples/podman/open-project.sh" /path/to/repo
```

`--check` is optional. It verifies the mounted FUSE view and a native `uid 501` shell without a model or a Pi session. The launcher requests `sudo` to enter the existing rootful container.

For a short daily command, create a symlink once. This preserves an existing command with the same name by refusing to replace it.

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$pi_layerfs_source/docs/examples/podman/open-project.sh" "$HOME/.local/bin/pi-layerfs"
```

With `~/.local/bin` on `PATH`, run `pi-layerfs` from a Git checkout, `pi-layerfs /path/to/repo` to select another checkout, or `pi-layerfs --check` for the offline check. Keep the source checkout available; the symlink uses its helper files.

The first run records the source checkout path and Git `HEAD`, then creates a LayerFS Project, an `agent` Branch and a Workspace. It imports committed files, retains executable permissions and internal symlinks, and excludes `.git`, `.env*`, `.ssh`, `.netrc` and `node_modules` as described in the [snapshot helper](examples/podman/git-snapshot.py). Uncommitted edits and untracked files stay in the source checkout. Git submodules need a separate import. Check committed data and `AGENTS.md` before sending project context to a model.

Pi loads the imported project's `AGENTS.md` through its ordinary context discovery and opens a dedicated session directory. Connect your provider in this profile with Pi's `/login` and `/model` commands. For a custom provider, configure the dedicated Pi profile under `data/pi-profile` using the normal Pi model configuration. Use the model-facing `bash` tool or Pi's interactive `!` shortcut for project commands. Both use the selected Workspace. [Pi provider configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)

The Sandbox image determines which build tools and commands are available. The sealed base image supports the shell verification. For development, prepare a native-compatible Docker archive for your toolchain and set the `native` machine's `image` through the paired `machine.update` API before creating the relevant Sandboxes. Install project dependencies inside the Workspace using that image and your lockfile. [LayerFS machine configuration](https://github.com/Ephemeral-AI-Lab/layerfs/blob/ed9118963d5235767b53f9f7d084939ce9ee8256/docs/architecture/api/sdk/machine.md#machineupdate)

Use `/quit` and run the same command to continue. Each checkout path keeps its own binding. If host `HEAD` moves, the launcher prints the imported commit and the current host commit, then opens the saved Workspace. This example serializes sessions in the control container. Keep the running container for ordinary reopen. Container restart with pending changes needs separate recovery and verification.

Workspace changes stay in LayerFS. To deliver changes back to Git, save a LayerFS checkpoint and review/export its tree against the recorded import baseline before applying the changes to a Git worktree. This launcher handles import and session resumption.

### Daily workflow and extension scope

| Task | Action |
| --- | --- |
| Start work | Run `pi-layerfs` in the Git checkout; first use imports its committed files. |
| Continue work | Use `/quit`, then run the same command to reopen the saved Workspace and Pi session. |
| Check shell placement | Use `layerfs_status` to inspect the binding, then `!id -u`; the command user is `501`. |
| Start from another Git baseline | Use a separate checkout path so it receives its own binding. Existing bindings retain their imported baseline. |
| Deliver changes | Select and export a LayerFS checkpoint, review its diff against the import baseline, and apply it in a Git delivery worktree. |

The example explicitly loads `pi-layerfs` and the interactive Workspace-shell helper into its dedicated Pi profile. Host extensions are configured separately. Per-worker LayerFS allocation for `pi-subagents` is a further integration step; this guide covers a single active Pi session in the control container.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/dev/fuse` is missing or the storage check fails | Verify the Linux FUSE device, cgroup v2, and the filesystem backing `/var/lib`. The example uses rootful Podman. |
| A library or native addon will not load | Compare the three input hashes and `bundle.json` with your pairing. The paired bundle contains the OpenSSL libraries used by the control environment. |
| `deploy.localDir` is not traversable | The command user must be able to traverse the container's data path. The initializer uses mode `0711` on the bind-mounted data directory, under a private host parent. |
| A project import stopped partway | Inspect `data/projects/<key>/source.json` and the error from the failing command. An incomplete import is retained for inspection. |
| A running container is reported missing | Check the container named `pi-layerfs-projects` with `sudo podman --remote=false ps -a`. Preserve its `data` directory while investigating recovery. |

The rootful FUSE preflight and single-Workspace migration were exercised on Linux x86-64. The example's project import, native shell and Pi resume flow were also exercised with two synthetic Git checkouts in an isolated Linux container. Your first `--check` validates the prepared local pairing and filesystem before you use it with project data.
