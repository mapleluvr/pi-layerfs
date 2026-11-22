import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../index.ts";
import type { WorkspaceIdentity } from "../src/protocol.ts";

class FakePi {
  readonly tools = new Map<string, Record<string, any>>();
  readonly handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  readonly events = {
    emit: (_name: string, _value: unknown) => undefined,
    on: (_name: string, _listener: (value: unknown) => void) => () => undefined,
  };
  registerTool(tool: Record<string, any>) { this.tools.set(tool.name, tool); }
  getAllTools() { return [...this.tools.values()]; }
  on(event: string, handler: (...args: any[]) => unknown) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => undefined;
  }
  async startSession() {
    for (const handler of this.handlers.get("session_start") ?? []) await handler({}, {});
  }
}

function identity(root: string): WorkspaceIdentity {
  return {
    providerId: "pi-layerfs",
    sandbox: "synthetic",
    workspace: "synthetic:agent",
    project: "lab/synthetic",
    machine: "native",
    image: "sha256:fixture",
    sandboxCreatedAt: "2026-01-01T00:00:00Z",
    workspaceId: "workspace-id",
    path: root,
    branch: "agent",
    mountedAt: "2026-01-01T00:00:01Z",
    generation: 1,
  };
}

test("standalone LayerFS bash truncates model-facing on-completion output", async () => {
  const workspace = identity("/tmp/pi-layerfs-bounded-fixture");
  const pi = new FakePi();
  const provider = {
    workspace,
    outputDelivery: "on-completion",
    assertCurrent: async () => undefined,
    async start(input: { onData?: (data: Buffer) => void }) {
      input.onData?.(Buffer.from("bounded-fixture\n".repeat(5000)));
      return { execId: "exec-bounded", workspace };
    },
    async wait() { return { state: "succeeded", exitCode: 0 }; },
    async shutdown() {},
  };
  createExtension(pi as any, {
    env: { LAYERFS_HOME: "/tmp/fixture-home", PI_LAYERFS_PROJECT: "lab/synthetic", PI_LAYERFS_SANDBOX: "synthetic" },
    createProvider: async () => provider as any,
  });
  await pi.startSession();
  const result = await pi.tools.get("bash")!.execute("bounded", { command: "synthetic output" });
  assert.ok(Buffer.byteLength(result.content[0].text) < 52_000);
  assert.match(result.content[0].text, /Output truncated/);
  assert.equal(result.details.truncation.truncated, true);
});

test("LayerFS file tools share the live workspace, preserve built-in edit behavior, and reject escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-layerfs-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-layerfs-outside-"));
  try {
    await writeFile(join(root, "fixture.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(join(outside, "secret.txt"), "host-only\n");
    await symlink(outside, join(root, "outside-link"), "dir");
    const workspace = identity(root);
    const starts: Array<{ command: string; cwd: string }> = [];
    let shutdownCalls = 0;
    const provider = {
      workspace,
      assertCurrent: async () => undefined,
      async shutdown() { shutdownCalls++; },
      async start(input: { command: string; cwd: string; onData?: (data: Buffer) => void }) {
        starts.push({ command: input.command, cwd: input.cwd });
        input.onData?.(Buffer.from("synthetic command output\n"));
        return { execId: "exec-1", workspace };
      },
      async wait() { return { state: "succeeded", exitCode: 0 }; },
      async status() { return { state: "unknown", exitCode: null }; },
      async cancel() { return { state: "unknown", exitCode: null }; },
    };
    const pi = new FakePi();
    let createCount = 0;
    let resolveProvider!: (value: unknown) => void;
    const providerCreation = new Promise<unknown>((resolve) => { resolveProvider = resolve; });
    createExtension(pi as any, {
      env: {
        LAYERFS_HOME: "/tmp/fixture-home",
        PI_LAYERFS_PROJECT: "lab/synthetic",
        PI_LAYERFS_SANDBOX: "synthetic",
      },
      createProvider: async () => {
        createCount++;
        return providerCreation as any;
      },
    });
    const read = pi.tools.get("read")!;
    const edit = pi.tools.get("edit")!;
    const write = pi.tools.get("write")!;
    const context = { cwd: outside };
    const sessionStart = pi.startSession();
    const initialRead = read.execute("read-1", { path: "fixture.txt", offset: 2, limit: 1 }, undefined, undefined, context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(createCount, 1);
    resolveProvider(provider);
    const [, initial] = await Promise.all([sessionStart, initialRead]);
    assert.match(initial.content[0].text, /beta/);
    assert.doesNotMatch(initial.content[0].text, /alpha/);

    await edit.execute("edit-1", { path: "fixture.txt", edits: [{ oldText: "beta", newText: "changed" }] }, undefined, undefined, context);
    await write.execute("write-1", { path: "nested/new.txt", content: "overlay write\n" }, undefined, undefined, context);
    assert.equal(await readFile(join(root, "fixture.txt"), "utf8"), "alpha\nchanged\ngamma\n");
    assert.equal(await readFile(join(root, "nested/new.txt"), "utf8"), "overlay write\n");
    await assert.rejects(read.execute("read-escape", { path: "outside-link/secret.txt" }, undefined, undefined, context), /outside the active LayerFS Workspace/);
    await assert.rejects(write.execute("write-escape", { path: "../host-marker.txt", content: "forbidden" }, undefined, undefined, context), /escapes the active LayerFS Workspace/);

    const bashResult = await pi.tools.get("bash")!.execute("bash-1", { command: "printf fixture" }, undefined, undefined, context);
    assert.equal(bashResult.content[0].text, "synthetic command output\n");
    assert.deepEqual(starts, [{ command: "printf fixture", cwd: "." }]);
    for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({}, {});
    assert.equal(shutdownCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
