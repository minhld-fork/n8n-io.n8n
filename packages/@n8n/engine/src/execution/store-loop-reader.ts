import { UnexpectedError, type JsonValue } from '../common';
import type { WorkflowLoop } from '../graph';
import type { LoopReader } from './batch-step';
import { stepKeyId } from './execution.types';
import { classifyEdge, sourceRow } from './iteration-mapping';
import type { StepStore } from './step-store';

/** A `LoopReader` over the step store, for one loop. */
export function createStoreLoopReader(
	stepStore: StepStore,
	executionId: string,
	loops: WorkflowLoop[],
	loop: WorkflowLoop,
	terminalIterations: Map<string, number>,
): LoopReader {
	const [entryEdge] = loop.entryEdges;
	const [backEdge] = loop.backEdges;

	return {
		async readOriginalItems() {
			// A loop with no entry edge starts on nothing, so the first pass ends it.
			// `validateLoops` allows this: a rootless loop component has no way in.
			if (!entryEdge) return null;

			// Which step the entry edge reads depends on its class, not on this loop.
			// An edge from an earlier loop's done slot reads that loop's terminal
			// pass, and reading iteration 0 there would find a dead slot.
			const source = sourceRow(
				entryEdge,
				classifyEdge(entryEdge, loops),
				{ nodeId: loop.batchNodeId, iteration: 0 },
				terminalIterations.get(entryEdge.from),
			);
			if (source.kind !== 'row') {
				throw new UnexpectedError(
					`batch node ${loop.batchNodeId} reads ${entryEdge.from}, which has no step to read`,
				);
			}

			const steps = await stepStore.loadStepsByKeys(executionId, [source.key]);
			const step = steps[stepKeyId(source.key)];
			if (!step) {
				throw new UnexpectedError(
					`batch node ${loop.batchNodeId} reads ${entryEdge.from} at iteration ${source.key.iteration}, which has no step`,
				);
			}
			return step.outputs?.[entryEdge.outputIndex] ?? null;
		},

		async readArrivals(iteration) {
			// `validateLoops` requires the return edge, so this cannot happen.
			if (!backEdge) return [];
			if (iteration === 0) return [];

			const keys = Array.from({ length: iteration }, (_, index) => ({
				nodeId: backEdge.from,
				iteration: index,
			}));
			const steps = await stepStore.loadStepsByKeys(executionId, keys);

			return keys.map((key): JsonValue => {
				const step = steps[stepKeyId(key)];
				// Every earlier pass settled before this one was planned, so each has a
				// step. A missing one means the steps and the plan disagree, and
				// treating it as empty would drop items from the accumulated output.
				if (!step) {
					throw new UnexpectedError(
						`batch node ${loop.batchNodeId} reads ${backEdge.from} at iteration ${key.iteration}, which has no step`,
					);
				}
				// A pass whose body was skipped sent nothing back, which is an empty
				// arrival rather than an error.
				return step.outputs?.[backEdge.outputIndex] ?? null;
			});
		},
	};
}
