import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_PROTOCOL_ID,
  EXECUTION_PROTOCOL_MAJOR,
  isLayerFSExecutionCapability,
  type WorkspaceIdentity,
} from "../src/protocol.ts";

const workspace: WorkspaceIdentity = {
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

function capability(overrides: Record<string, unknown> = {}) {
  return {
    protocol: { id: EXECUTION_PROTOCOL_ID, major: EXECUTION_PROTOCOL_MAJOR, minor: 0 },
    providerId: "pi-layerfs",
    workspace,
    start: async () => ({ execId: "exec-1", workspace }),
    status: async () => ({ state: "running", exitCode: null }),
    wait: async () => ({ state: "running", exitCode: null }),
    cancel: async () => ({ state: "unknown", exitCode: null }),
    ...overrides,
  };
}

test("protocol accepts the optional outputDelivery field without excluding older minor announcements", () => {
  assert.equal(isLayerFSExecutionCapability(capability()), true);
  assert.equal(isLayerFSExecutionCapability(capability({ outputDelivery: "on-completion", protocol: { id: EXECUTION_PROTOCOL_ID, major: 1, minor: 1 } })), true);
  assert.equal(isLayerFSExecutionCapability(capability({ protocol: { id: EXECUTION_PROTOCOL_ID, major: 1, minor: 2 }, status: async () => ({ state: "cancelled", exitCode: null, outputComplete: false }) })), true);
});

test("only a complete execution capability for the supported major is accepted", () => {
  assert.equal(isLayerFSExecutionCapability(capability()), true);
  assert.equal(isLayerFSExecutionCapability(capability({ protocol: { id: EXECUTION_PROTOCOL_ID, major: 2, minor: 0 } })), false);
  assert.equal(isLayerFSExecutionCapability(capability({ cancel: undefined })), false);
  assert.equal(isLayerFSExecutionCapability(capability({ workspace: { ...workspace, generation: 0 } })), false);
});
