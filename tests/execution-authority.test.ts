import assert from "node:assert/strict";
import test from "node:test";
import { LayerFSExecutionProvider } from "../src/execution.ts";
import type { WorkspaceBinding } from "../src/lifecycle.ts";
import type { ExecutionStatus, WorkspaceIdentity } from "../src/protocol.ts";

const identity: WorkspaceIdentity = Object.freeze({
  providerId: "pi-layerfs", sandbox: "synthetic-authority", workspace: "synthetic-authority:one",
  project: "lab/synthetic", machine: "native", image: "sha256:fixture",
  sandboxCreatedAt: "2026-01-01T00:00:00Z", workspaceId: "authority-workspace-id",
  path: "/synthetic/authority", branch: "one", mountedAt: "2026-01-01T00:00:01Z", generation: 1,
});

function fixture(cancelOutcome: "cancelled" | "unknown" = "cancelled") {
  let finish!: (result: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  let release!: (live: Record<string, unknown>) => void;
  let options!: { stdout(data: string): void; stderr(data: string): void; on_progress(value: unknown): void };
  let reads = 0;
  let starts = 0;
  let cancels = 0;
  let released = false;
  const live = (running = false) => ({
    sandbox: identity.sandbox, project: identity.project, machine: identity.machine,
    image: identity.image, created_at: identity.sandboxCreatedAt, state: "ready",
    workspaces: [{ workspace: identity.workspace, id: identity.workspaceId, path: identity.path,
      branch: identity.branch, mounted_at: identity.mountedAt, state: "ready", running: running ? ["exec-authority"] : [] }],
  });
  let current: Record<string, unknown> = live();
  const query = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
  const original = new Promise<Record<string, unknown>>((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
  // Public-shaped fakes only: no SDK client, native call or process executor.
  const lfs = {
    sandbox: { get() { reads++; return reads === 1 || released ? Promise.resolve(current) : query; } },
    workspace: {
      exec(_workspace: string, _command: string, input: typeof options) {
        starts++; options = input; input.on_progress({ phase: "start", exec: "exec-authority" }); return original;
      },
      async cancel(_workspace: string, input: { exec: string }) {
        assert.equal(input.exec, "exec-authority"); cancels++;
        return { commands: [{ exec: input.exec, outcome: cancelOutcome }] };
      },
    },
  };
  return {
    provider: new LayerFSExecutionProvider({ lfs, identity } as unknown as WorkspaceBinding),
    release(kind: "empty" | "running" | "workspace-mismatch" | "sandbox-mismatch" = "empty") {
      current = live(kind === "running");
      if (kind === "workspace-mismatch") current = { ...current, workspaces: [{ ...live().workspaces[0], branch: "replacement" }] };
      if (kind === "sandbox-mismatch") current = { ...current, project: "lab/replacement" };
      released = true; release(current);
    },
    finish(result: Record<string, unknown> = { exec: "exec-authority", exit_code: 0 }) {
      options.stdout("captured original stdout\n"); options.stderr("captured original stderr\n"); finish(result);
    },
    reject() { options.stdout("received before rejected original\n"); reject(new Error("original result unavailable")); },
    mismatchProgress() { options.on_progress({ phase: "start", exec: "exec-other" }); },
    counts() { return { starts, reads, cancels }; },
  };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("caller remained blocked")), 200);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test("LayerFSExecutionProvider exact original success is authoritative in both read-only observation orders", async () => {
  for (const order of ["query-before-original", "original-before-query"]) {
    const f = fixture();
    const output: Buffer[] = [];
    const handle = await f.provider.start({ command: "synthetic only", cwd: ".", onData: (data) => output.push(data) });
    const status = f.provider.status(handle);
    const waiting = f.provider.wait(handle, 1000);
    if (order === "query-before-original") {
      f.release();
      assert.deepEqual(await status, { state: "unknown", exitCode: null, outputComplete: false });
      assert.deepEqual(await within(f.provider.wait(handle, 10)), { state: "unknown", exitCode: null, outputComplete: false });
      assert.equal(f.counts().cancels, 0);
    }
    f.finish();
    assert.deepEqual(await within(waiting), { state: "succeeded", exitCode: 0, outputComplete: true });
    if (order === "original-before-query") f.release("workspace-mismatch");
    await status;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await f.provider.status(handle), { state: "succeeded", exitCode: 0, outputComplete: true });
    assert.equal(Buffer.concat(output).toString(), "captured original stdout\ncaptured original stderr\n");
    assert.deepEqual(f.counts(), { starts: 1, reads: 2, cancels: 0 });
  }
});

test("LayerFSExecutionProvider an empty running observation cannot hide a known nonzero original receipt", async () => {
  const f = fixture();
  const handle = await f.provider.start({ command: "synthetic only", cwd: "." });
  const status = f.provider.status(handle); f.release();
  assert.equal((await status).state, "unknown");
  f.finish({ exec: handle.execId, exit_code: 17 });
  assert.deepEqual(await f.provider.wait(handle), { state: "failed", exitCode: 17, outputComplete: true });
  assert.equal(f.counts().starts, 1);
  assert.equal(f.counts().cancels, 0);
});

test("LayerFSExecutionProvider original Unknown, absent exit receipt and rejection remain unknown after an unconfirmed query", async () => {
  for (const original of ["unknown", "missing-code", "rejected"]) {
    const f = fixture();
    const handle = await f.provider.start({ command: "synthetic only", cwd: "." });
    const status = f.provider.status(handle); f.release(); await status;
    if (original === "rejected") f.reject();
    else f.finish({ exec: handle.execId, ...(original === "unknown" ? { unknown: true, exit_code: 0 } : {}) });
    assert.deepEqual(await f.provider.wait(handle), { state: "unknown", exitCode: null, outputComplete: true });
    assert.deepEqual(f.counts(), { starts: 1, reads: 2, cancels: 0 });
  }
});

test("LayerFSExecutionProvider exec mismatch or stale full lookup binding cannot be cleared by later success", async () => {
  for (const mismatch of ["result", "progress", "workspace-mismatch", "sandbox-mismatch"] as const) {
    const f = fixture();
    const handle = await f.provider.start({ command: "synthetic only", cwd: "." });
    const status = f.provider.status(handle);
    f.release(mismatch === "workspace-mismatch" || mismatch === "sandbox-mismatch" ? mismatch : "empty");
    await status;
    if (mismatch === "progress") f.mismatchProgress();
    f.finish({ exec: mismatch === "result" ? "exec-other" : handle.execId, exit_code: 0 });
    assert.deepEqual(await f.provider.wait(handle), { state: "unknown", exitCode: null, outputComplete: true });
    assert.equal(f.counts().starts, 1);
    assert.equal(f.counts().cancels, 0);
  }
});

test("LayerFSExecutionProvider wrong generation or workspace handle cannot borrow a captured original success", async () => {
  const f = fixture();
  const handle = await f.provider.start({ command: "synthetic only", cwd: "." });
  f.finish();
  for (const workspace of [{ ...identity, generation: 2 }, { ...identity, workspaceId: "replacement-id" }]) {
    const status = await f.provider.wait({ execId: handle.execId, workspace });
    assert.equal(status.state, "unknown");
  }
  assert.deepEqual(await f.provider.wait(handle), { state: "succeeded", exitCode: 0, outputComplete: true });
  assert.equal(f.counts().cancels, 0);
});

test("LayerFSExecutionProvider confirmed exact cancellation remains output-pending until original buffered completion", async () => {
  const f = fixture();
  const output: Buffer[] = [];
  const handle = await f.provider.start({ command: "synthetic only", cwd: ".", onData: (data) => output.push(data) });
  const status = f.provider.status(handle); f.release("running"); await status;
  assert.deepEqual(await f.provider.cancel(handle), { state: "cancelled", exitCode: null, outputComplete: false });
  assert.deepEqual(await within(f.provider.wait(handle, 10)), { state: "cancelled", exitCode: null, outputComplete: false });
  assert.equal(output.length, 0);
  f.finish({ exec: handle.execId, exit_code: 143, cancelled: true });
  assert.deepEqual(await f.provider.wait(handle), { state: "cancelled", exitCode: 143, outputComplete: true });
  assert.match(Buffer.concat(output).toString(), /captured original stdout\ncaptured original stderr/);
  assert.equal(f.counts().cancels, 1);
});

test("LayerFSExecutionProvider an uncertain cancellation is not merely read-only qualification", async () => {
  const f = fixture("unknown");
  const handle = await f.provider.start({ command: "synthetic only", cwd: "." });
  const status = f.provider.status(handle); f.release("running"); await status;
  assert.equal((await f.provider.cancel(handle)).state, "unknown");
  f.finish();
  const result: ExecutionStatus = await f.provider.wait(handle);
  assert.deepEqual(result, { state: "unknown", exitCode: null, outputComplete: true });
  assert.equal(f.counts().cancels, 1);
});
