import assert from "node:assert/strict";
import test from "node:test";
import { parseLayerFSConfig } from "../src/config.ts";

const base: NodeJS.ProcessEnv = {
  LAYERFS_HOME: "/lab/layerfs",
  PI_LAYERFS_PROJECT: "lab/synthetic",
  PI_LAYERFS_SANDBOX: "synthetic",
  PI_LAYERFS_BRANCH: "agent",
  PI_LAYERFS_WORKSPACE: "agent",
};

test("LayerFS configuration requires an explicit home, project, and Sandbox", () => {
  assert.deepEqual(parseLayerFSConfig(base), {
    home: "/lab/layerfs",
    project: "lab/synthetic",
    sandbox: "synthetic",
    branch: "agent",
    workspace: "agent",
    createSandbox: false,
  });
  assert.throws(() => parseLayerFSConfig({ ...base, PI_LAYERFS_PROJECT: "../private" }), /simple LayerFS identifier/);
  assert.throws(() => parseLayerFSConfig({ ...base, PI_LAYERFS_SANDBOX: undefined }), /PI_LAYERFS_SANDBOX is required/);
});

test("Sandbox creation is opt-in and requires exact machine and image values", () => {
  assert.throws(() => parseLayerFSConfig({ ...base, PI_LAYERFS_CREATE_SANDBOX: "1" }), /PI_LAYERFS_MACHINE is required/);
  assert.deepEqual(parseLayerFSConfig({
    ...base,
    PI_LAYERFS_CREATE_SANDBOX: "1",
    PI_LAYERFS_MACHINE: "native",
    PI_LAYERFS_IMAGE: "sha256:" + "a".repeat(64),
  }).createSandbox, true);
});
