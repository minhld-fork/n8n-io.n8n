import type { ExecutionStore, StepSlots, StepStore } from '@n8n/engine';

import type { StepData, StepDataLoader } from './types';

/**
 * A `StepDataLoader` backed by the engine's own stores: the graph off the
 * execution row, the outputs of every completed step off the step rows, at every
 * iteration. Loads everything. TODO(CAT-3017): load selectively, based on what
 * the step's expressions actually reference. Loops make that matter more, since
 * an execution's step count now scales with the data it processes.
 *
 * Steps that haven't completed are omitted rather than mapped to null, so
 * expressions referencing them fail with the standard "hasn't been executed"
 * error.
 */
export function createEngineStepDataLoader(
	executionStore: ExecutionStore,
	stepStore: StepStore,
): StepDataLoader {
	return async (context): Promise<StepData> => {
		const execution = await executionStore.loadExecution(context.executionId);
		const steps = await stepStore.loadAllSteps(context.executionId);

		// Keyed by iteration as well as node, since a loop member runs once per pass
		// and v1 indexes a node's run data the same way.
		const outputsByNode: Record<string, Record<number, StepSlots>> = {};
		for (const step of steps) {
			if (step.status !== 'completed' || step.outputs === null) continue;
			outputsByNode[step.nodeId] ??= {};
			outputsByNode[step.nodeId][step.iteration] = step.outputs;
		}

		return { graph: execution.graph, outputsByNode };
	};
}
