# pi-layerfs

LayerFS-backed file tools and a versioned execution hook for [Pi](https://github.com/earendil-works/pi). The extension binds a Pi session to an explicitly selected LayerFS Project, Sandbox, Branch, and Workspace.

## Features

- Workspace-backed `read`, `edit`, and `write`, using Pi's public tool definitions.
- Standalone `bash` execution through LayerFS and a `layerfs_status` tool.
- A public `pi-layerfs.execution` 1.2 capability for optional background-task consumers.
- Exact Workspace/execution identity checks, bounded output, and explicit `unknown` outcomes.
- Independent operation, with a hook-aware `pi-bash-bg` adapter supporting the combined mode.

## Requirements and release scope

**v0.1.0 is a GitHub source release for a prepared Linux x86-64 LayerFS environment.**

- Node.js 24+ and Pi 1.5.2.
- LayerFS source commit `ed9118963d5235767b53f9f7d084939ce9ee8256`, with its paired Node SDK, native addon, and Linux runtime bundle.
- A Pi process that can access both the SDK's control records and the selected Workspace's mounted filesystem at its declared path.
- Linux `/proc/self/fd`, `O_NOFOLLOW`, and a qualified native/FUSE backend.

The qualified SDK identifies itself as `@layerfs/node@2.0.0-rc.1`, but the same-version npm registry artifact has an older API surface. Prepare the matched SDK/runtime described in [the pairing record](integrations/layerfs/pairing.json). GitHub publishes this extension's source; the paired LayerFS binaries remain a separate prerequisite.

See [verification and limitations](docs/verification/v0.1.0.md) for the exercised scope.

## Install in a prepared environment

Clone the tagged source and install the matched SDK archive together with the package's declared dependencies. Installation scripts are disabled:

```bash
git clone https://github.com/mapleluvr/pi-layerfs.git
cd pi-layerfs
git checkout v0.1.0

# Supply the Node SDK archive from the qualified LayerFS build.
LAYERFS_SDK_TGZ=/absolute/path/to/layerfs-node-2.0.0-rc.1.tgz
npm install --ignore-scripts --no-audit --no-fund --no-save \
  --package-lock=false "$LAYERFS_SDK_TGZ"
```

The recorded SDK archive SHA-256 is:

```text
a9dd7caee673f12eee720cb44ef8bdc2fcbd350bbaa89cd8524e2d085d6fa569
```

An independently rebuilt SDK has its own byte identity and needs a corresponding pairing qualification. Prepare the LayerFS Project, Branch, and Sandbox using that build's public management API. Configure the extension, then start Pi in the environment with the required control and mounted-file views:

```bash
export LAYERFS_HOME=/absolute/path/to/layerfs-home
export PI_LAYERFS_PROJECT=my-project
export PI_LAYERFS_SANDBOX=my-sandbox
export PI_LAYERFS_BRANCH=my-task
export PI_LAYERFS_WORKSPACE=agent

pi --no-extensions -e ./index.ts
```

The example loads only this extension and makes no persistent Pi configuration change. Pi's ordinary session storage stays outside LayerFS checkpoints. Use `layerfs_status` to inspect the binding.

A host directory change leaves the selected LayerFS Project unchanged. Project import, candidate export, Git delivery, and source-directory write-back are managed separately.

### Configuration

| Variable | Required / default | Meaning |
| --- | --- | --- |
| `LAYERFS_HOME` | Required | Home of the prepared LayerFS control environment |
| `PI_LAYERFS_PROJECT` | Required | Existing Project identifier |
| `PI_LAYERFS_SANDBOX` | Required | Sandbox identifier |
| `PI_LAYERFS_BRANCH` | `agent` | Existing Branch to mount |
| `PI_LAYERFS_WORKSPACE` | `agent` | Short Workspace name within the Sandbox |
| `PI_LAYERFS_CREATE_SANDBOX` | Disabled; enable with `1` | Explicitly permit creation of a missing Sandbox |
| `PI_LAYERFS_MACHINE` | Required for Sandbox creation | Prepared machine identifier |
| `PI_LAYERFS_IMAGE` | Required for Sandbox creation | Explicit runtime image |

A missing Workspace is mounted on session startup. An existing Workspace must match the requested Branch and full recorded identity.

## Optional background-task integration

| Loaded extensions | Shell owner | Execution |
| --- | --- | --- |
| `pi-layerfs` | `pi-layerfs` | Selected LayerFS Workspace |
| Hook-aware `pi-bash-bg` | `pi-bash-bg` | Its standalone local backend |
| Both, compatible hook | `pi-bash-bg` | Captured LayerFS capability |

The consumer adapter owns background task IDs, logs, status, join, and cancellation tools. This repository publishes the provider and its [execution-hook contract](docs/execution-hook.md); the consumer is released separately.

A detected LayerFS provider with an absent or incompatible capability fails closed. Combined-mode commands remain bound to LayerFS without a host-shell fallback.

## Output and safety

The fixed SDK delivers stdout/stderr after command completion. Running tasks can therefore have empty logs. Capture is limited to 1 MiB per stream; standalone Bash previews use Pi's 50 KiB / 2,000-line truncation.

`outputComplete` distinguishes original output completion from a cancellation receipt. Waiting timeouts preserve the current receipt; exact cancellation is a separate operation. Unknown execution effects remain unknown and commands are never automatically replayed.

File operations pin descriptors and reject external symlink targets, including dangling targets. Concurrent directory relocation, mount changes, and hard-link aliases remain outside the proven atomic-confinement boundary. Credentials belong to their authentication process and must remain outside command environments and ordinary logs.

## Development

After preparing the dependency pairing above:

```bash
npm run typecheck
npm test
```

The checked-in tests use public-shaped fake providers and synthetic local files. They cover binding, protocol validation, execution authority, wait budgets, output completion, and file-path handling.

- [Architecture](docs/architecture.md)
- [Execution hook](docs/execution-hook.md)
- [Design decision](docs/decisions/0001-versioned-execution-hook.md)
- [v0.1.0 verification](docs/verification/v0.1.0.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). LayerFS and Pi dependencies retain their own licenses.
