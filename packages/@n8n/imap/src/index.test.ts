import { EventEmitter } from 'events';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { Socket } from 'net';

import { ConnectionLostError } from './errors';
import { connect, getParts } from './index';
import type { ImapSimpleOptions } from './types';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));

class FakeImapFlow extends EventEmitter {
	socket: Socket | undefined = undefined;

	connect = vi.fn().mockResolvedValue(undefined);

	close = vi.fn();

	constructor(readonly options: ImapFlowOptions) {
		super();
	}
}

const IDLE_INTERVAL = 1000;
const INACTIVITY_TIMEOUT = 4000;
const BACKSTOP_WINDOW = 1.25 * (IDLE_INTERVAL + INACTIVITY_TIMEOUT);

let client: FakeImapFlow;

const imapOptions = (overrides: Partial<ImapSimpleOptions['imap']> = {}) => ({
	user: 'user',
	password: 'password',
	host: 'imap.example.com',
	port: 993,
	tls: true,
	tlsOptions: { rejectUnauthorized: false },
	authTimeout: 20000,
	idleInterval: IDLE_INTERVAL,
	...overrides,
});

const openConnection = async (options: Partial<ImapSimpleOptions> = {}) =>
	await connect({
		imap: imapOptions(),
		inactivityTimeout: INACTIVITY_TIMEOUT,
		...options,
	});

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(ImapFlow).mockImplementation(function (options) {
		client = new FakeImapFlow(options);
		client.socket = new Socket();
		return client as unknown as ImapFlow;
	});
});

afterEach(() => vi.useRealTimers());

describe('connect', () => {
	it('maps the options onto imapflow', async () => {
		await openConnection();

		expect(client.options).toMatchObject({
			host: 'imap.example.com',
			port: 993,
			secure: true,
			tls: { rejectUnauthorized: false },
			auth: { user: 'user', pass: 'password' },
			maxIdleTime: IDLE_INTERVAL,
			socketTimeout: INACTIVITY_TIMEOUT,
			connectionTimeout: 20000,
			greetingTimeout: 20000,
		});
	});

	it('connects in the clear when tls is unset', async () => {
		await openConnection({ imap: imapOptions({ tls: undefined }) });

		expect(client.options.secure).toBe(false);
	});
});

describe('inactivity backstop', () => {
	const failuresOf = async (options: Partial<ImapSimpleOptions> = {}) => {
		const connection = await openConnection(options);
		const failures: Error[] = [];
		connection.on('error', (error: Error) => failures.push(error));
		return failures;
	};

	it('reports the connection lost once the socket falls silent', async () => {
		const failures = await failuresOf();

		await vi.advanceTimersByTimeAsync(BACKSTOP_WINDOW - 1);
		expect(failures).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(failures).toEqual([new ConnectionLostError(BACKSTOP_WINDOW)]);
		expect(client.close).toHaveBeenCalled();
	});

	it('leaves a socket that keeps receiving data alone', async () => {
		const failures = await failuresOf();

		for (let elapsed = 0; elapsed < 3 * BACKSTOP_WINDOW; elapsed += BACKSTOP_WINDOW - 1) {
			await vi.advanceTimersByTimeAsync(BACKSTOP_WINDOW - 1);
			client.socket?.emit('data', Buffer.from('* OK still here\r\n'));
		}

		expect(failures).toEqual([]);
		expect(client.close).not.toHaveBeenCalled();
	});

	it.each(['close', 'end'])('stops once the socket emits %s', async (event) => {
		const failures = await failuresOf();

		client.socket?.emit(event);
		await vi.advanceTimersByTimeAsync(2 * BACKSTOP_WINDOW);

		expect(failures).toEqual([]);
		expect(client.close).not.toHaveBeenCalled();
	});

	it('stays disarmed without an idleInterval, which imapflow needs to break IDLE', async () => {
		const failures = await failuresOf({ imap: imapOptions({ idleInterval: undefined }) });

		await vi.advanceTimersByTimeAsync(10 * BACKSTOP_WINDOW);

		expect(failures).toEqual([]);
		expect(client.close).not.toHaveBeenCalled();
	});

	it('stays disarmed without an inactivityTimeout', async () => {
		const failures = await failuresOf({ inactivityTimeout: undefined });

		await vi.advanceTimersByTimeAsync(10 * BACKSTOP_WINDOW);

		expect(failures).toEqual([]);
		expect(client.close).not.toHaveBeenCalled();
	});
});

describe('getParts', () => {
	it('returns nothing for a message without a structure', () => {
		expect(getParts(undefined)).toEqual([]);
	});

	it('flattens the structure into leaf parts', () => {
		expect(getParts({ type: 'text/plain', encoding: '7bit', size: 10 })).toMatchObject([
			{ partID: '1', type: 'text', subtype: 'plain' },
		]);
	});
});
