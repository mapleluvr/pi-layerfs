# Execution Hook

## Discovery and compatibility

The provider announces a capability on Pi's public event bus:

| Field | Value |
| --- | --- |
| Event | `pi-layerfs:execution-capability` |
| Protocol ID | `pi-layerfs.execution` |
| Major / minor | `1 / 2` |
| Provider ID | `pi-layerfs` |
| Provider marker tool | `layerfs_status` |

The canonical types and validator are in [src/protocol.ts](../src/protocol.ts). Consumers validate the structural payload rather than importing the provider's runtime module.

Register the listener during extension factory evaluation. Announcement is synchronous; asynchronous execution uses the capability's methods. A session supports one compatible provider. A detected marker with missing, malformed, duplicate, stale, or incompatible capability must refuse execution instead of selecting a host shell.

Compatible minor additions are optional. A new required field or incompatible identity/cancellation meaning requires a major version.

## Workspace and handle identity

The advertised Workspace contains:

- Provider ID, Project, Sandbox, machine, and image.
- Sandbox creation time.
- Workspace name, ID, declared path, Branch, and mount time.
- A positive session-binding generation.

An execution handle contains the accepted `execId` and the captured Workspace identity. Consumers keep that handle for every status, wait, and cancellation operation. They must not substitute a new Workspace or independently supplied execution ID.

## Methods

| Method | Input | Result |
| --- | --- | --- |
| `start(input)` | Command, Workspace-relative cwd, optional explicit env/AbortSignal/output callback | Promise of an accepted execution handle |
| `status(handle)` | Captured handle | Promise of an execution status |
| `wait(handle, timeoutMs?)` | Captured handle and optional caller budget | Promise of the observed status or original completion |
| `cancel(handle)` | Captured handle | Promise of the exact operation's cancellation/outcome observation |

`start` resolves from the public accepted execution identity. Root cwd uses `"."` or an empty string and is translated to omitted SDK cwd. Subdirectories follow the paired SDK's Workspace-relative path validation.

Explicit environment overrides are filtered to `PATH`, `LANG`, `LC_ALL`, `TZ`, `TERM`, and `CI`. Credentials belong outside command and unrelated controller environments.

## Status and output

Status fields:

| Field | Meaning |
| --- | --- |
| `state` | `running`, `succeeded`, `failed`, `cancelled`, or `unknown` |
| `exitCode` | Exact known exit code, otherwise `null` |
| `outputComplete?` | Original exec/output reception has settled |

Minor 1 advertises optional `outputDelivery: "on-completion"`. The fixed provider buffers stdout/stderr until execution completes. Running logs can be empty. The output callback receives bounded buffers; capture is limited to 1 MiB per stream, with no cross-stream interleaving-order guarantee.

Minor 2 distinguishes cancellation confirmation from original output completion. A confirmed cancellation can have `outputComplete: false`; consumers keep receiving output until the original executor settles, then complete their own log flush.

## Outcome authority

A verified running-only lookup can confirm current activity. An empty running list or unreturned lookup leaves the observation unconfirmed. The exact captured original result may still establish success or known failure.

Original unknown/rejection, mismatched handles/bindings, and uncertain cancellation remain fail-closed. An unknown observation is not permission to replay a command or request cancellation again.

Waiters share at most one in-flight read-only query and race original completion against their own asynchronous budget. A timeout returns an immediate receipt; it does not await a replacement query, cancel the underlying RPC, prove command exit, or roll back effects.

Consumers may expose the accepted `execId` in task details, while retaining their own task ID for registry operations. The optional ID must come from the captured handle and remain stable. Consumer task policy, output storage, joins, and UI remain consumer-owned.
