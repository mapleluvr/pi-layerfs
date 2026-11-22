import type { EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { mkdir, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_SYMLINKS = 40;

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function fdPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

async function verifyDescriptor(root: string, handle: FileHandle): Promise<void> {
  const actual = await realpath(fdPath(handle));
  if (!contained(root, actual) || actual.endsWith(" (deleted)")) {
    throw new Error("Path resolves outside the active LayerFS Workspace or its pinned entry was removed");
  }
}

// Linux proc-fd paths pin every directory; O_NOFOLLOW prevents check/use symlink
// substitution. Concurrent directory renames/mount changes and hard-link aliases
// are not an atomic confinement guarantee (see architecture.md).
async function walk(root: string, path: string, createDirectories: boolean, fileFlags?: number): Promise<FileHandle | undefined> {
  if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error("LayerFS filesystem confinement requires Linux /proc/self/fd and O_NOFOLLOW; refusing filesystem operation");
  }
  const partsFor = (candidate: string): string[] => {
    const absolute = resolve(root, candidate);
    if (!contained(root, absolute)) throw new Error("Path escapes the active LayerFS Workspace");
    return relative(root, absolute).split(sep).filter(Boolean);
  };
  let parts = partsFor(path);
  const directories: FileHandle[] = [];
  let result: FileHandle | undefined;
  try {
    const base = await open(root, DIRECTORY_FLAGS);
    directories.push(base);
    // A noncanonical/unavailable root or proc-fd interface must fail before mutation.
    if (await realpath(fdPath(base)) !== root) throw new Error("Workspace root resolves outside its declared LayerFS path");
    const ancestors = [base];
    let current = base;
    let links = 0;
    while (parts.length > 0 || fileFlags !== undefined) {
      const name = parts[0] ?? ".";
      if (name === "." && parts.length > 1) { parts.shift(); continue; }
      if (name === "..") {
        if (ancestors.length === 1) throw new Error("Path resolves outside the active LayerFS Workspace");
        ancestors.pop();
        current = ancestors[ancestors.length - 1];
        parts.shift();
        continue;
      }
      const leaf = fileFlags !== undefined && parts.length <= 1;
      const child = `${fdPath(current)}/${name}`;
      let entry: FileHandle;
      try {
        if (leaf && (fileFlags & constants.O_CREAT)) await verifyDescriptor(root, current);
        try {
          entry = await open(child, leaf ? fileFlags | constants.O_NOFOLLOW : DIRECTORY_FLAGS);
        } catch (error) {
          if (leaf || !createDirectories || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await verifyDescriptor(root, current);
          try { await mkdir(child); }
          catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
          entry = await open(child, DIRECTORY_FLAGS);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ELOOP" && code !== "ENOTDIR") throw error;
        let target: string;
        try { target = await readlink(child); }
        catch { throw error; } // Changed/non-link entries fail closed, never a permissive fallback.
        if (++links > MAX_SYMLINKS) {
          throw Object.assign(new Error("ELOOP: too many symbolic links in LayerFS Workspace path"), { code: "ELOOP" });
        }
        let targetParts: string[];
        if (isAbsolute(target)) {
          if (target !== root && !target.startsWith(`${root}${sep}`)) {
            throw new Error("Path resolves outside the active LayerFS Workspace");
          }
          targetParts = target.slice(root.length).split(sep).filter(Boolean);
          ancestors.splice(1);
          current = base;
        } else {
          targetParts = target.split(sep).filter(Boolean);
        }
        // Preserve '..' until after preceding symlinks have been resolved.
        parts = [...targetParts, ...parts.slice(1)];
        continue;
      }
      if (leaf) {
        result = entry;
        await verifyDescriptor(root, entry);
        return entry;
      }
      directories.push(entry);
      ancestors.push(entry);
      current = entry;
      parts.shift();
    }
    await verifyDescriptor(root, current);
    return undefined;
  } catch (error) {
    await result?.close();
    throw error;
  } finally {
    await Promise.all(directories.map((directory) => directory.close()));
  }
}

export function createWorkspaceFilesystem(path: string): ReadOperations & EditOperations & WriteOperations {
  const root = resolve(path);
  const file = async (candidate: string, flags: number): Promise<FileHandle> => {
    const handle = await walk(root, candidate, false, flags);
    if (!handle) throw new Error("LayerFS filesystem did not acquire a file descriptor");
    return handle;
  };
  return {
    async *createReadStream(candidate, options) {
      const handle = await file(candidate, constants.O_RDONLY);
      try {
        const stream = handle.createReadStream({ autoClose: false, signal: options.signal });
        for await (const chunk of stream) yield chunk;
      } finally { await handle.close(); }
    },
    async readFile(candidate) {
      const handle = await file(candidate, constants.O_RDONLY);
      try { return await handle.readFile(); }
      finally { await handle.close(); }
    },
    async access(candidate) {
      const handle = await file(candidate, constants.O_RDONLY);
      await handle.close();
    },
    async writeFile(candidate, content) {
      // Do not truncate on open: validate the pinned leaf before modifying its bytes.
      const handle = await file(candidate, constants.O_WRONLY | constants.O_CREAT);
      try {
        await handle.truncate(0);
        await handle.writeFile(content, "utf8");
      } finally { await handle.close(); }
    },
    async mkdir(candidate) { await walk(root, candidate, true); },
  };
}
