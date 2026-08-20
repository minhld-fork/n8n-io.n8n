import type { MessageStructureObject } from 'imapflow';

import type { MessagePart } from './types';

/**
 * Depth-first, as node-imap's `getParts()` was: attachments are named
 * `attachment_<index>` by their position here, and the body is the first
 * `text/<subtype>` hit, so the order is load-bearing.
 */
export function toMessageParts(bodyStructure: MessageStructureObject): MessagePart[] {
	const parts: MessagePart[] = [];
	collectParts(bodyStructure, parts);
	return parts;
}

function collectParts(node: MessageStructureObject, parts: MessagePart[]): void {
	const [type, subtype] = splitContentType(node.type);

	if (type === 'multipart') {
		// node-imap gave container nodes no `partID`, so its flattener dropped them
		for (const child of node.childNodes ?? []) {
			collectParts(child, parts);
		}
		return;
	}

	// A leaf without a subtype is node-imap's "malformed multipart" case, which it
	// also emitted without a `partID`
	if (!subtype) return;

	parts.push({
		// imapflow leaves `part` unset on the root of a single-part message
		partID: node.part ?? '1',
		type,
		subtype,
		params: node.parameters ?? null,
		// Left as-is when the server omits it (iCloud does); callers apply the 7BIT default
		encoding: node.encoding ?? null,
		disposition: node.disposition
			? { type: node.disposition, params: node.dispositionParameters ?? null }
			: null,
	});

	// `message/rfc822` carries the encapsulated message in `childNodes`, but node-imap
	// kept it on a separate `body` key that its flattener never descended into
}

function splitContentType(contentType: string | undefined): [string, string] {
	const [type = '', subtype = ''] = (contentType ?? '').split('/');
	return [type, subtype];
}
