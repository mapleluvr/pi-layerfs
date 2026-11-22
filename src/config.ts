export interface LayerFSConfig {
  home: string;
  project: string;
  sandbox: string;
  branch: string;
  workspace: string;
  createSandbox: boolean;
  machine?: string;
  image?: string;
}

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (/[\0\r\n]/.test(normalized)) throw new Error(`${name} contains an invalid character`);
  return normalized;
}

function identifier(name: string, value: string | undefined): string {
  const normalized = required(name, value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(normalized)) {
    throw new Error(`${name} must be a simple LayerFS identifier`);
  }
  return normalized;
}

export function parseLayerFSConfig(env: NodeJS.ProcessEnv): LayerFSConfig {
  const createSandbox = env.PI_LAYERFS_CREATE_SANDBOX === "1";
  const config: LayerFSConfig = {
    home: required("LAYERFS_HOME", env.LAYERFS_HOME),
    project: identifier("PI_LAYERFS_PROJECT", env.PI_LAYERFS_PROJECT),
    sandbox: identifier("PI_LAYERFS_SANDBOX", env.PI_LAYERFS_SANDBOX),
    branch: identifier("PI_LAYERFS_BRANCH", env.PI_LAYERFS_BRANCH ?? "agent"),
    workspace: identifier("PI_LAYERFS_WORKSPACE", env.PI_LAYERFS_WORKSPACE ?? "agent"),
    createSandbox,
  };
  if (createSandbox) {
    config.machine = identifier("PI_LAYERFS_MACHINE", env.PI_LAYERFS_MACHINE);
    config.image = required("PI_LAYERFS_IMAGE", env.PI_LAYERFS_IMAGE);
  }
  return config;
}
