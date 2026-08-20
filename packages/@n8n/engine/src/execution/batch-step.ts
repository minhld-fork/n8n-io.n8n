import { UnexpectedError, type JsonValue } from '../common';
import type { BatchStepConfig } from '../graph';
import type { StepSlots } from './execution.types';
import { DONE_SLOT, LOOP_SLOT } from './loop-ledger';

/**
 * What a batch step reads beyond its own declared input, which at iteration `i`
 * is only the body's output from iteration `i - 1`.
 *
 * Both reads return settled steps, which can no longer change, so the executor
 * stays a pure function of them. They sit behind this interface rather than
 * widening `IStepExecutor`, which external executors share.
 */
export interface LoopReader {
	/** What the entry edge carried into the loop, fixed for every pass. */
	readOriginalItems(): Promise<JsonValue>;
	/** The body's output for iterations `0` to `iteration - 1`, in order. */
	readArrivals(iteration: number): Promise<JsonValue[]>;
}

/**
 * One pass of a batch node, as output slots. Pass `i` takes `batchSize` items
 * starting at `i * batchSize`, and the first pass to find none left ends the loop.
 *
 * The result depends only on settled steps, so a retry recomputes it exactly.
 *
 * This is the one place the engine looks inside a slot, since slicing and
 * concatenation need the contents to be a list. The elements stay opaque.
 */
export async function runBatchStep(
	config: BatchStepConfig,
	iteration: number,
	reader: LoopReader,
): Promise<StepSlots> {
	const originalItems = asList(await reader.readOriginalItems(), 'the batch node input');
	const start = iteration * config.batchSize;
	const slice = originalItems.slice(start, start + config.batchSize);

	if (slice.length > 0) return slot(LOOP_SLOT, slice);

	// The done payload is the body's output, not the original items, as in v1.
	const arrivals = await reader.readArrivals(iteration);
	const accumulated = arrivals.flatMap((arrival, index) =>
		asList(arrival, `arrival ${index} of the batch node`),
	);

	// v1 fires nothing when the done port has no items, so neither do we, and the
	// nodes after the loop settle skipped.
	if (accumulated.length === 0) return [null, null];

	return slot(DONE_SLOT, accumulated);
}

/** A two-slot output with one slot filled, the other dead. */
function slot(filled: number, value: JsonValue[]): StepSlots {
	return filled === DONE_SLOT ? [value, null] : [null, value];
}

/**
 * A slot's contents as a list, with `what` naming the slot if it is not one. A
 * dead slot reads as empty, which is how a loop whose body filtered everything
 * out ends rather than throws.
 */
function asList(value: JsonValue, what: string): JsonValue[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value;
	throw new UnexpectedError(`${what} holds ${typeof value}, and a batch node slices a list`);
}
