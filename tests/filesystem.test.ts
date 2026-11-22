import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createExtension } from "../index.ts";

// These definitions use only synthetic local files and a fake provider, never an SDK client.
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-layerfs-filesystem-"));
  const root = join(dir, "workspace");
  const outside = join(dir, "workspace-other");
  await mkdir(root);
  await mkdir(outside);
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getAllTools: () => [...tools.values()],
    on: () => () => undefined,
    events: { emit: () => undefined },
  };
  createExtension(pi as any, {
    env: { LAYERFS_HOME: join(dir, "unused-home"), PI_LAYERFS_PROJECT: "lab/synthetic", PI_LAYERFS_SANDBOX: "synthetic" },
    createProvider: async () => ({ workspace: { path: root }, assertCurrent: async () => undefined }) as any,
  });
  const call = (name: string, params: unknown) => tools.get(name).execute("filesystem-unit", params, undefined, undefined, { cwd: outside });
  return { dir, root, outside, call, close: () => rm(dir, { recursive: true, force: true }) };
}

test("filesystem write rejects absolute and relative dangling external links before target creation", async () => {
  for (const absolute of [true, false]) {
    const f = await fixture();
    try {
      const target = join(f.outside, "never-created.txt");
      await symlink(absolute ? target : relative(f.root, target), join(f.root, "link.txt"));
      await assert.rejects(f.call("write", { path: "link.txt", content: "must-not-escape\n" }), /escap|outside/i);
      await assert.rejects(lstat(target), { code: "ENOENT" });
      assert.equal((await lstat(join(f.root, "link.txt"))).isSymbolicLink(), true);
    } finally { await f.close(); }
  }
});

test("filesystem read/edit/write refuse existing external file links without truncation", async () => {
  const f = await fixture();
  try {
    const target = join(f.outside, "existing.txt");
    await writeFile(target, "preserved external content\n");
    await symlink(target, join(f.root, "link.txt"));
    for (const [name, params] of [
      ["read", { path: "link.txt" }],
      ["edit", { path: "link.txt", edits: [{ oldText: "preserved", newText: "bad" }] }],
      ["write", { path: "link.txt", content: "bad" }],
    ] as const) await assert.rejects(f.call(name, params), /escap|outside/i);
    assert.equal(await readFile(target, "utf8"), "preserved external content\n");
  } finally { await f.close(); }
});

test("filesystem rejects existing and dangling parent links before mkdir or file creation", async () => {
  for (const dangling of [false, true]) {
    const f = await fixture();
    try {
      const target = dangling ? join(f.outside, "missing-directory") : f.outside;
      await symlink(relative(f.root, target), join(f.root, "parent"));
      await assert.rejects(f.call("write", { path: "parent/nested/file.txt", content: "bad" }), /escap|outside/i);
      await assert.rejects(lstat(join(target, "nested")), { code: "ENOENT" });
      if (dangling) await assert.rejects(lstat(target), { code: "ENOENT" });
    } finally { await f.close(); }
  }
});

test("filesystem preserves contained absolute/relative file and parent symlinks", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "nested"));
    const target = join(f.root, "nested/target.txt");
    await writeFile(target, "alpha\nbeta\ngamma\n");
    await symlink(target, join(f.root, "absolute.txt"));
    await symlink("nested/target.txt", join(f.root, "relative.txt"));
    await symlink("nested", join(f.root, "parent"));
    const read = await f.call("read", { path: "absolute.txt", offset: 2, limit: 1 });
    assert.match(read.content[0].text, /beta/);
    assert.doesNotMatch(read.content[0].text, /alpha/);
    await f.call("edit", { path: "relative.txt", edits: [{ oldText: "beta", newText: "changed" }] });
    assert.equal(await readFile(target, "utf8"), "alpha\nchanged\ngamma\n");
    await f.call("write", { path: "absolute.txt", content: "short\n" });
    assert.equal(await readFile(target, "utf8"), "short\n");
    await f.call("write", { path: "parent/new/deep.txt", content: "contained parent\n" });
    assert.equal(await readFile(join(f.root, "nested/new/deep.txt"), "utf8"), "contained parent\n");
    await symlink("nested/new-target.txt", join(f.root, "dangling-inside.txt"));
    await f.call("write", { path: "dangling-inside.txt", content: "contained dangling\n" });
    assert.equal(await readFile(join(f.root, "nested/new-target.txt"), "utf8"), "contained dangling\n");
  } finally { await f.close(); }
});

test("filesystem fails closed for symlink cycles, directory writes, and lexical sibling boundaries", async () => {
  const f = await fixture();
  try {
    await symlink("loop-b", join(f.root, "loop-a"));
    await symlink("loop-a", join(f.root, "loop-b"));
    await assert.rejects(f.call("write", { path: "loop-a", content: "bad" }), /ELOOP|symbolic links|symlink/i);
    await mkdir(join(f.root, "directory"));
    await writeFile(join(f.root, "directory/preserved.txt"), "safe");
    await assert.rejects(f.call("write", { path: "directory", content: "bad" }), /EISDIR|directory/i);
    assert.equal(await readFile(join(f.root, "directory/preserved.txt"), "utf8"), "safe");
    await assert.rejects(f.call("write", { path: join(f.outside, "file.txt"), content: "bad" }), /escap|outside/i);
    await assert.rejects(lstat(join(f.outside, "file.txt")), { code: "ENOENT" });
    await assert.rejects(f.call("read", { path: "missing.txt" }), /ENOENT|not found|does not exist/i);
    await writeFile(join(f.root, "edit.txt"), "unchanged");
    await assert.rejects(f.call("edit", { path: "edit.txt", edits: [{ oldText: "absent", newText: "bad" }] }), /could not find|not found|does not match/i);
    assert.equal(await readFile(join(f.root, "edit.txt"), "utf8"), "unchanged");
  } finally { await f.close(); }
});

test("filesystem resolves contained parent '..' after symlinks rather than collapsing it prematurely", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "nested/deep"), { recursive: true });
    await writeFile(join(f.root, "nested/target.txt"), "physical parent\n");
    await symlink("nested/deep", join(f.root, "via"));
    await symlink("via/../target.txt", join(f.root, "parent.txt"));
    assert.match((await f.call("read", { path: "parent.txt" })).content[0].text, /physical parent/);
    await f.call("write", { path: "parent.txt", content: "updated physical parent\n" });
    assert.equal(await readFile(join(f.root, "nested/target.txt"), "utf8"), "updated physical parent\n");
    await assert.rejects(lstat(join(f.root, "target.txt")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("filesystem concurrent leaf/parent symlink substitution never creates synthetic external markers", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "inside"));
    await writeFile(join(f.root, "inside/local.txt"), "initial\n");
    await symlink("inside", join(f.root, "parent"));
    await symlink("inside/local.txt", join(f.root, "leaf.txt"));
    const externalLeaf = join(f.outside, "leaf.txt");
    const externalParent = join(f.outside, "parent.txt");
    const substitute = async () => {
      for (let index = 0; index < 80; index++) {
        await symlink(index % 2 ? "inside" : f.outside, join(f.root, "next-parent"));
        await rename(join(f.root, "next-parent"), join(f.root, "parent"));
        await symlink(index % 2 ? "inside/local.txt" : externalLeaf, join(f.root, "next-leaf"));
        await rename(join(f.root, "next-leaf"), join(f.root, "leaf.txt"));
      }
    };
    const writes = async () => {
      for (let index = 0; index < 80; index++) for (const path of ["leaf.txt", "parent/parent.txt"]) {
        try { await f.call("write", { path, content: "synthetic race marker\n" }); }
        catch (error) { assert.match(String(error), /escap|outside|ELOOP|ENOTDIR|ENOENT/i); }
      }
    };
    await Promise.all([substitute(), writes()]);
    await assert.rejects(lstat(externalLeaf), { code: "ENOENT" });
    await assert.rejects(lstat(externalParent), { code: "ENOENT" });
    // A bounded stress observation, not proof against directory relocation/mount/hard-link races.
  } finally { await f.close(); }
});

test("filesystem contained streamed reads retain Pi's truncation and fail closed for a symlink root", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "large.txt"), "synthetic line\n".repeat(2500));
    await symlink("large.txt", join(f.root, "large-link.txt"));
    const read = await f.call("read", { path: "large-link.txt" });
    assert.equal(read.details.truncation.truncated, true);
    assert.equal(read.details.truncation.outputLines, 2000);
    await rename(f.root, join(f.dir, "original-workspace"));
    await symlink(join(f.dir, "original-workspace"), f.root);
    await assert.rejects(f.call("write", { path: "never-created.txt", content: "bad" }), /ENOTDIR|ELOOP|root/i);
    await assert.rejects(lstat(join(f.dir, "original-workspace/never-created.txt")), { code: "ENOENT" });
  } finally { await f.close(); }
});
