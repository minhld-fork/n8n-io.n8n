import libmime from 'libmime';

const HEADER_LINE = /^([^:]+):[ \t]?(.+)?$/;

/**
 * Drop-in replacement for the `parseHeader` of the abandoned `node-imap`, whose
 * output shape the Email Trigger (IMAP) node depends on: lowercased keys mapped
 * to one array entry per occurrence of a repeated header.
 */
export function parseHeaders(raw: Buffer | string): Record<string, string[]> {
	const lines = (typeof raw === 'string' ? raw : raw.toString('utf8')).split(/\r\n|\n/);
	const headers: Record<string, string[]> = {};
	let key: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.length === 0) break; // blank line separates headers from body

		if (line.startsWith(' ') || line.startsWith('\t')) {
			const values = key === undefined ? undefined : headers[key];
			if (values === undefined) continue;

			values[values.length - 1] += line;
			continue;
		}

		const match = HEADER_LINE.exec(line);
		if (match === null) {
			// node-imap ended the whole block here, silently losing every later header
			key = undefined;
			continue;
		}

		key = match[1].toLowerCase().trim();
		const value = match[2];
		if (value) {
			if (headers[key] === undefined) headers[key] = [value];
			else headers[key].push(value);
		} else {
			headers[key] = [''];
		}
	}

	for (const values of Object.values(headers)) {
		for (let i = 0; i < values.length; i++) {
			values[i] = libmime.decodeWords(values[i]);
		}
	}

	return headers;
}
