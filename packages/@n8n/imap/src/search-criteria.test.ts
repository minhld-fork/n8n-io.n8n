import type { SearchObject } from 'imapflow';

import { toSearchObject, type SearchCriteria } from './search-criteria';

type CompiledAttribute = { type: string; value: string } | CompiledAttribute[];

// Resolved through a variable so TS does not try to type the untyped CJS deep import.
const compilerPath = 'imapflow/lib/search-compiler.js';
let searchCompiler: (connection: unknown, query: SearchObject) => CompiledAttribute[];

beforeAll(async () => {
	const compiler = (await import(compilerPath)) as {
		searchCompiler: typeof searchCompiler;
	};
	searchCompiler = compiler.searchCompiler;
});

const connection = {
	capabilities: new Map<string, boolean>(),
	enabled: new Set<string>(),
	mailbox: { flags: new Set<string>(), permanentFlags: new Set(['\\*']) },
};

const render = (attributes: CompiledAttribute[]): string =>
	attributes
		.map((attribute) => (Array.isArray(attribute) ? `(${render(attribute)})` : attribute.value))
		.join(' ');

const compile = (criteria: SearchCriteria[], server = connection) =>
	render(searchCompiler(server, toSearchObject(criteria)));

const gmailConnection = { ...connection, capabilities: new Map([['X-GM-EXT-1', true]]) };

describe('toSearchObject', () => {
	describe('flag atoms', () => {
		test.each<[string, SearchObject]>([
			['ALL', { all: true }],
			['ANSWERED', { answered: true }],
			['DELETED', { deleted: true }],
			['DRAFT', { draft: true }],
			['FLAGGED', { flagged: true }],
			['NEW', { new: true }],
			['OLD', { old: true }],
			['RECENT', { recent: true }],
			['SEEN', { seen: true }],
			['UNANSWERED', { answered: false }],
			['UNDELETED', { deleted: false }],
			['UNDRAFT', { draft: false }],
			['UNFLAGGED', { flagged: false }],
			['UNSEEN', { seen: false }],
		])('maps %s', (atom, expected) => {
			expect(toSearchObject([atom])).toEqual(expected);
		});

		it('matches atoms case-insensitively', () => {
			expect(toSearchObject(['unseen'])).toEqual({ seen: false });
			expect(toSearchObject([['UnSeEn']])).toEqual({ seen: false });
		});
	});

	describe('string atoms', () => {
		test.each<[string, SearchObject]>([
			['BCC', { bcc: 'a@example.com' }],
			['BODY', { body: 'a@example.com' }],
			['CC', { cc: 'a@example.com' }],
			['FROM', { from: 'a@example.com' }],
			['SUBJECT', { subject: 'a@example.com' }],
			['TEXT', { text: 'a@example.com' }],
			['TO', { to: 'a@example.com' }],
		])('maps %s', (atom, expected) => {
			expect(toSearchObject([[atom, 'a@example.com']])).toEqual(expected);
		});

		it('throws when the argument count is wrong', () => {
			expect(() => toSearchObject(['FROM'])).toThrow(/FROM/);
			expect(() => toSearchObject([['FROM', 'a', 'b']])).toThrow(/FROM/);
		});

		it('throws on an empty value', () => {
			expect(() => toSearchObject([['FROM', '']])).toThrow(/FROM/);
		});
	});

	describe('date atoms', () => {
		test.each<[string, SearchObject]>([
			['BEFORE', { before: '2026-08-19' }],
			['ON', { on: '2026-08-19' }],
			['SINCE', { since: '2026-08-19' }],
			['SENTBEFORE', { sentBefore: '2026-08-19' }],
			['SENTON', { sentOn: '2026-08-19' }],
			['SENTSINCE', { sentSince: '2026-08-19' }],
		])('maps %s', (atom, expected) => {
			expect(toSearchObject([[atom, '19-Aug-2026']])).toEqual(expected);
		});

		it('accepts a Date and keeps its local calendar day', () => {
			expect(toSearchObject([['SINCE', new Date(2026, 7, 19, 23, 30)]])).toEqual({
				since: '2026-08-19',
			});
		});

		it('throws on an unparseable date', () => {
			expect(() => toSearchObject([['SINCE', 'not-a-date']])).toThrow(/SINCE/);
		});
	});

	describe('HEADER', () => {
		it('maps field name and value', () => {
			expect(toSearchObject([['HEADER', 'X-Mailer', 'n8n']])).toEqual({
				header: { 'X-Mailer': 'n8n' },
			});
		});

		it('merges distinct header fields', () => {
			expect(
				toSearchObject([
					['HEADER', 'X-One', '1'],
					['HEADER', 'X-Two', '2'],
				]),
			).toEqual({ header: { 'X-One': '1', 'X-Two': '2' } });
		});

		it('keeps an empty value as a header presence check', () => {
			expect(toSearchObject([['HEADER', 'X-Mailer', '']])).toEqual({ header: { 'X-Mailer': '' } });
		});

		it('throws when not given exactly two arguments', () => {
			expect(() => toSearchObject([['HEADER', 'X-Mailer']])).toThrow(/HEADER/);
		});

		it('throws on an empty field name', () => {
			expect(() => toSearchObject([['HEADER', '', 'n8n']])).toThrow(/HEADER/);
		});
	});

	describe('keyword atoms', () => {
		it('maps KEYWORD and UNKEYWORD', () => {
			expect(toSearchObject([['KEYWORD', 'todo']])).toEqual({ keyword: 'todo' });
			expect(toSearchObject([['UNKEYWORD', 'todo']])).toEqual({ unKeyword: 'todo' });
		});

		it('throws on an empty keyword', () => {
			expect(() => toSearchObject([['KEYWORD', '']])).toThrow(/KEYWORD/);
		});

		it('throws on the \\Recent flag', () => {
			expect(() => toSearchObject([['KEYWORD', '\\Recent']])).toThrow(/KEYWORD/);
			expect(() => toSearchObject([['UNKEYWORD', '\\recent']])).toThrow(/UNKEYWORD/);
		});
	});

	describe('size atoms', () => {
		it('maps LARGER and SMALLER to numbers', () => {
			expect(toSearchObject([['LARGER', '1024']])).toEqual({ larger: 1024 });
			expect(toSearchObject([['SMALLER', 2048]])).toEqual({ smaller: 2048 });
		});

		it('throws on a non-numeric size', () => {
			expect(() => toSearchObject([['LARGER', 'big']])).toThrow(/LARGER/);
		});

		it('throws on a size below one byte', () => {
			expect(() => toSearchObject([['SMALLER', 0]])).toThrow(/SMALLER/);
			expect(() => toSearchObject([['LARGER', -1]])).toThrow(/LARGER/);
		});
	});

	describe('extension atoms', () => {
		it('maps the Gmail atoms', () => {
			expect(toSearchObject([['X-GM-RAW', 'has:attachment']])).toEqual({
				gmraw: 'has:attachment',
			});
			expect(toSearchObject([['X-GM-MSGID', '1278455344230334865']])).toEqual({
				emailId: '1278455344230334865',
			});
			expect(toSearchObject([['X-GM-THRID', '1278455344230334865']])).toEqual({
				threadId: '1278455344230334865',
			});
			expect(toSearchObject([['x-gm-labels', 'Invoices']])).toEqual({
				labels: { has: ['Invoices'] },
			});
		});

		it('maps MODSEQ to a bigint', () => {
			expect(toSearchObject([['MODSEQ', '620162338']])).toEqual({ modseq: 620162338n });
		});

		it('throws on empty or non-positive extension values', () => {
			expect(() => toSearchObject([['X-GM-RAW', '']])).toThrow(/X-GM-RAW/);
			expect(() => toSearchObject([['X-GM-LABELS', '']])).toThrow(/X-GM-LABELS/);
			expect(() => toSearchObject([['MODSEQ', 0]])).toThrow(/MODSEQ/);
			expect(() => toSearchObject([['MODSEQ', 'soon']])).toThrow(/MODSEQ/);
		});
	});

	describe('UID', () => {
		it('keeps an inclusive open-ended range verbatim', () => {
			expect(toSearchObject([['UID', '42:*']])).toEqual({ uid: '42:*' });
		});

		it('joins multiple uid arguments into one set', () => {
			expect(toSearchObject([['UID', 1, '3:5', '*']])).toEqual({ uid: '1,3:5,*' });
		});

		it('throws without arguments or on a malformed set', () => {
			expect(() => toSearchObject(['UID'])).toThrow(/UID/);
			expect(() => toSearchObject([['UID', 'abc']])).toThrow(/UID/);
		});
	});

	describe('bare sequence sets', () => {
		it('maps a sequence set to seq', () => {
			expect(toSearchObject(['1:5'])).toEqual({ seq: '1:5' });
			expect(toSearchObject([['2', '4:6']])).toEqual({ seq: '2,4:6' });
		});
	});

	describe('OR', () => {
		it('maps two criteria into an or pair', () => {
			expect(toSearchObject([['OR', 'UNSEEN', ['FROM', 'a@example.com']]])).toEqual({
				or: [{ seen: false }, { from: 'a@example.com' }],
			});
		});

		it('supports nested or and negated children', () => {
			expect(toSearchObject([['OR', '!SEEN', ['OR', 'FLAGGED', 'DRAFT']]])).toEqual({
				or: [{ not: { seen: true } }, { or: [{ flagged: true }, { draft: true }] }],
			});
		});

		it('throws unless given exactly two criteria', () => {
			expect(() => toSearchObject([['OR', 'SEEN']])).toThrow(/OR/);
			expect(() => toSearchObject([['OR', 'SEEN', 'DRAFT', 'FLAGGED']])).toThrow(/OR/);
		});
	});

	describe('negation', () => {
		it('wraps a single negated criterion in not', () => {
			expect(toSearchObject(['!SEEN'])).toEqual({ not: { seen: true } });
			expect(toSearchObject([['!FROM', 'a@example.com']])).toEqual({
				not: { from: 'a@example.com' },
			});
		});

		it('combines several negated criteria with De Morgan', () => {
			expect(toSearchObject(['!SEEN', ['!FROM', 'a@example.com']])).toEqual({
				not: { or: [{ seen: true }, { from: 'a@example.com' }] },
			});
		});

		it('negates an or criterion', () => {
			expect(toSearchObject([['!OR', 'SEEN', 'DRAFT']])).toEqual({
				not: { or: [{ seen: true }, { draft: true }] },
			});
		});

		it('keeps negated and positive criteria side by side', () => {
			expect(toSearchObject(['UNSEEN', '!FLAGGED'])).toEqual({
				seen: false,
				not: { flagged: true },
			});
		});
	});

	describe('combining criteria', () => {
		it('ands criteria with distinct keys into one object', () => {
			expect(toSearchObject(['UNSEEN', ['SINCE', '19-Aug-2026'], ['LARGER', 10]])).toEqual({
				seen: false,
				since: '2026-08-19',
				larger: 10,
			});
		});

		it('ands colliding keys through a De Morgan wrapper', () => {
			expect(
				toSearchObject([
					['FROM', 'a@example.com'],
					['FROM', 'b@example.com'],
				]),
			).toEqual({
				not: {
					or: [{ not: { from: 'a@example.com' } }, { not: { from: 'b@example.com' } }],
				},
			});
		});

		it('groups non-colliding keys before falling back', () => {
			expect(
				toSearchObject([['FROM', 'a@example.com'], 'UNSEEN', ['FROM', 'b@example.com']]),
			).toEqual({
				not: {
					or: [{ not: { from: 'a@example.com', seen: false } }, { not: { from: 'b@example.com' } }],
				},
			});
		});

		it('refuses an empty criteria list, which would search every message', () => {
			expect(() => toSearchObject([])).toThrow(/at least one criterion/);
		});
	});

	describe('rejecting unusable input', () => {
		it('throws naming the unknown atom', () => {
			expect(() => toSearchObject(['BOGUS'])).toThrow(/BOGUS/);
			expect(() => toSearchObject([['X-GM-EVERYTHING', 'yes']])).toThrow(/X-GM-EVERYTHING/);
		});

		it('throws on a criterion that is neither string nor array', () => {
			// @ts-expect-error deliberately invalid input from a saved workflow
			expect(() => toSearchObject([{ unseen: true }])).toThrow();
		});
	});

	describe('compiled by imapflow', () => {
		it('compiles the trigger node defaults', () => {
			expect(compile(['UNSEEN'])).toBe('UNSEEN');
			expect(compile([['UID', '42:*']])).toBe('UID 42:*');
			expect(compile(['UNSEEN', ['SINCE', '19-Aug-2026']])).toBe('UNSEEN SINCE 19-Aug-2026');
		});

		it('keeps dates date-precise on a server advertising WITHIN', () => {
			const within = { ...connection, capabilities: new Map<string, boolean>([['WITHIN', true]]) };

			expect(compile([['SINCE', '19-Aug-2026']], within)).toBe('SINCE 19-Aug-2026');
			expect(compile([['BEFORE', '19-Aug-2026']], within)).toBe('BEFORE 19-Aug-2026');
		});

		it('compiles flag, string, header and size atoms', () => {
			expect(
				compile([
					'ANSWERED',
					['FROM', 'a@example.com'],
					['HEADER', 'x-mailer', 'n8n'],
					['LARGER', 1024],
					['KEYWORD', 'todo'],
				]),
			).toBe('ANSWERED FROM a@example.com HEADER X-MAILER n8n LARGER 1024 KEYWORD todo');
		});

		it('compiles every date atom', () => {
			expect(
				compile([
					['BEFORE', '19-Aug-2026'],
					['ON', '19-Aug-2026'],
					['SENTSINCE', new Date(2026, 7, 19, 23, 30)],
				]),
			).toBe('BEFORE 19-Aug-2026 ON 19-Aug-2026 SENTSINCE 19-Aug-2026');
		});

		it('compiles or and negation', () => {
			expect(compile([['OR', 'UNSEEN', ['FROM', 'a@example.com']]])).toBe(
				'OR UNSEEN FROM a@example.com',
			);
			expect(compile(['!SEEN'])).toBe('NOT SEEN');
			expect(compile(['!SEEN', '!FLAGGED'])).toBe('NOT OR SEEN FLAGGED');
		});

		it('compiles the Gmail atoms against a Gmail server', () => {
			expect(compile([['X-GM-RAW', 'has:attachment']], gmailConnection)).toBe(
				'X-GM-RAW has:attachment',
			);
			expect(compile([['X-GM-MSGID', '12784553']], gmailConnection)).toBe('X-GM-MSGID 12784553');
			expect(compile([['X-GM-THRID', '12784553']], gmailConnection)).toBe('X-GM-THRID 12784553');
			expect(compile([['X-GM-LABELS', 'My Invoices']], gmailConnection)).toBe(
				'X-GM-RAW label:"My Invoices"',
			);
			expect(compile([['MODSEQ', '620162338']], gmailConnection)).toBe('MODSEQ 620162338');
		});

		it('compiles colliding criteria without dropping any of them', () => {
			expect(compile([['FROM', 'a@example.com'], 'UNSEEN', ['FROM', 'b@example.com']])).toBe(
				'NOT OR NOT (FROM a@example.com UNSEEN) NOT FROM b@example.com',
			);
		});
	});
});
