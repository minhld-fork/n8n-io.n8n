/**
 * Bound and strip the natural-language text an MCP server supplies.
 *
 * Tool descriptions and input-schema field descriptions are copied straight
 * into the model's tool context, so the server that ships them can steer the
 * orchestrator or flood its context. Tool names are validated in
 * `mcp-tool-name-validation.ts` and schema shapes in `sanitize-mcp-schemas.ts`;
 * this module covers the free-text surface those two leave untouched.
 *
 * Text is not rewritten beyond removing what the model reads but a person
 * reading the server's manifest would not see — a description has to stay
 * useful enough to call the tool with.
 */

import { isRecord } from '@n8n/utils/is-record';

import { sanitizeWebContent } from '../tools/web-research/sanitize-web-content';

/**
 * Headroom over the longest descriptions real servers ship, so the cap only
 * ever catches a flood. Measured against `mcp.notion.com` on 2026-08-20, the
 * known worst offender (AGENT-448): 28 tools, longest tool description 7,867
 * chars (`notion-update-page`), longest field description 1,199 chars
 * (`notion-create-comment`), 108,963 chars of tools/list in total.
 */
export const MCP_TOOL_DESCRIPTION_MAX_LENGTH = 16_384;
export const MCP_SCHEMA_DESCRIPTION_MAX_LENGTH = 4_096;

const TRUNCATION_MARKER = '… [truncated]';

/** C0/C1 control characters, keeping tab and newline. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** JSON Schema keywords whose value is free text the model reads. */
const DESCRIPTION_KEYWORDS = new Set(['description', 'title']);

/** Reported when a cap actually clips text, so a wrongly-set cap is visible. */
export interface McpDescriptionTruncation {
	toolName?: string;
	path: string;
	originalLength: number;
	limit: number;
}

export type ReportTruncation = (truncation: McpDescriptionTruncation) => void;

interface SanitizeDescriptionContext {
	toolName?: string;
	path: string;
	report?: ReportTruncation;
}

/**
 * Strip HTML comments, invisible and control characters, collapse the
 * blank-line padding used to push text out of view, and cap the length.
 */
export function sanitizeMcpDescription(
	value: string,
	maxLength: number,
	context: SanitizeDescriptionContext = { path: '$' },
): string {
	const stripped = sanitizeWebContent(value.replace(/\r\n?/g, '\n'))
		.replace(CONTROL_CHARACTER_PATTERN, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	if (stripped.length <= maxLength) return stripped;

	context.report?.({
		toolName: context.toolName,
		path: context.path,
		originalLength: stripped.length,
		limit: maxLength,
	});
	return stripped.slice(0, maxLength - TRUNCATION_MARKER.length).trimEnd() + TRUNCATION_MARKER;
}

/**
 * Sanitize every `description` / `title` in a raw JSON Schema, returning a new
 * tree. Call it after `assertMcpJsonSchemaWithinLimits`, which is what bounds
 * the recursion — a schema that got this far is depth- and node-capped.
 */
export function sanitizeMcpJsonSchemaDescriptions<T>(
	schema: T,
	context: SanitizeDescriptionContext = { path: '$' },
): T {
	return sanitizeJsonSchemaNode(schema, context) as T;
}

function sanitizeJsonSchemaNode(value: unknown, context: SanitizeDescriptionContext): unknown {
	if (Array.isArray(value)) {
		return value.map((item, index) =>
			sanitizeJsonSchemaNode(item, { ...context, path: `${context.path}[${index}]` }),
		);
	}
	if (!isRecord(value)) return value;

	// fromEntries rather than assignment so a `__proto__` key stays an own
	// property instead of reaching the prototype setter.
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => {
			const childContext = { ...context, path: `${context.path}.${key}` };
			return [
				key,
				DESCRIPTION_KEYWORDS.has(key) && typeof child === 'string'
					? sanitizeMcpDescription(child, MCP_SCHEMA_DESCRIPTION_MAX_LENGTH, childContext)
					: sanitizeJsonSchemaNode(child, childContext),
			];
		}),
	);
}
