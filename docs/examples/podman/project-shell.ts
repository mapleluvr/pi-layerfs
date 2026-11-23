import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { LayerFSExecutionCapability } from '../../../src/protocol.ts';

// Route Pi's interactive ! command through the same Workspace as the Bash tool.
export default function (pi: ExtensionAPI) {
    let capability: LayerFSExecutionCapability | undefined;
    pi.events.on('pi-layerfs:execution-capability', value => {
        const candidate = value as LayerFSExecutionCapability | undefined;
        capability = candidate?.protocol?.id === 'pi-layerfs.execution'
            && candidate.protocol.major === 1 && typeof candidate.start === 'function'
            && typeof candidate.wait === 'function' ? candidate : undefined;
    });
    pi.on('user_bash', () => ({
        operations: {
            async exec(command, _cwd, { onData, signal }) {
                if (capability?.protocol.major !== 1) throw new Error('LayerFS Workspace shell is unavailable');
                const handle = await capability.start({ command, cwd: '.', onData, signal });
                const result = await capability.wait(handle, 24 * 60 * 60 * 1000);
                if (typeof result.exitCode !== 'number') {
                    throw new Error(`LayerFS command completion is ${result.state}. Check execution ${handle.execId}.`);
                }
                return { exitCode: result.exitCode };
            },
        },
    }));
}
