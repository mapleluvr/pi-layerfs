import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, close, LayerFSError } from '@layerfs/node';

const [action, key, argument] = process.argv.slice(2);
assert.match(key ?? '', /^[0-9a-f]{32}$/);
const runtime = fileURLToPath(new URL('..', import.meta.url));
const root = '/persist';
const home = `${root}/layerfs`;
const state = `${root}/projects/${key}`;
const started = `${state}/source.json`;
const ready = `${state}/ready.json`;
const store = 'projects';
const project = `${store}/p-${key}`;
const sandbox = `p-${key}`;
const branch = 'agent';
const workspace = `${sandbox}:${branch}`;
const fuseMagic = 0x65735546;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
function status() {
    if (existsSync(ready)) return { state: 'ready', ...readJson(ready) };
    if (existsSync(state)) return { state: 'incomplete' };
    return { state: 'new' };
}

const lfs = action === 'status' ? null : client({ home });
async function binding() {
    const current = await lfs.sandbox.get(sandbox, { detail: true, with: ['stats'] });
    assert.equal(current.project, project);
    assert.equal(current.machine, 'native');
    assert.equal(current.backend, 'namespaces');
    assert.equal(current.route, 'fuse');
    assert.equal(current.state, 'ready');
    const [mounted, ...others] = current.workspaces.filter(entry => entry.workspace === workspace);
    assert.ok(mounted && others.length === 0);
    assert.equal(mounted.state, 'ready');
    assert.equal(mounted.branch, branch);
    const identity = { path: mounted.path, id: mounted.id, mountedAt: mounted.mounted_at,
        createdAt: current.created_at, image: current.image };
    return { mounted, pid: current.stats.daemon.pid, identity };
}

function attach({ mounted: { path }, pid }) {
    assert.equal(readdirSync(path).length, 0, 'Expected an empty control mount point');
    assert.notEqual(statfsSync(path).type, fuseMagic);
    const remote = `/proc/${pid}/root${path}`;
    assert.equal(statfsSync(remote).type, fuseMagic);
    const { dev, ino } = statSync(remote, { bigint: true });
    const info = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = info.slice(info.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    execFileSync('/usr/bin/perl', [fileURLToPath(new URL('./attach-view.pl', import.meta.url)),
        pid, path, String(dev), String(ino), start], { stdio: 'inherit' });
    assert.equal(statfsSync(path).type, fuseMagic);
    return path;
}

async function initialize(inbox) {
    assert.equal(status().state, 'new', `Project state exists at ${state}. Inspect it before retrying.`);
    assert.match(inbox ?? '', /^\/incoming\/[a-f0-9]{12}\/snapshot$/);
    const source = readJson(`${inbox}/source.json`);
    assert.equal(source.key, key);
    assert.match(source.commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    assert.ok(Number.isSafeInteger(source.files) && source.files > 0);
    mkdirSync(`${root}/projects`, { mode: 0o700, recursive: true });
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(started, JSON.stringify(source) + '\n', { flag: 'wx', mode: 0o600 });
    await lfs.home.init();
    assert.equal((await lfs.machine.get('native')).state, 'ready');
    try {
        await lfs.store.get(store);
    } catch (error) {
        if (!(error instanceof LayerFSError) || error.code !== 'NotFound') throw error;
        await lfs.store.create(store, { machine: 'native' });
    }
    await lfs.project.init(project, `${inbox}/source`, { detail: true });
    await lfs.branch.fork(project, branch, 'main');
    const base = (await lfs.branch.get(project, branch)).commit;
    await lfs.sandbox.create(project, sandbox, { machine: 'native' });
    await lfs.workspace.mount(sandbox, branch, { name: branch });
    const current = await binding();
    // Verify the real FUSE mount before making the binding available to Pi.
    attach(current);
    writeFileSync(ready, JSON.stringify({ key, commit: source.commit, path: source.path,
        name: source.name, workspace, base, identity: current.identity }) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Imported ${source.name} at ${source.commit.slice(0, 12)} into ${workspace} (${source.files} files).`);
}

async function open() {
    const record = status();
    assert.equal(record.state, 'ready', `Initialize project ${key} first.`);
    const current = await binding();
    assert.deepEqual(current.identity, record.identity, 'Saved Workspace identity changed');
    const path = attach(current);
    if (action === 'check') {
        const result = await lfs.workspace.exec(workspace, 'id -u', { detail: true });
        assert.equal(result.exit_code, 0);
        assert.equal(result.stdout.trim(), '501');
        console.log(`PASS: ${workspace} has the expected FUSE view and a uid 501 shell.`);
        return 0;
    }
    const sessionDir = `${state}/sessions`;
    const profile = `${root}/pi-profile`;
    const homeDir = `${state}/home`;
    for (const directory of [sessionDir, profile, homeDir]) mkdirSync(directory, { mode: 0o700, recursive: true });
    const env = {
        PATH: join(runtime, 'bin') + ':/usr/bin:/bin', HOME: homeDir, PI_CODING_AGENT_DIR: profile,
        LANG: 'C.UTF-8', TERM: process.env.TERM || 'xterm-256color', PI_SKIP_VERSION_CHECK: '1',
        LAYERFS_HOME: home, LAYERFS_BUNDLE: process.env.LAYERFS_BUNDLE, PI_LAYERFS_PROJECT: project,
        PI_LAYERFS_SANDBOX: sandbox, PI_LAYERFS_BRANCH: branch, PI_LAYERFS_WORKSPACE: branch,
    };
    const args = ['--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates',
        '--no-builtin-tools', '--session-dir', sessionDir, '--continue'];
    args.push('-e', join(runtime, 'extension/index.ts'), '-e', join(runtime, 'projects/project-shell.ts'));
    console.log(`Workspace ${workspace} · ${record.name} @ ${record.commit.slice(0, 12)}`);
    process.setgid(20);
    process.umask(0o002);
    const child = spawn(process.execPath, [join(runtime, 'node_modules/.bin/pi'), ...args],
        { cwd: path, env, stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    try {
        return await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
        });
    } finally {
        process.removeListener('SIGTERM', stop);
    }
}

try {
    assert.equal(process.getuid(), 0);
    assert.notEqual(readlinkSync('/proc/self/ns/mnt'), readlinkSync('/proc/1/ns/mnt'), 'Use a private mount namespace');
    process.umask(0o022);
    switch (action) {
        case 'status': console.log(JSON.stringify(status())); break;
        case 'init': await initialize(argument); break;
        case 'check':
        case 'open': process.exitCode = await open(); break;
        default: throw new Error('Expected status, init, check or open');
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    if (lfs) close();
}
