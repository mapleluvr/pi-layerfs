import assert from "node:assert/strict";
import test from "node:test";
import { LayerFSExecutionProvider } from "../src/execution.ts";
import type { WorkspaceBinding } from "../src/lifecycle.ts";
import type { WorkspaceIdentity } from "../src/protocol.ts";

const identity: WorkspaceIdentity = Object.freeze({
  providerId: "pi-layerfs", sandbox: "synthetic-waits", workspace: "synthetic-waits:one",
  project: "lab/synthetic-waits", machine: "native", image: "sha256:fixture",
  sandboxCreatedAt: "2026-01-01T00:00:00Z", workspaceId: "waits-workspace-id",
  path: "/synthetic/waits", branch: "one", mountedAt: "2026-01-01T00:00:01Z", generation: 1,
});

function fixture() {
  let finish!: (result: Record<string, unknown>) => void;
  let release!: (result: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  let stdout!: (data: string) => void;
  let reads = 0;
  let starts = 0;
  let cancels = 0;
  let released = false;
  const query = new Promise<Record<string, unknown>>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise; });
  const live = () => ({
    sandbox: identity.sandbox, project: identity.project, machine: identity.machine,
    image: identity.image, created_at: identity.sandboxCreatedAt, state: "ready",
    workspaces: [{ workspace: identity.workspace, id: identity.workspaceId, path: identity.path,
      branch: identity.branch, mounted_at: identity.mountedAt, state: "ready", running: [] }],
  });
  // A public-shaped pure fake binding. No SDK client, native call or process.
  const lfs = {
    sandbox: { get() { reads++; return reads === 1 || released ? Promise.resolve(live()) : query; } },
    workspace: {
      exec(_workspace: string, _command: string, options: { stdout(data: string): void; on_progress(value: unknown): void }) {
        starts++;
        stdout = options.stdout;
        options.on_progress({ phase: "start", exec: "exec-waits" });
        return new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
      },
      async cancel() { cancels++; throw new Error("waiting must not cancel"); },
    },
  };
  const provider = new LayerFSExecutionProvider({ lfs, identity } as unknown as WorkspaceBinding);
  return {
    provider,
    finish() { stdout("original buffered output\n"); finish({ exec: "exec-waits", exit_code: 0 }); },
    release(stale = false) { released = true; release(stale ? { ...live(), workspaces: [] } : live()); },
    reject() { released = true; reject(new Error("late observation unavailable")); },
    counts() { return { reads, starts, cancels }; },
  };
}

async function observeBy<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ returned: true as const, value })),
      new Promise<{ returned: false }>((resolve) => { timer = setTimeout(() => resolve({ returned: false }), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

test("LayerFSExecutionProvider.wait returns within its budget while original execution and status are pending", async () => {
  const f = fixture();
  const handle = await f.provider.start({ command: "synthetic only", cwd: "." });
  const waiting = f.provider.wait(handle, 20);
  const observed = await observeBy(waiting, 150);
  f.finish();
  f.release();
  await waiting;
  assert.equal(observed.returned, true, "a status RPC must not extend the 20ms caller wait budget");
  if (observed.returned) assert.deepEqual(observed.value, { state: "unknown", exitCode: null, outputComplete: false });
  assert.equal(f.counts().starts, 1);
  assert.equal(f.counts().cancels, 0);
});

test("LayerFSExecutionProvider.wait reuses an in-flight observation without polling around a stalled reply", async () => {
  const f = fixture();
  const handle = await f.provider.start({ command: "synthetic only", cwd: "." });
  const waits = [f.provider.wait(handle, 10), f.provider.wait(handle, 15), f.provider.wait(handle, 20)];
  const observed = await observeBy(Promise.all(waits), 150);
  const counts = f.counts();
  f.finish();
  f.release();
  await Promise.all(waits);
  assert.equal(observed.returned, true);
  assert.equal(counts.reads, 2, "one start verification and one shared pending read-only observation");
  assert.equal(counts.starts, 1);
  assert.equal(counts.cancels, 0);
});

test("LayerFSExecutionProvider original completion wins over a stalled status and late stale/rejected observations", async () => {
  for (const late of ["stale", "rejected"] as const) {
    const f = fixture();
    const handle = await f.provider.start({ command: "synthetic only", cwd: "." });
    const waiting = f.provider.wait(handle, 10);
    await new Promise((resolve) => setTimeout(resolve, 15));
    f.finish();
    const completed = await observeBy(f.provider.wait(handle, 1000), 150);
    if (late === "stale") f.release(true);
    else f.reject();
    await waiting;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed.returned, true);
    if (completed.returned) assert.deepEqual(completed.value, { state: "succeeded", exitCode: 0, outputComplete: true });
    assert.deepEqual(await f.provider.status(handle), { state: "succeeded", exitCode: 0, outputComplete: true },
      "a late read-only failure/stale identity cannot overwrite the captured original result");
    assert.equal(f.counts().starts, 1);
    assert.equal(f.counts().cancels, 0);
  }
});
