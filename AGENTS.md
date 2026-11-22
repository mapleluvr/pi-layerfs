# Project Rules

`pi-layerfs` is an independent Pi extension. Its public entry is `index.ts`; the implementation is in `src/`, and the canonical execution capability is in `src/protocol.ts`.

## Start and scope

- Read README, the relevant architecture/hook documents, and the task before changing behavior.
- Check the actual Git branch, HEAD, upstream, worktree, and existing changes. Preserve other tasks' tracked, untracked, ignored, and staged content.
- Run shell, Git, installation, and check commands with an explicit target cwd.
- Keep LayerFS, Pi, this extension, and optional consumers as separately owned projects and dependency trees.
- Remote writes, publication, license changes, model calls, system changes, and resource lifecycle operations require applicable operator authorization.

## Implementation

- Consume public Pi 1.5.2 extension APIs and public LayerFS SDK exports. Keep Pi/runtime objects with their owners; avoid private imports, installed-dependency edits, and monkey patches.
- Keep the extension factory thin. Configuration, Workspace lifecycle, execution, filesystem access, and structural protocol validation each have one implementation.
- Preserve the standalone and combined modes described in README. Background consumers discover the optional capability through `pi.events` and keep their own task policy.
- A detected LayerFS provider without a compatible capability fails closed. Combined execution cannot fall back to a local shell.
- Revalidate captured Workspace and execution identities. Preserve unknown effects, original-result authority, wait budgets, exact cancellation, and pending-output semantics.
- Keep Pi session authority outside LayerFS checkpoints. Normal reopen and VM snapshot resume provide their respective evidence; crash and power-loss durability require separate qualification.

## Checks and dependency pairing

- Use Node.js 24+ and the qualified SDK/runtime identity in `integrations/layerfs/pairing.json`.
- Prepare an independent dependency tree. Disable lifecycle scripts by default. The same-version npm SDK artifact is an older candidate; retain the qualified pairing during installation.
- Run `npm run typecheck` and relevant `npm test` coverage. Use synthetic files and deterministic providers for automatic tests.
- Behavior changes need focused regression evidence and appropriate consumer checks. Record actual exits, scope, skips, failures, and limits.
- Keep credentials with authentication processes and out of prompts, ordinary logs, Workspaces, and unrelated child environments.

## Resources and publication

- One writer owns a worktree and its mutable runtime/storage. Parallel implementation uses separate worktrees, dependencies, data, and ports.
- Preserve existing Workspaces, pending modifications, sessions, VMs, and uncertain operations. Cleanup must target exact owned resources with applicable authorization.
- Review the complete staged content and release range, including large files, before committing or publishing.
- Publish source, tests, supported documentation, and product metadata. Local task/handoff files, reports, raw logs, screenshots, databases, evidence bundles, dependencies, and credentials stay local.
- GitHub source publication and npm publication are separate operations. The project uses MIT; dependencies retain their own licenses.
