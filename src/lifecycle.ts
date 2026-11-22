import { client, LayerFSError } from "@layerfs/node";
import type { WorkspaceIdentity } from "./protocol.ts";
import type { LayerFSConfig } from "./config.ts";

export const PROVIDER_ID = "pi-layerfs";

type LayerFSClient = ReturnType<typeof client>;
type JsonRecord = Record<string, unknown>;

export interface WorkspaceBinding {
  lfs: LayerFSClient;
  identity: WorkspaceIdentity;
}

function record(value: unknown, description: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`LayerFS ${description} response is malformed`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`LayerFS response is missing ${field}`);
  return value;
}

function sameIdentity(current: JsonRecord, expected: WorkspaceIdentity): boolean {
  return current.workspace === expected.workspace
    && current.id === expected.workspaceId
    && current.path === expected.path
    && current.branch === expected.branch
    && current.mounted_at === expected.mountedAt
    && current.state === "ready";
}

function workspaceRecord(sandbox: JsonRecord, workspace: string): JsonRecord | undefined {
  const workspaces = sandbox.workspaces;
  if (!Array.isArray(workspaces)) throw new Error("LayerFS Sandbox response has no workspaces list");
  return workspaces.map((item) => record(item, "workspace entry")).find((item) => item.workspace === workspace);
}

export async function resolveWorkspace(config: LayerFSConfig, generation: number): Promise<WorkspaceBinding> {
  const lfs = client({ home: config.home });
  let sandbox: JsonRecord;
  try {
    sandbox = record(await lfs.sandbox.get(config.sandbox, { detail: true }), "sandbox.get");
  } catch (error) {
    if (!config.createSandbox || !(error instanceof LayerFSError) || error.code !== "NotFound") throw error;
    await lfs.sandbox.create(config.project, config.sandbox, {
      machine: config.machine,
      image: config.image,
    });
    sandbox = record(await lfs.sandbox.get(config.sandbox, { detail: true }), "sandbox.get");
  }

  if (sandbox.project !== config.project || sandbox.state !== "ready") {
    throw new Error("Configured LayerFS Sandbox identity or state does not match");
  }
  let current = workspaceRecord(sandbox, `${config.sandbox}:${config.workspace}`);
  if (!current) {
    await lfs.workspace.mount(config.sandbox, config.branch, { name: config.workspace });
    sandbox = record(await lfs.sandbox.get(config.sandbox, { detail: true }), "sandbox.get");
    if (sandbox.project !== config.project || sandbox.state !== "ready") {
      throw new Error("Configured LayerFS Sandbox identity or state does not match");
    }
    current = workspaceRecord(sandbox, `${config.sandbox}:${config.workspace}`);
  }
  if (!current || current.branch !== config.branch || current.state !== "ready") {
    throw new Error("Configured LayerFS Workspace could not be mounted with the requested branch");
  }

  const identity: WorkspaceIdentity = Object.freeze({
    providerId: PROVIDER_ID,
    sandbox: config.sandbox,
    workspace: requiredString(current.workspace, "workspace"),
    project: requiredString(sandbox.project, "project"),
    machine: requiredString(sandbox.machine, "machine"),
    image: requiredString(sandbox.image, "image"),
    sandboxCreatedAt: requiredString(sandbox.created_at, "created_at"),
    workspaceId: requiredString(current.id, "workspace id"),
    path: requiredString(current.path, "workspace path"),
    branch: requiredString(current.branch, "branch"),
    mountedAt: requiredString(current.mounted_at, "mounted_at"),
    generation,
  });
  return { lfs, identity };
}

export async function verifyWorkspace(binding: WorkspaceBinding): Promise<JsonRecord> {
  const sandbox = record(await binding.lfs.sandbox.get(binding.identity.sandbox, { detail: true }), "sandbox.get");
  if (sandbox.state !== "ready") throw new Error("LayerFS Sandbox is not ready; the binding is stale");
  for (const [field, key] of [["sandbox", "sandbox"], ["project", "project"], ["machine", "machine"], ["image", "image"], ["created_at", "sandboxCreatedAt"]] as const) {
    if (sandbox[field] !== binding.identity[key]) throw new Error(`LayerFS Sandbox ${field} changed; the binding is stale`);
  }
  const current = workspaceRecord(sandbox, binding.identity.workspace);
  if (!current || !sameIdentity(current, binding.identity)) throw new Error("LayerFS Workspace identity changed; the binding is stale");
  return current;
}
