import { Type } from "typebox";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LayerFSConfig } from "./src/config.ts";
import { parseLayerFSConfig } from "./src/config.ts";
import { LayerFSExecutionProvider, publishCapability } from "./src/execution.ts";
import { LAYERFS_TOOL_MARKER } from "./src/protocol.ts";
import { createWorkspaceFilesystem } from "./src/filesystem.ts";

const statusSchema = Type.Object({}, { additionalProperties: false });
const bashSchema = Type.Object({ command: Type.String() }, { additionalProperties: false });

export interface ExtensionDependencies {
  env?: NodeJS.ProcessEnv;
  createProvider?: (config: LayerFSConfig, generation: number) => Promise<LayerFSExecutionProvider>;
}

function toolsFromProvider(provider: LayerFSExecutionProvider) {
  const root = provider.workspace.path;
  const filesystem = createWorkspaceFilesystem(root);
  return [
    createReadToolDefinition(root, { operations: filesystem }),
    createEditToolDefinition(root, { operations: filesystem }),
    createWriteToolDefinition(root, { operations: filesystem }),
  ];
}

export function createExtension(pi: ExtensionAPI, dependencies: ExtensionDependencies = {}): void {
  const env = dependencies.env ?? process.env;
  let config: LayerFSConfig | undefined;
  let provider: LayerFSExecutionProvider | undefined;
  let providerPromise: Promise<LayerFSExecutionProvider> | undefined;
  let generation = 0;
  let lifecycleGeneration = 0;
  let lifecycle = "unbound";
  let diagnostic: string | undefined;
  let standaloneBashRegistered = false;
  const createProvider = dependencies.createProvider ?? LayerFSExecutionProvider.create;

  function hasBashBackgroundOwner(): boolean {
    const tools = pi.getAllTools();
    const markers = new Set(["bg_run", "bg_status", "bg_logs", "bg_kill", "bg_join"]);
    return tools.filter((tool) => markers.has(tool.name)).length === markers.size;
  }

  function registerStandaloneBash(): void {
    if (standaloneBashRegistered) return;
    pi.registerTool({
      name: "bash",
      label: "bash",
      description: "Execute Bash commands in the active LayerFS Workspace. Output is delivered after command completion; the preview is limited to 50 KiB/2000 lines and capture to 1 MiB per stream.",
      promptSnippet: "Run Bash commands in the active LayerFS Workspace",
      parameters: bashSchema,
      async execute(_id: string, params: { command: string }, signal?: AbortSignal) {
        const current = await ensureProvider();
        const chunks: Buffer[] = [];
        const handle = await current.start({
          command: params.command,
          cwd: ".",
          signal,
          onData: (data) => chunks.push(Buffer.from(data)),
        });
        const result = await current.wait(handle, 24 * 60 * 60 * 1000);
        const truncation = truncateTail(Buffer.concat(chunks).toString("utf8"));
        const output = truncation.content + (truncation.truncated
          ? `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines, ${truncation.outputBytes} of ${truncation.totalBytes} captured bytes.]`
          : "");
        if (result.state === "unknown") throw new Error(`LayerFS execution outcome is unknown; the command was not retried${output ? `\n${output}` : ""}`);
        if (result.state === "failed") throw new Error(`${output ? `${output}\n` : ""}LayerFS command exited with code ${result.exitCode}`);
        if (result.state === "cancelled") throw new Error("LayerFS command was cancelled");
        return { content: [{ type: "text", text: output || `LayerFS command completed (exit ${result.exitCode})` }], details: { execId: handle.execId, exitCode: result.exitCode, truncation } };
      },
    } as any);
    standaloneBashRegistered = true;
  }

  async function ensureProvider(): Promise<LayerFSExecutionProvider> {
    if (provider) {
      try {
        await provider.assertCurrent();
        return provider;
      } catch (error) {
        lifecycle = "degraded";
        diagnostic = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    if (providerPromise) return providerPromise;
    if (!config) config = parseLayerFSConfig(env);
    generation += 1;
    const expectedGeneration = lifecycleGeneration;
    const currentGeneration = generation;
    lifecycle = "preparing";
    const pending = Promise.resolve().then(() => createProvider(config!, currentGeneration)).then((current) => {
      if (expectedGeneration !== lifecycleGeneration) throw new Error("LayerFS binding completed after the Pi session closed");
      provider = current;
      lifecycle = "ready";
      diagnostic = undefined;
      return current;
    }).catch((error: unknown) => {
      if (expectedGeneration === lifecycleGeneration) {
        lifecycle = "degraded";
        diagnostic = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }).finally(() => {
      if (providerPromise === pending) providerPromise = undefined;
    });
    providerPromise = pending;
    return pending;
  }

  pi.registerTool({
    name: LAYERFS_TOOL_MARKER,
    label: "LayerFS status",
    description: "Show the active LayerFS Workspace binding, lifecycle state, and output-delivery mode.",
    parameters: statusSchema,
    async execute() {
      try {
        const current = await ensureProvider();
        return { content: [{ type: "text", text: `LayerFS ready: ${current.workspace.workspace} (${current.workspace.branch}, generation ${current.workspace.generation}; output: ${current.outputDelivery})` }], details: { ...current.workspace, outputDelivery: current.outputDelivery } };
      } catch (error) {
        const message = diagnostic ?? (error instanceof Error ? error.message : String(error));
        return { content: [{ type: "text", text: `LayerFS ${lifecycle}: ${message}` }], details: { lifecycle, error: message }, isError: true };
      }
    },
  } as any);

  for (const name of ["read", "edit", "write"] as const) {
    const definition = {
      read: createReadToolDefinition(process.cwd()),
      edit: createEditToolDefinition(process.cwd()),
      write: createWriteToolDefinition(process.cwd()),
    }[name];
    pi.registerTool({
      ...definition,
      async execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
        const current = await ensureProvider();
        const actual = toolsFromProvider(current).find((tool) => tool.name === name)!;
        const scopedContext = { ...(ctx && typeof ctx === "object" ? ctx : {}), cwd: current.workspace.path };
        return (actual.execute as any)(id, params, signal, onUpdate, scopedContext);
      },
    } as any);
  }

  pi.on("session_start", async () => {
    let current: LayerFSExecutionProvider | undefined;
    try {
      current = await ensureProvider();
    } catch {
      // The marker remains registered so compatible consumers fail closed.
    }
    try {
      if (!hasBashBackgroundOwner()) registerStandaloneBash();
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    if (current) publishCapability(pi.events, current);
  });
  pi.on("session_shutdown", async () => {
    lifecycle = "closing";
    lifecycleGeneration += 1;
    const current = provider;
    provider = undefined;
    providerPromise = undefined;
    await current?.shutdown();
    lifecycle = "closed";
  });
}

export default function (pi: ExtensionAPI): void {
  createExtension(pi);
}
