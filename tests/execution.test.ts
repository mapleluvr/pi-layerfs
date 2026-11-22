import assert from "node:assert/strict";
import test from "node:test";
import { LayerFSError } from "@layerfs/node";
import { LayerFSExecutionProvider } from "../src/execution.ts";
import type { WorkspaceIdentity } from "../src/protocol.ts";
import type { WorkspaceBinding } from "../src/lifecycle.ts";

const identity: WorkspaceIdentity = {
  providerId: "pi-layerfs",
  sandbox: "synthetic",
  workspace: "synthetic:agent",
  project: "lab/synthetic",
  machine: "native",
  image: "sha256:fixture",
  sandboxCreatedAt: "2026-01-01T00:00:00Z",
  workspaceId: "workspace-id",
  path: "/lab/workspaces/1",
  branch: "agent",
  mountedAt: "2026-01-01T00:00:01Z",
  generation: 1,
};

function setup() {
  const state: {
    running: boolean;
    finish: (result: Record<string, unknown>) => void;
    reject: (error: unknown) => void;
    unknownStarts: number;
  } = {
    running: true,
    finish: () => undefined,
    reject: () => undefined,
    unknownStarts: 0,
  };
  const calls: Array<[string, string, unknown]> = [];
  const execInputs: Array<{ command: string; options: Record<string, unknown> }> = [];
  const live = () => ({
    sandbox: identity.sandbox,
    project: identity.project,
    machine: identity.machine,
    image: identity.image,
    created_at: identity.sandboxCreatedAt,
    state: "ready",
    workspaces: [{
      workspace: identity.workspace,
      id: identity.workspaceId,
      path: identity.path,
      branch: identity.branch,
      mounted_at: identity.mountedAt,
      state: "ready",
      running: state.running ? [{ id: "exec-1" }] : [],
    }],
  });
  const lfs = {
    sandbox: { get: async () => live() },
    workspace: {
      exec: (_workspace: string, command: string, options: Record<string, any>) => {
        execInputs.push({ command, options });
        if (command === "unknown-before-handle") {
          state.unknownStarts++;
          return Promise.reject(new LayerFSError("Unknown", "execution reply was lost"));
        }
        options.on_progress({ phase: "start", done: 0, total: 1, exec: "exec-1" });
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          state.finish = resolve;
          state.reject = reject;
        });
      },
      cancel: async (workspace: string, options: unknown) => {
        calls.push(["cancel", workspace, options]);
        state.running = false;
        state.finish({ exec: "exec-1", exit_code: 128, cancelled: true });
        return { outcome: "cancelled", commands: [{ exec: "exec-1", outcome: "cancelled", signal: "SIGTERM" }] };
      },
    },
  };
  const binding = { lfs, identity } as unknown as WorkspaceBinding;
  const provider = new LayerFSExecutionProvider(binding);
  return { provider, state, calls, execInputs };
}

test("LayerFSExecutionProvider.start omits SDK cwd for root and preserves a Workspace-relative subdirectory", async () => {
  for (const cwd of [".", "", "nested"]) {
    const { provider, state, execInputs } = setup();
    const handle = await provider.start({ command: "printf fixture", cwd });
    assert.equal(execInputs.length, 1);
    if (cwd === "nested") assert.equal(execInputs[0].options.cwd, cwd);
    else assert.equal(Object.hasOwn(execInputs[0].options, "cwd"), false, "the public SDK rejects an explicit root '.'");
    state.finish({ exec: handle.execId, exit_code: 0 });
    assert.equal((await provider.wait(handle)).state, "succeeded");
  }
});

test("LayerFSExecutionProvider advertises on-completion output delivery additively", () => {
  const { provider } = setup();
  assert.equal(provider.outputDelivery, "on-completion");
  assert.equal(provider.protocol.major, 1);
  assert.equal(provider.protocol.minor, 2);
});

test("start resolves from the first public progress exec id and status confirms it freshly", async () => {
  const { provider } = setup();
  const handle = await provider.start({ command: "sleep 10", cwd: "." });
  assert.equal(handle.execId, "exec-1");
  assert.equal((await provider.status(handle)).state, "running");
});

test("cancel addresses the exact Workspace and exec, then uses the authoritative cancellation receipt", async () => {
  const { provider, calls } = setup();
  const handle = await provider.start({ command: "sleep 10", cwd: "." });
  const status = await provider.cancel(handle);
  assert.deepEqual(calls, [["cancel", identity.workspace, { exec: "exec-1", detail: true }]]);
  assert.deepEqual(status, { state: "cancelled", exitCode: 128, outputComplete: true });
});

test("execution results preserve the SDK's exact exit status and cancellation flag", async () => {
  const { provider, state } = setup();
  const handle = await provider.start({ command: "sleep 10", cwd: "." });
  state.finish({ exec: "exec-1", exit_code: 128, cancelled: true });
  assert.deepEqual(await provider.wait(handle), { state: "cancelled", exitCode: 128, outputComplete: true });
});

test("a lost start reply remains unknown, warns against retry, and does not contaminate a concurrent execution", async () => {
  const { provider, state } = setup();
  const uncertain = provider.start({ command: "unknown-before-handle", cwd: "." });
  const accepted = provider.start({ command: "sleep 10", cwd: "." });
  const [uncertainResult, acceptedResult] = await Promise.allSettled([uncertain, accepted]);
  assert.equal(state.unknownStarts, 1);
  assert.equal(uncertainResult.status, "rejected");
  if (uncertainResult.status === "rejected") assert.match(uncertainResult.reason.message, /unknown; do not retry/);
  assert.equal(acceptedResult.status, "fulfilled");
  if (acceptedResult.status === "fulfilled") {
    state.finish({ exec: "exec-1", exit_code: 0 });
    assert.deepEqual(await provider.wait(acceptedResult.value), { state: "succeeded", exitCode: 0, outputComplete: true });
  }
});

test("a lost execution result remains unknown rather than being replayed or called failed", async () => {
  const { provider, state } = setup();
  const handle = await provider.start({ command: "touch marker", cwd: "." });
  const lost = Object.assign(new Error("worker reply lost"), { name: "LayerFSError", code: "Unknown" });
  state.reject(lost);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await provider.status(handle), { state: "unknown", exitCode: null, outputComplete: true });
});

test("LayerFSExecutionProvider.wait does not confuse cancel confirmation with original exec/output completion", async () => {
  let finish!: (value: Record<string, unknown>) => void;
  let options!: Record<string, any>;
  let cancels = 0;
  const lfs = {
    sandbox: { get: async () => ({
      sandbox: identity.sandbox, project: identity.project, machine: identity.machine,
      image: identity.image, created_at: identity.sandboxCreatedAt, state: "ready",
      workspaces: [{ workspace: identity.workspace, id: identity.workspaceId, path: identity.path,
        branch: identity.branch, mounted_at: identity.mountedAt, state: "ready", running: [] }],
    }) },
    workspace: {
      exec(_workspace: string, _command: string, input: Record<string, any>) {
        options = input;
        input.on_progress({ phase: "start", exec: "exec-delayed" });
        return new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
      },
      async cancel(_workspace: string, input: any) {
        assert.equal(input.exec, "exec-delayed");
        cancels++;
        return { commands: [{ exec: "exec-delayed", outcome: "cancelled" }] };
      },
    },
  };
  const provider = new LayerFSExecutionProvider({ lfs, identity } as unknown as WorkspaceBinding);
  const output: Buffer[] = [];
  const handle = await provider.start({ command: "synthetic", cwd: ".", onData: (data) => output.push(data) });
  const cancelled = await provider.cancel(handle);
  assert.equal(cancelled.state, "cancelled");
  let waited = false;
  const wait = provider.wait(handle, 1000).then((result) => { waited = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waited, false, "cancel receipt must not settle the original output wait");
  options.stdout("delayed stdout\n");
  options.stderr("delayed stderr\n");
  finish({ exec: handle.execId, exit_code: 143, cancelled: true });
  assert.equal((await wait).state, "cancelled");
  assert.equal(Buffer.concat(output).toString(), "delayed stdout\ndelayed stderr\n");
  assert.equal(cancels, 1);
});

test("LayerFSExecutionProvider uncertain status and wait timeout preserve original output without cancellation replay", async () => {
  const setupValue = setup();
  const { provider, state, execInputs, calls } = setupValue;
  // This is the public mock binding used by setup, not an SDK/native client.
  const chunks: Buffer[] = [];
  const handle = await provider.start({ command: "synthetic delayed result", cwd: ".", onData: (data) => chunks.push(data) });
  state.running = false;
  const timer = setTimeout(() => {
    const stdout = execInputs[0].options.stdout as (data: string) => void;
    stdout("original output after uncertain status\n");
    state.finish({ exec: handle.execId, exit_code: 0 });
  }, 20);
  try {
    const timeout = await provider.wait(handle, 1);
    assert.equal(timeout.state, "unknown", "disappearance alone is not success/cancellation");
    assert.equal(timeout.outputComplete, false);
    assert.equal((await provider.cancel(handle)).state, "unknown");
    const result = await provider.wait(handle, 1000);
    assert.equal(result.state, "succeeded", "an exact original receipt resolves read-only uncertainty");
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputComplete, true);
    assert.equal(Buffer.concat(chunks).toString(), "original output after uncertain status\n");
    assert.equal(calls.length, 0, "unknown must not be automatically cancelled or replayed");
  } finally { clearTimeout(timer); }
});
