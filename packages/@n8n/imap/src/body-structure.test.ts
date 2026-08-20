import type { MessageStructureObject } from 'imapflow';

import { toMessageParts } from './body-structure';

describe('toMessageParts', () => {
	it('flattens a single-part text/plain message to partID "1"', () => {
		const bodyStructure: MessageStructureObject = {
			type: 'text/plain',
			parameters: { charset: 'UTF-8' },
			encoding: '7bit',
			size: 1152,
			lineCount: 23,
		};

		expect(toMessageParts(bodyStructure)).toStrictEqual([
			{
				partID: '1',
				type: 'text',
				subtype: 'plain',
				params: { charset: 'UTF-8' },
				encoding: '7bit',
				disposition: null,
			},
		]);
	});

	it('keeps body-then-attachment order in multipart/mixed, dropping a subtype-less leaf', () => {
		const bodyStructure: MessageStructureObject = {
			childNodes: [
				{
					part: '1',
					type: 'text/plain',
					parameters: { charset: 'UTF-8' },
					encoding: '7bit',
					size: 33,
					lineCount: 2,
				},
				{ part: '2', type: 'text', size: 0, lineCount: 0 },
				{
					part: '3',
					type: 'application/pdf',
					parameters: { name: 'invoice.pdf' },
					encoding: 'base64',
					size: 34584,
					disposition: 'attachment',
					dispositionParameters: { filename: 'invoice.pdf' },
				},
				{
					part: '4',
					type: 'image/png',
					encoding: 'base64',
					size: 8342,
					disposition: 'attachment',
				},
			],
			type: 'multipart/mixed',
			parameters: { boundary: '----=_Part_9128_1502938' },
		};

		expect(toMessageParts(bodyStructure)).toStrictEqual([
			{
				partID: '1',
				type: 'text',
				subtype: 'plain',
				params: { charset: 'UTF-8' },
				encoding: '7bit',
				disposition: null,
			},
			{
				partID: '3',
				type: 'application',
				subtype: 'pdf',
				params: { name: 'invoice.pdf' },
				encoding: 'base64',
				disposition: { type: 'attachment', params: { filename: 'invoice.pdf' } },
			},
			{
				partID: '4',
				type: 'image',
				subtype: 'png',
				params: null,
				encoding: 'base64',
				disposition: { type: 'attachment', params: null },
			},
		]);
	});

	it('flattens three levels of nesting in document order', () => {
		const bodyStructure: MessageStructureObject = {
			childNodes: [
				{
					part: '1',
					childNodes: [
						{
							part: '1.1',
							childNodes: [
								{
									part: '1.1.1',
									type: 'text/plain',
									parameters: { charset: 'UTF-8' },
									encoding: '7bit',
									size: 10,
									lineCount: 1,
								},
								{
									part: '1.1.2',
									type: 'text/html',
									parameters: { charset: 'UTF-8' },
									encoding: '7bit',
									size: 20,
									lineCount: 1,
								},
							],
							type: 'multipart/alternative',
							parameters: { boundary: 'b3' },
						},
						{
							part: '1.2',
							type: 'image/gif',
							parameters: { name: 'inline.gif' },
							id: '<inline@x>',
							encoding: 'base64',
							size: 300,
							disposition: 'inline',
							dispositionParameters: { filename: 'inline.gif' },
						},
					],
					type: 'multipart/related',
					parameters: { boundary: 'b2' },
				},
				{
					part: '2',
					type: 'application/zip',
					parameters: { name: 'bundle.zip' },
					encoding: 'base64',
					size: 4000,
					disposition: 'attachment',
					dispositionParameters: { filename: 'bundle.zip' },
				},
			],
			type: 'multipart/mixed',
			parameters: { boundary: 'b1' },
		};

		expect(toMessageParts(bodyStructure)).toStrictEqual([
			{
				partID: '1.1.1',
				type: 'text',
				subtype: 'plain',
				params: { charset: 'UTF-8' },
				encoding: '7bit',
				disposition: null,
			},
			{
				partID: '1.1.2',
				type: 'text',
				subtype: 'html',
				params: { charset: 'UTF-8' },
				encoding: '7bit',
				disposition: null,
			},
			{
				partID: '1.2',
				type: 'image',
				subtype: 'gif',
				params: { name: 'inline.gif' },
				encoding: 'base64',
				disposition: { type: 'inline', params: { filename: 'inline.gif' } },
			},
			{
				partID: '2',
				type: 'application',
				subtype: 'zip',
				params: { name: 'bundle.zip' },
				encoding: 'base64',
				disposition: { type: 'attachment', params: { filename: 'bundle.zip' } },
			},
		]);
	});

	it('does not descend into a multipart encapsulated message', () => {
		const bodyStructure: MessageStructureObject = {
			childNodes: [
				{
					part: '1',
					type: 'text/plain',
					parameters: { charset: 'UTF-8' },
					encoding: '7bit',
					size: 51,
					lineCount: 3,
				},
				{
					part: '2',
					type: 'message/rfc822',
					parameters: { name: 'forwarded.eml' },
					encoding: '7bit',
					size: 8192,
					envelope: {
						date: new Date('2025-06-03T10:00:00.000Z'),
						subject: 'Inner subject',
						from: [{ name: '', address: 'sender@example.com' }],
						sender: [{ name: '', address: 'sender@example.com' }],
						replyTo: [{ name: '', address: 'sender@example.com' }],
						to: [{ name: '', address: 'rcpt@example.com' }],
						messageId: '<inner@example.com>',
					},
					childNodes: [
						{
							part: '2',
							childNodes: [
								{
									part: '2.1',
									type: 'text/plain',
									parameters: { charset: 'UTF-8' },
									encoding: '7bit',
									size: 200,
									lineCount: 6,
								},
								{
									part: '2.2',
									type: 'text/html',
									parameters: { charset: 'UTF-8' },
									encoding: '7bit',
									size: 400,
									lineCount: 9,
								},
							],
							type: 'multipart/alternative',
							parameters: { boundary: '----=_inner' },
						},
					],
					lineCount: 240,
					disposition: 'attachment',
					dispositionParameters: { filename: 'forwarded.eml' },
				},
			],
			type: 'multipart/mixed',
			parameters: { boundary: '----=_Part_fwd2' },
		};

		expect(toMessageParts(bodyStructure)).toStrictEqual([
			{
				partID: '1',
				type: 'text',
				subtype: 'plain',
				params: { charset: 'UTF-8' },
				encoding: '7bit',
				disposition: null,
			},
			{
				partID: '2',
				type: 'message',
				subtype: 'rfc822',
				params: { name: 'forwarded.eml' },
				encoding: '7bit',
				disposition: { type: 'attachment', params: { filename: 'forwarded.eml' } },
			},
		]);
	});

	it('keeps encoding null when the server omits it', () => {
		const bodyStructure: MessageStructureObject = {
			childNodes: [
				{
					part: '1',
					type: 'text/plain',
					parameters: { charset: 'utf-8' },
					size: 2464,
					lineCount: 51,
				},
				{
					part: '2',
					type: 'text/html',
					parameters: { charset: 'utf-8' },
					size: 9834,
					lineCount: 152,
				},
			],
			type: 'multipart/alternative',
			parameters: { boundary: 'Apple-Mail-1' },
		};

		expect(toMessageParts(bodyStructure)).toStrictEqual([
			{
				partID: '1',
				type: 'text',
				subtype: 'plain',
				params: { charset: 'utf-8' },
				encoding: null,
				disposition: null,
			},
			{
				partID: '2',
				type: 'text',
				subtype: 'html',
				params: { charset: 'utf-8' },
				encoding: null,
				disposition: null,
			},
		]);
	});
});
