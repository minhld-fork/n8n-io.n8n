import type { FetchQueryObject } from 'imapflow';

import { parseHeaders } from './headers';
import type { FetchOptions, MessageBodyPart } from './types';

/** node-imap's section name for the entire raw message. */
const WHOLE_MESSAGE = '';
const HEADER = 'HEADER';

export function toFetchQuery(options: FetchOptions): FetchQueryObject {
	const query: FetchQueryObject = { uid: true, flags: true, internalDate: true, size: true };

	if (options.struct) query.bodyStructure = true;

	const bodyParts: string[] = [];
	for (const section of options.bodies ?? []) {
		if (section === WHOLE_MESSAGE) query.source = true;
		else if (section.toUpperCase() === HEADER) query.headers = true;
		else bodyParts.push(section);
	}
	if (bodyParts.length) query.bodyParts = bodyParts;

	return query;
}

interface FetchedSections {
	source?: Buffer;
	headers?: Buffer;
	bodyParts?: Map<string, Buffer>;
}

export function toMessageBodyParts(
	fetched: FetchedSections,
	options: FetchOptions,
): MessageBodyPart[] {
	const parts: MessageBodyPart[] = [];

	for (const section of options.bodies ?? []) {
		if (section === WHOLE_MESSAGE) {
			if (fetched.source) {
				parts.push({ which: section, size: fetched.source.length, body: fetched.source });
			}
			continue;
		}

		if (section.toUpperCase() === HEADER) {
			if (fetched.headers) {
				parts.push({
					which: section,
					size: fetched.headers.length,
					body: parseHeaders(fetched.headers),
				});
			}
			continue;
		}

		// imapflow lowercases its map keys; callers match on the name they asked for.
		const body = fetched.bodyParts?.get(section.toLowerCase());
		if (body) parts.push({ which: section, size: body.length, body: body.toString('utf8') });
	}

	return parts;
}
