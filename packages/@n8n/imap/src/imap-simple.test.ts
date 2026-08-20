import { EventEmitter } from 'events';
import type { ImapFlow } from 'imapflow';
import { mock } from 'vitest-mock-extended';

import { ConnectionLostError } from './errors';
import { ImapSimple } from './imap-simple';
import type { ImapSimpleOptions, Message, MessagePart } from './types';

const LOGOUT_GRACE_PERIOD = 2000;

class FakeImapFlow extends EventEmitter {
	usable = true;

	search = vi.fn();

	fetch = vi.fn();

	download = vi.fn();

	messageFlagsAdd = vi.fn();

	list = vi.fn();

	mailboxOpen = vi.fn();

	logout = vi.fn().mockResolvedValue(true);

	close = vi.fn();
}

const setup = (options: Pick<ImapSimpleOptions, 'onMail' | 'onUpdate'> = {}) => {
	const client = new FakeImapFlow();
	const connection = new ImapSimple(client as unknown as ImapFlow, options);
	return { client, connection };
};

async function* yielding<T>(...values: T[]) {
	for (const value of values) yield value;
}

const aMessage = (uid: number): Message => ({ attributes: { uid, flags: [] }, parts: [] });

describe('search', () => {
	it('maps imapflow attributes onto the node-imap shape', async () => {
		const { client, connection } = setup();
		client.search.mockResolvedValue([7]);
		client.fetch.mockReturnValue(
			yielding({
				uid: 7,
				flags: new Set(['\\Seen']),
				internalDate: new Date('2024-01-02T03:04:05.000Z'),
				size: 128,
				bodyStructure: { type: 'text/plain' },
				bodyParts: new Map([['text', Buffer.from('hi')]]),
			}),
		);

		const messages = await connection.search(['UNSEEN'], { bodies: ['TEXT'], struct: true });

		expect(client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
		expect(messages).toEqual([
			{
				attributes: {
					uid: 7,
					flags: ['\\Seen'],
					date: new Date('2024-01-02T03:04:05.000Z'),
					size: 128,
					struct: { type: 'text/plain' },
				},
				parts: [{ which: 'TEXT', size: 2, body: 'hi' }],
			},
		]);
	});

	it('leaves the date unset when the server reports no internal date', async () => {
		const { client, connection } = setup();
		client.search.mockResolvedValue([7]);
		client.fetch.mockReturnValue(yielding({ uid: 7 }));

		const [message] = await connection.search(['ALL'], {});

		expect(message.attributes.date).toBeUndefined();
		expect(message.attributes.flags).toEqual([]);
	});

	it('fetches the oldest matches up to the limit', async () => {
		const { client, connection } = setup();
		client.search.mockResolvedValue([1, 2, 3, 4]);
		client.fetch.mockReturnValue(yielding({ uid: 1 }, { uid: 2 }));

		await connection.search(['ALL'], {}, 2);

		expect(client.fetch).toHaveBeenCalledWith([1, 2], expect.anything(), { uid: true });
	});

	it.each([undefined, 0])('fetches every match when the limit is %s', async (limit) => {
		const { client, connection } = setup();
		client.search.mockResolvedValue([1, 2, 3]);
		client.fetch.mockReturnValue(yielding({ uid: 1 }, { uid: 2 }, { uid: 3 }));

		await connection.search(['ALL'], {}, limit);

		expect(client.fetch).toHaveBeenCalledWith([1, 2, 3], expect.anything(), { uid: true });
	});

	it('does not fetch when the search matched nothing', async () => {
		const { client, connection } = setup();
		client.search.mockResolvedValue([]);

		await expect(connection.search(['ALL'], {})).resolves.toEqual([]);
		expect(client.fetch).not.toHaveBeenCalled();
	});

	it('returns nothing when the fetch yields nothing on a live connection', async () => {
		const { client, connection } = setup();
		client.search.mockResolvedValue([1]);
		client.fetch.mockReturnValue(yielding());

		await expect(connection.search(['ALL'], {})).resolves.toEqual([]);
	});

	it('throws ConnectionLostError when the fetch yields nothing on a dead connection', async () => {
		const { client, connection } = setup();
		client.search.mockResolvedValue([1]);
		client.fetch.mockReturnValue(yielding());
		client.usable = false;

		await expect(connection.search(['ALL'], {})).rejects.toThrow(ConnectionLostError);
	});

	it('throws ConnectionLostError when the search settles false on a dead connection', async () => {
		const { client, connection } = setup();
		client.search.mockResolvedValue(false);
		client.usable = false;

		await expect(connection.search(['ALL'], {})).rejects.toThrow(ConnectionLostError);
	});

	it('names the command when the search settles false on a live connection', async () => {
		const { client, connection } = setup();
		client.search.mockResolvedValue(false);

		await expect(connection.search(['ALL'], {})).rejects.toThrow('IMAP SEARCH did not complete');
	});
});

describe('getPartData', () => {
	const part = mock<MessagePart>({ partID: '2' });

	it('concatenates the downloaded chunks', async () => {
		const { client, connection } = setup();
		client.download.mockResolvedValue({
			content: yielding(Buffer.from('hello '), Buffer.from('world')),
		});

		const data = await connection.getPartData(aMessage(42), part);

		expect(client.download).toHaveBeenCalledWith('42', '2', expect.objectContaining({ uid: true }));
		expect(data.toString()).toBe('hello world');
	});

	it('accepts string chunks', async () => {
		const { client, connection } = setup();
		client.download.mockResolvedValue({ content: yielding('hello world') });

		const data = await connection.getPartData(aMessage(42), part);

		expect(data.toString()).toBe('hello world');
	});

	it('throws ConnectionLostError when the download has no content on a dead connection', async () => {
		const { client, connection } = setup();
		client.download.mockResolvedValue({});
		client.usable = false;

		await expect(connection.getPartData(aMessage(42), part)).rejects.toThrow(ConnectionLostError);
	});

	it('names the command when the download has no content on a live connection', async () => {
		const { client, connection } = setup();
		client.download.mockResolvedValue({});

		await expect(connection.getPartData(aMessage(42), part)).rejects.toThrow(
			'IMAP FETCH did not complete',
		);
	});
});

describe('addFlags', () => {
	it('stores the flags against the uids as a sequence set', async () => {
		const { client, connection } = setup();
		client.messageFlagsAdd.mockResolvedValue(true);

		await connection.addFlags([1, 2, 3], '\\Seen');

		expect(client.messageFlagsAdd).toHaveBeenCalledWith('1,2,3', ['\\Seen'], { uid: true });
	});

	it('does nothing without uids', async () => {
		const { client, connection } = setup();

		await connection.addFlags([], '\\Seen');

		expect(client.messageFlagsAdd).not.toHaveBeenCalled();
	});

	it('reports a store the server refused, such as a read-only mailbox', async () => {
		const { client, connection } = setup();
		client.messageFlagsAdd.mockResolvedValue(false);

		await expect(connection.addFlags([1], ['\\Seen'])).rejects.toThrow('STORE');
	});

	it('throws ConnectionLostError on a false result from a dead connection', async () => {
		const { client, connection } = setup();
		client.messageFlagsAdd.mockResolvedValue(false);
		client.usable = false;

		await expect(connection.addFlags([1], ['\\Seen'])).rejects.toThrow(ConnectionLostError);
	});
});

describe('getBoxes', () => {
	it('lists the mailboxes', async () => {
		const { client, connection } = setup();
		client.list.mockResolvedValue([{ path: 'INBOX' }]);

		await expect(connection.getBoxes()).resolves.toEqual([{ path: 'INBOX' }]);
	});
});

describe('openBox', () => {
	it('reports mail that was already in the mailbox', async () => {
		const onMail = vi.fn();
		const { client, connection } = setup({ onMail });
		client.mailboxOpen.mockResolvedValue({ path: 'INBOX', exists: 3 });

		await connection.openBox('INBOX');

		expect(onMail).toHaveBeenCalledWith(3);
	});

	it('stays quiet when the mailbox is empty', async () => {
		const onMail = vi.fn();
		const { client, connection } = setup({ onMail });
		client.mailboxOpen.mockResolvedValue({ path: 'INBOX', exists: 0 });

		await connection.openBox('INBOX');

		expect(onMail).not.toHaveBeenCalled();
	});

	it('names the command when the select does not complete', async () => {
		const { client, connection } = setup();
		client.mailboxOpen.mockResolvedValue(false);

		await expect(connection.openBox('INBOX')).rejects.toThrow('IMAP SELECT did not complete');
	});

	it('throws ConnectionLostError when the select does not complete on a dead connection', async () => {
		const { client, connection } = setup();
		client.mailboxOpen.mockResolvedValue(false);
		client.usable = false;

		await expect(connection.openBox('INBOX')).rejects.toThrow(ConnectionLostError);
	});
});

describe('events', () => {
	it('reports only the newly arrived messages', () => {
		const onMail = vi.fn();
		const { client } = setup({ onMail });

		client.emit('exists', { path: 'INBOX', count: 5, prevCount: 3 });

		expect(onMail).toHaveBeenCalledWith(2);
	});

	it.each([
		{ label: 'expunged', count: 2, prevCount: 3 },
		{ label: 'unchanged', count: 3, prevCount: 3 },
	])('ignores an exists event for $label messages', ({ count, prevCount }) => {
		const onMail = vi.fn();
		const { client } = setup({ onMail });

		client.emit('exists', { path: 'INBOX', count, prevCount });

		expect(onMail).not.toHaveBeenCalled();
	});

	it('forwards flag changes to onUpdate', () => {
		const onUpdate = vi.fn();
		const { client } = setup({ onUpdate });
		const event = { path: 'INBOX', seq: 1, flags: new Set(['\\Seen']) };

		client.emit('flags', event);

		expect(onUpdate).toHaveBeenCalledWith(event);
	});

	it.each(['error', 'close'])('forwards %s', (event) => {
		const { client, connection } = setup();
		const listener = vi.fn();
		connection.on(event, listener);

		client.emit(event, new Error('boom'));

		expect(listener).toHaveBeenCalled();
	});
});

describe('end', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('logs out', () => {
		const { client, connection } = setup();

		connection.end();

		expect(client.logout).toHaveBeenCalled();
	});

	it('forwards the final close', () => {
		const { client, connection } = setup();
		const closed = vi.fn();
		connection.on('close', closed);

		connection.end();
		client.emit('close');

		expect(closed).toHaveBeenCalled();
	});

	it('stops forwarding errors', () => {
		const { client, connection } = setup();
		const failed = vi.fn();
		connection.on('error', failed);

		connection.end();
		client.emit('error', new Error('socket died during teardown'));

		expect(failed).not.toHaveBeenCalled();
	});

	it('closes the connection when the logout never settles', async () => {
		const { client, connection } = setup();
		client.logout.mockReturnValue(new Promise(() => {}));

		connection.end();
		await vi.advanceTimersByTimeAsync(LOGOUT_GRACE_PERIOD);

		expect(client.close).toHaveBeenCalled();
	});

	it('closes the connection when the logout fails', async () => {
		const { client, connection } = setup();
		client.logout.mockRejectedValue(new Error('Connection not available'));

		connection.end();
		await vi.advanceTimersByTimeAsync(0);

		expect(client.close).toHaveBeenCalled();
	});

	it('leaves the connection to the server once the logout completes', async () => {
		const { client, connection } = setup();

		connection.end();
		await vi.advanceTimersByTimeAsync(LOGOUT_GRACE_PERIOD);

		expect(client.close).not.toHaveBeenCalled();
	});
});
