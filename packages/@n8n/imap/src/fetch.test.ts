import { toFetchQuery, toMessageBodyParts } from './fetch';

describe('toFetchQuery', () => {
	it('always requests the attributes every caller reads', () => {
		expect(toFetchQuery({})).toEqual({ uid: true, flags: true, internalDate: true, size: true });
	});

	it('maps struct to bodyStructure', () => {
		expect(toFetchQuery({ struct: true })).toMatchObject({ bodyStructure: true });
	});

	it('maps the empty section to the whole message source', () => {
		expect(toFetchQuery({ bodies: [''] })).toMatchObject({ source: true });
	});

	it('maps HEADER to headers', () => {
		expect(toFetchQuery({ bodies: ['HEADER'] })).toMatchObject({ headers: true });
	});

	it('maps remaining sections to bodyParts', () => {
		expect(toFetchQuery({ bodies: ['TEXT', '1.2'] })).toMatchObject({ bodyParts: ['TEXT', '1.2'] });
	});

	it('maps the combination the node actually sends', () => {
		expect(toFetchQuery({ bodies: ['TEXT', 'HEADER'], struct: true })).toEqual({
			uid: true,
			flags: true,
			internalDate: true,
			size: true,
			bodyStructure: true,
			headers: true,
			bodyParts: ['TEXT'],
		});
	});
});

describe('toMessageBodyParts', () => {
	it('returns the whole message source as a Buffer under an empty section name', () => {
		const source = Buffer.from('From: a@b\r\n\r\nbody');
		const parts = toMessageBodyParts({ source }, { bodies: [''] });

		expect(parts).toEqual([{ which: '', size: source.length, body: source }]);
	});

	it('parses headers into node-imap shape', () => {
		const headers = Buffer.from('Subject: hi\r\nFrom: a@b\r\n\r\n');
		const [part] = toMessageBodyParts({ headers }, { bodies: ['HEADER'] });

		expect(part.which).toBe('HEADER');
		expect(part.body).toEqual({ subject: ['hi'], from: ['a@b'] });
	});

	it('reports the requested section name, not imapflow lowercased map key', () => {
		const bodyParts = new Map([['text', Buffer.from('raw body')]]);
		const [part] = toMessageBodyParts({ bodyParts }, { bodies: ['TEXT'] });

		expect(part.which).toBe('TEXT');
		expect(part.body).toBe('raw body');
	});

	it('omits sections the server did not return', () => {
		expect(toMessageBodyParts({ bodyParts: new Map() }, { bodies: ['TEXT'] })).toEqual([]);
	});

	it('preserves the order the sections were requested in', () => {
		const bodyParts = new Map([['text', Buffer.from('t')]]);
		const parts = toMessageBodyParts(
			{ headers: Buffer.from('Subject: s\r\n'), bodyParts },
			{ bodies: ['TEXT', 'HEADER'] },
		);

		expect(parts.map((p) => p.which)).toEqual(['TEXT', 'HEADER']);
	});
});
