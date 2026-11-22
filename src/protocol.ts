import { isAbsolute } from "node:path";

export const EXECUTION_CAPABILITY_EVENT = "pi-layerfs:execution-capability";
export const LAYERFS_TOOL_MARKER = "layerfs_status";
export const BASH_BG_MARKERS = ["bg_run", "bg_status", "bg_logs", "bg_kill", "bg_join"] as const;
export const EXECUTION_PROTOCOL_ID = "pi-layerfs.execution";
export const EXECUTION_PROTOCOL_MAJOR = 1;
export const EXECUTION_PROTOCOL_MINOR = 2;

export interface WorkspaceIdentity {
  providerId: string;
  sandbox: string;
  workspace: string;
  project: string;
  machine: string;
  image: string;
  sandboxCreatedAt: string;
  workspaceId: string;
  path: string;
  branch: string;
  mountedAt: string;
  generation: number;
}

export type ExecutionState = "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface ExecutionStatus {
  state: ExecutionState;
  exitCode: number | null;
  /** Original exec/callback reception settled; not recovery of lost output after Unknown. */
  outputComplete?: boolean;
}

export interface StartExecutionInput {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onData?: (data: Buffer) => void;
}

export interface ExecutionHandle {
  execId: string;
  workspace: WorkspaceIdentity;
}

export interface LayerFSExecutionCapability {
  protocol: {
    id: typeof EXECUTION_PROTOCOL_ID;
    major: number;
    minor: number;
  };
  providerId: string;
  workspace: WorkspaceIdentity;
  outputDelivery?: "on-completion";
  start(input: StartExecutionInput): Promise<ExecutionHandle>;
  status(handle: ExecutionHandle): Promise<ExecutionStatus>;
  wait(handle: ExecutionHandle, timeoutMs?: number): Promise<ExecutionStatus>;
  cancel(handle: ExecutionHandle): Promise<ExecutionStatus>;
}

const REQUIRED_IDENTITY_FIELDS: Array<keyof WorkspaceIdentity> = [
  "providerId", "sandbox", "workspace", "project", "machine", "image",
  "sandboxCreatedAt", "workspaceId", "path", "branch", "mountedAt",
];

export function isLayerFSExecutionCapability(value: unknown): value is LayerFSExecutionCapability {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LayerFSExecutionCapability>;
  return item.protocol?.id === EXECUTION_PROTOCOL_ID
    && item.protocol.major === EXECUTION_PROTOCOL_MAJOR
    && Number.isInteger(item.protocol.minor)
    && item.protocol.minor! >= 0
    && item.providerId === "pi-layerfs"
    && !!item.workspace
    && item.workspace.providerId === item.providerId
    && REQUIRED_IDENTITY_FIELDS.every((field) => typeof item.workspace?.[field] === "string" && item.workspace[field].length > 0)
    && isAbsolute(item.workspace.path)
    && Number.isInteger(item.workspace.generation)
    && item.workspace.generation > 0
    && typeof item.start === "function"
    && typeof item.status === "function"
    && typeof item.wait === "function"
    && typeof item.cancel === "function";
}
