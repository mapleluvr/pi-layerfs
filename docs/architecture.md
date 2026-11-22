# Architecture

## Responsibilities

The extension binds Pi's tools to one selected LayerFS Workspace and provides an optional execution capability for independent consumers.

| Responsibility | Owner |
| --- | --- |
| Project/Sandbox/Branch selection, Workspace binding, file tools, standalone Bash, execution hook | `pi-layerfs` |
| Background task policy, IDs, logs, status/join/cancel tools, standalone local backend | Hook-aware consumer such as `pi-bash-bg` |
| Tool registry, extension lifecycle/event bus, model runtime, ordinary session storage | Pi |
| Mounted views, Branch/checkpoint semantics, native execution receipts | Paired LayerFS SDK/runtime |

Each extension has its own package root. Capability exchange uses Pi's public event bus and a structural contract across those roots.

## Source layout

```text
index.ts                  Pi extension factory, tool registration, session lifecycle
src/config.ts             Environment configuration validation
src/lifecycle.ts          Public SDK adapter and full Workspace identity validation
src/execution.ts          Execution handles, original results, status, wait, cancellation
src/filesystem.ts         Descriptor-pinned Linux file operations
src/protocol.ts           Public event/version constants, types, capability validation
tests/                    Synthetic local and public-shaped provider regressions
docs/                     Architecture, execution hook, decisions, verification
integrations/layerfs/     Qualified producer/SDK/runtime identity
```

The public extension uses Pi's read/edit/write tool-definition factories so their schemas and core behavior remain Pi-owned. The custom operations target the mounted Workspace view.

## Binding and lifecycle

```text
unbound → preparing → ready
                    ↘ degraded
ready → closing → closed
```

Session startup resolves the configured Sandbox, verifies its Project and ready state, and locates or explicitly mounts the requested Workspace. Optional Sandbox creation requires explicit configuration.

The immutable binding records provider, Project, Sandbox, machine/image, Sandbox creation time, Workspace ID/name/path/Branch/mount time, and generation. Commands and live lookups use that captured identity. A replaced Workspace invalidates the binding.

Shutdown invalidates the session binding and requests cancellation of executions eligible for cancellation. It preserves unresolved receipts and pending files. File commit, discard, unmount, and source write-back belong to separate management operations.

## Tool composition

File tools and `layerfs_status` are registered during extension loading. Standalone `bash` is registered at `session_start`, after examining the settled public tool registry for the background consumer's marker tools.

This accommodates Pi's public loader checking duplicate extension tool names before startup and lets both extension load orders settle with one shell owner.

- LayerFS alone: this extension owns `bash`.
- Background consumer alone: that consumer uses its independent local backend.
- Compatible combined mode: the consumer owns `bash` and uses the LayerFS capability.
- Detected provider with an unavailable/malformed/incompatible capability: consumers report an error and refuse local execution.

The required consumer markers are `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, and `bg_join`. Consumer releases need their own compatibility checks.

## Execution capability

[The hook contract](execution-hook.md) specifies `pi-layerfs.execution` 1.2 on `pi-layerfs:execution-capability`.

`pi.events.emit()` synchronously hands off the capability. It does not await listener promises. Consumers subscribe during factory evaluation; the provider announces at startup. Commands, status, wait, and cancellation use the capability's asynchronous methods.

`start()` resolves with the public accepted execution ID from progress or the original result. The handle retains the exact Workspace identity. Later mismatched IDs or bindings become unknown rather than retargeting a task.

## Outcome and observation authority

An original execution receipt establishes success, known failure, cancellation, or unknown. A running-only lookup establishes confirmed current activity; an empty running list is an unconfirmed observation.

The provider keeps these authorities separate. An identity-matched original result can settle a task after an unconfirmed observation. An original unknown/rejection, identity mismatch, or uncertain cancellation remains fail-closed.

Waiters race original completion against their own deadline while sharing at most one in-flight read-only observation. A stalled status query does not extend the caller's asynchronous wait budget. Late observations cannot replace a settled original result.

Cancellation targets the original execution ID once. A cancellation receipt can precede original output delivery. `outputComplete` preserves that distinction; stopping a wait does not prove cancellation, rollback, or non-delivery.

## Output and environment

The paired SDK supplies stdout/stderr on completion. Running logs can be empty. Capture is bounded to 1 MiB per stream, and standalone Bash previews use Pi's 50 KiB / 2,000-line tail truncation.

The execution provider filters explicit environment overrides to `PATH`, `LANG`, `LC_ALL`, `TZ`, `TERM`, and `CI`. Deployment must also keep credentials out of SDK/controller and unrelated process environments.

## Filesystem and deployment

The Linux file adapter pins directories and leaf files through `/proc/self/fd` with `O_NOFOLLOW`. It resolves contained links explicitly and rejects external existing or dangling targets before creation/truncation. It validates the acquired descriptor before modifying bytes.

Concurrent directory relocation, mount changes, and hard-link aliases remain outside the proven atomic-confinement boundary. The actual OS execution isolation belongs to LayerFS.

The Pi process requires the SDK's control view plus the exact Workspace FUSE view. The qualified deployment used a prepared Linux-native control environment and a private mount namespace; command execution remained with the nonroot identity selected by LayerFS. This repository provides the extension and pairing metadata. Machine bootstrap and privileged mount preparation are deployment responsibilities.

## Storage, delivery, and support

Pi sessions remain in ordinary Pi storage. LayerFS file checkpoints preserve their file state; they do not establish external-effect rollback or authoritative conversation recovery.

Project import, candidate export, and Git delivery are separate workflow operations. Version 0.1.0 qualifies the fixed Linux pairing and the documented hook semantics. Broader platforms, live output streaming, native SDK/daemon unknown-fault injection, and crash/power-loss persistence retain separate verification requirements.
