# ADR 0001: Versioned Execution Hook Through Pi Events

- Status: Accepted; implemented as `pi-layerfs.execution` 1.2.
- Date: 2026-11-22

## Context

`pi-layerfs` and background-task consumers are independently installed Pi extensions. Pi's public `pi.events` bus supports inter-extension communication across their separate package roots.

The compatibility contract covers LayerFS alone, an independent background consumer alone, and combined execution in the selected LayerFS Workspace. Tool calls must preserve exact Workspace/execution identity and unknown effects.

## Decision

1. `pi-layerfs` owns Workspace lifecycle, file tools, standalone execution, and a public execution capability.
2. The provider announces the capability synchronously on `pi-layerfs:execution-capability` during session startup. Its asynchronous methods perform execution, status, wait, and cancellation.
3. Consumers retain their task registry and user-facing policies. They validate the structural protocol and capture the capability without a runtime import of this extension.
4. A recognized `layerfs_status` marker without a valid compatible capability fails closed. Provider absence permits the consumer's standalone backend.
5. File tools and the marker register during factory evaluation. Standalone Bash registers after the settled tool registry is available, preserving one shell owner across both load orders.
6. Original execution receipts, running observations, cancellation receipts, and original output completion retain their respective authority. Unknown effects do not trigger command replay.

## Rationale

The public event bus supplies the required shared communication point. A separate mandatory bridge package would add installation coupling without an additional runtime responsibility.

The canonical types, constants, and validator live in [src/protocol.ts](../../src/protocol.ts). [The hook documentation](../execution-hook.md) describes the public structural shape for independently released consumers. A separately published type-only package can be considered when additional consumers justify it.

## Version policy

Major version 1 defines the protocol identity, full Workspace binding, accepted execution handle, and `start/status/wait/cancel` methods.

- Minor 1 adds optional `outputDelivery: "on-completion"`.
- Minor 2 adds optional `outputComplete` to status DTOs.
- Compatible additions remain optional; new required fields or incompatible identity/cancellation semantics require a major version.

Read-only status qualification and original-result authority use this existing contract. A temporarily unconfirmed observation may be followed by an exact original success or known failure; original unknown, identity mismatch, and uncertain cancellation remain fail-closed.

## Consequences

- Consumer releases must qualify the supported major version and both extension load orders.
- Duplicate, malformed, stale, or incompatible providers cannot select a local fallback when LayerFS is detected.
- Accepted handles remain bound to their original Workspace and execution ID.
- Wait budgets cover asynchronous status and original-output completion independently.
- Buffered output is explicitly advertised. Cancellation confirmation can arrive before original output completion.
- Linux filesystem/deployment and persistence limits remain part of the documented support scope.
