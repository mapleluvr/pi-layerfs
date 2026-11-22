import { LayerFSError } from "@layerfs/node";
import type { LayerFSConfig } from "./config.ts";
import { resolveWorkspace, verifyWorkspace, type WorkspaceBinding } from "./lifecycle.ts";
import {
  EXECUTION_CAPABILITY_EVENT,
  EXECUTION_PROTOCOL_ID,
  EXECUTION_PROTOCOL_MAJOR,
  EXECUTION_PROTOCOL_MINOR,
  type ExecutionHandle,
  type ExecutionState,
  type ExecutionStatus,
  type LayerFSExecutionCapability,
  type StartExecutionInput,
} from "./protocol.ts";

const MAX_CAPTURE_BYTES = 1_048_576;
const CANCEL_OBSERVE_MS = 5_000;
const ALLOWED_ENV = new Set(["PATH", "LANG", "LC_ALL", "TZ", "TERM", "CI"]);

type RecordState = ExecutionStatus | undefined;
interface ExecRecord {
  handle: ExecutionHandle;
  state: RecordState;
  completion: Promise<ExecutionStatus>;
  outputComplete: boolean;
  // A verified running-only observation is not the original execution outcome.
  statusObservation?: ExecutionStatus;
  statusQuery?: Promise<ExecutionStatus>;
  cancelAttempted: boolean;
}

function parseState(value: unknown): ExecutionStatus {
  const item = value as Record<string, unknown>;
  const code = typeof item?.exit_code === "number" ? item.exit_code : null;
  if (item?.unknown === true || item?.outcome === "unknown") return { state: "unknown", exitCode: null };
  if (item?.cancelled === true || item?.outcome === "cancelled") return { state: "cancelled", exitCode: code };
  if (typeof item?.exit_code !== "number") return { state: "unknown", exitCode: null };
  return { state: code === 0 ? "succeeded" : "failed", exitCode: code };
}

function safeEnv(source: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!source) return undefined;
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (ALLOWED_ENV.has(name) && typeof value === "string") filtered[name] = value;
  }
  return filtered;
}

function progressExec(progress: unknown): string | undefined {
  if (!progress || typeof progress !== "object") return undefined;
  const item = progress as Record<string, unknown>;
  if (item.phase !== "start") return undefined;
  const exec = item.exec;
  if (typeof exec === "string" && exec.length > 0) return exec;
  if (!exec || typeof exec !== "object") return undefined;
  const execRecord = exec as Record<string, unknown>;
  return typeof execRecord.id === "string" && execRecord.id.length > 0 ? execRecord.id : undefined;
}

function execIdFromResult(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
}

function executionStatusFromLive(running: unknown, execId: string): ExecutionStatus {
  if (!Array.isArray(running)) return { state: "unknown", exitCode: null };
  const found = running.some((entry) => entry === execId
    || (entry && typeof entry === "object" && (entry.id === execId || entry.exec === execId)));
  return found ? { state: "running", exitCode: null } : { state: "unknown", exitCode: null };
}

export class LayerFSExecutionProvider implements LayerFSExecutionCapability {
  readonly protocol = { id: EXECUTION_PROTOCOL_ID, major: EXECUTION_PROTOCOL_MAJOR, minor: EXECUTION_PROTOCOL_MINOR } as const;
  readonly providerId = "pi-layerfs";
  readonly outputDelivery = "on-completion" as const;
  readonly workspace;
  private readonly binding: WorkspaceBinding;
  private readonly records = new Map<string, ExecRecord>();

  constructor(binding: WorkspaceBinding) {
    this.binding = binding;
    this.workspace = binding.identity;
  }

  static async create(config: LayerFSConfig, generation: number): Promise<LayerFSExecutionProvider> {
    return new LayerFSExecutionProvider(await resolveWorkspace(config, generation));
  }

  async assertCurrent(): Promise<void> {
    await verifyWorkspace(this.binding);
  }

  async start(input: StartExecutionInput): Promise<ExecutionHandle> {
    await this.assertCurrent();
    if (input.signal?.aborted) throw new Error("Command aborted");
    const cwd = input.cwd || ".";
    let resolveHandle!: (handle: ExecutionHandle) => void;
    let rejectHandle!: (error: unknown) => void;
    let handleResolved = false;
    let acceptedRecord: ExecRecord | undefined;
    const handlePromise = new Promise<ExecutionHandle>((resolve, reject) => {
      resolveHandle = resolve;
      rejectHandle = reject;
    });
    const buffers = { stdout: 0, stderr: 0 };
    const deliver = (stream: "stdout" | "stderr", data: unknown) => {
      let bytes: Buffer | undefined;
      if (Buffer.isBuffer(data)) bytes = data;
      else if (typeof data === "string") bytes = Buffer.from(data);
      if (!bytes) return;
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - buffers[stream]);
      if (!remaining) return;
      const bounded = bytes.subarray(0, remaining);
      buffers[stream] += bounded.length;
      try { input.onData?.(bounded); } catch { /* Output observers do not change execution results. */ }
    };

    const execution = this.binding.lfs.workspace.exec(this.workspace.workspace, input.command, {
        ...(cwd === "." ? {} : { cwd }),
        env: safeEnv(input.env),
        detail: true,
        stdout: (bytes: string | Buffer) => deliver("stdout", bytes),
        stderr: (bytes: string | Buffer) => deliver("stderr", bytes),
        on_progress: (progress: unknown) => {
          const execId = progressExec(progress);
          if (!execId) return;
          if (handleResolved) {
            if (acceptedRecord && acceptedRecord.handle.execId !== execId) {
              acceptedRecord.state = { state: "unknown", exitCode: null };
            }
            return;
          }
          handleResolved = true;
          const handle = { execId, workspace: this.workspace };
          acceptedRecord = {
            handle,
            state: undefined,
            completion: Promise.resolve({ state: "unknown", exitCode: null }),
            outputComplete: false,
            cancelAttempted: false,
          };
          this.records.set(execId, acceptedRecord);
          resolveHandle(handle);
        },
      }) as Promise<Record<string, unknown>>;

    void execution.then((result) => {
      const execId = execIdFromResult(result.exec);
      if (acceptedRecord && execId && acceptedRecord.handle.execId !== execId) {
        acceptedRecord.state = { state: "unknown", exitCode: null };
        return;
      }
      if (execId && !handleResolved) {
        handleResolved = true;
        const handle = { execId, workspace: this.workspace };
        acceptedRecord = {
          handle,
          state: undefined,
          completion: Promise.resolve({ state: "unknown", exitCode: null }),
          outputComplete: false,
          cancelAttempted: false,
        };
        this.records.set(execId, acceptedRecord);
        resolveHandle(handle);
      }
      if (acceptedRecord && (!acceptedRecord.state || acceptedRecord.state.state === "running")) acceptedRecord.state = parseState(result);
      if (!handleResolved) rejectHandle(new Error("LayerFS exec returned without an accepted execution id"));
    }).catch((error) => {
      if (acceptedRecord) acceptedRecord.state = { state: "unknown", exitCode: null };
      if (error instanceof LayerFSError && error.code !== "Unknown") {
        if (!handleResolved) rejectHandle(error);
        return;
      }
      if (!handleResolved) {
        const startError = error instanceof LayerFSError && error.code === "Unknown"
          ? new Error("LayerFS execution start outcome is unknown; do not retry the command", { cause: error })
          : error;
        rejectHandle(startError);
      }
    });

    const handle = await handlePromise;
    const entry = acceptedRecord;
    if (!entry || entry.handle.execId !== handle.execId) throw new Error("LayerFS execution handle became ambiguous; do not retry the command");
    entry.completion = execution.then((result) => {
      entry.outputComplete = true;
      const resultExecId = execIdFromResult(result.exec);
      if (resultExecId && resultExecId !== handle.execId) {
        entry.state = { state: "unknown", exitCode: null };
      } else if (entry.state?.state !== "unknown") {
        const status = parseState(result);
        entry.state = entry.state?.state === "cancelled" && status.state !== "unknown"
          ? { state: "cancelled", exitCode: status.exitCode }
          : status;
      }
      return this.observation(entry, entry.state!);
    }).catch(() => {
      entry.outputComplete = true;
      entry.state = { state: "unknown", exitCode: null };
      return this.observation(entry, entry.state);
    });

    if (input.signal) {
      const onAbort = () => {
        void this.cancel(handle).catch(() => { entry.state = { state: "unknown", exitCode: null }; });
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
      void entry.completion.finally(() => input.signal?.removeEventListener("abort", onAbort));
    }
    return handle;
  }

  async shutdown(): Promise<void> {
    const active = [...this.records.values()].filter((record) => (!record.state || record.state.state === "running") && record.statusObservation?.state !== "unknown");
    await Promise.all(active.map(async (record) => {
      try {
        await this.cancel(record.handle);
      } catch {
        record.state = { state: "unknown", exitCode: null };
      }
    }));
  }

  private observation(record: ExecRecord, status: ExecutionStatus): ExecutionStatus {
    return { ...status, outputComplete: record.outputComplete };
  }

  private async recordFor(handle: ExecutionHandle, verifyCurrent = true): Promise<ExecRecord> {
    if (handle.workspace.providerId !== this.providerId
      || handle.workspace.generation !== this.workspace.generation
      || handle.workspace.workspaceId !== this.workspace.workspaceId
      || handle.workspace.path !== this.workspace.path) {
      return { handle, state: { state: "unknown", exitCode: null }, completion: Promise.resolve({ state: "unknown", exitCode: null }), outputComplete: false, cancelAttempted: true };
    }
    if (verifyCurrent) await this.assertCurrent();
    const record = this.records.get(handle.execId);
    if (!record) throw new Error("Unknown LayerFS execution handle");
    return record;
  }

  async status(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const record = await this.recordFor(handle, false);
    if (record.state && record.state.state !== "running") return this.observation(record, record.state);
    if (record.statusObservation?.state === "unknown") return this.observation(record, record.statusObservation);
    if (!record.statusQuery) {
      const query = verifyWorkspace(this.binding).then((workspace) => {
        if (this.records.get(handle.execId) !== record) return { state: "unknown", exitCode: null, outputComplete: false } as ExecutionStatus;
        if (!record.outputComplete && (!record.state || record.state.state === "running")) {
          record.statusObservation = executionStatusFromLive(workspace.running, handle.execId);
        }
        return this.observation(record, record.state ?? record.statusObservation!);
      }).catch(() => {
        if (this.records.get(handle.execId) !== record) return { state: "unknown", exitCode: null, outputComplete: false } as ExecutionStatus;
        if (!record.outputComplete && (!record.state || record.state.state === "running")) {
          record.state = { state: "unknown", exitCode: null };
        }
        return this.observation(record, record.state!);
      }).finally(() => {
        if (record.statusQuery === query) record.statusQuery = undefined;
      });
      record.statusQuery = query;
    }
    // A retained observation never blocks delivery of the captured original result.
    return Promise.race([record.completion, record.statusQuery]);
  }

  async wait(handle: ExecutionHandle, timeoutMs = 30_000): Promise<ExecutionStatus> {
    const record = await this.recordFor(handle, false);
    if (!record.outputComplete && (!record.state || record.state.state === "running") && record.statusObservation?.state !== "unknown") {
      // Keep the one read-only query owned even after this caller stops waiting.
      void this.status(handle).catch(() => undefined);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        record.completion,
        new Promise<ExecutionStatus>((resolve) => {
          timer = setTimeout(() => {
            const observed = record.state ?? record.statusObservation;
            const state = record.statusQuery && observed?.state === "running"
              ? { state: "unknown" as const, exitCode: null }
              : observed ?? { state: "unknown" as const, exitCode: null };
            resolve(this.observation(record, state));
          }, Math.max(1, timeoutMs));
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancel(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const record = await this.recordFor(handle);
    if (record.state && record.state.state !== "running") return this.observation(record, record.state);
    if (record.statusObservation?.state === "unknown") return this.observation(record, record.statusObservation);
    if (record.cancelAttempted) return this.status(handle);
    record.cancelAttempted = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      const reply = await Promise.race([
        this.binding.lfs.workspace.cancel(this.workspace.workspace, { exec: handle.execId, detail: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("LayerFS cancellation reply timed out")), CANCEL_OBSERVE_MS);
          timer.unref?.();
        }),
      ]) as Record<string, unknown>;
      if (reply.unknown === true || reply.outcome === "unknown") {
        record.state = { state: "unknown", exitCode: null };
        return this.observation(record, record.state);
      }
      const commands = Array.isArray(reply.commands)
        ? reply.commands.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];
      const exact = commands.find((item) => item.exec === handle.execId);
      if (exact?.outcome === "cancelled") {
        if (record.state?.state !== "unknown") record.state = { state: "cancelled", exitCode: record.state?.exitCode ?? null };
        return this.observation(record, record.state);
      }
      if (exact?.outcome === "unknown") {
        record.state = { state: "unknown", exitCode: null };
        return this.observation(record, record.state);
      }
      const settled = await this.wait(handle, CANCEL_OBSERVE_MS);
      if (settled.state !== "running" && settled.state !== "unknown") return settled;
      record.state = { state: "unknown", exitCode: null };
      return this.observation(record, record.state);
    } catch {
      record.state = { state: "unknown", exitCode: null };
      return this.observation(record, record.state);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function publishCapability(events: { emit(name: string, value: unknown): void }, capability: LayerFSExecutionProvider): void {
  events.emit(EXECUTION_CAPABILITY_EVENT, capability);
}

export function statusLabel(status: ExecutionStatus): ExecutionState {
  return status.state;
}
