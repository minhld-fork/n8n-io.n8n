import { connect, ConnectionLostError } from '../src';
import { FakeImapServer } from './fake-imap-server';

/**
 * The reported failure is an IMAP connection that stops responding while its
 * socket stays ESTABLISHED.
 *
 * imapflow detects this, but only because `idleInterval` keeps breaking IDLE:
 * an open IDLE suspends `inactivityTimeout`, so without it a dead connection is
 * indistinguishable from a quiet one. These pin that pairing.
 */

const IDLE_INTERVAL = 500;
const INACTIVITY_TIMEOUT = 1_000;

const BACKSTOP_WINDOW = 1.25 * (IDLE_INTERVAL + INACTIVITY_TIMEOUT);

type Overrides = {
	inactivityTimeout?: number;
	onMail?: (count: number) => void;
};

function useFakeServer(secure: boolean) {
	let server: FakeImapServer;
	let port: number;

	beforeEach(async () => {
		server = new FakeImapServer(secure);
		port = await server.listen();
	});

	afterEach(async () => await server.close());

	return {
		get server() {
			return server;
		},
		open: async (overrides: Overrides = {}) =>
			await connect({
				imap: {
					user: 'user',
					password: 'password',
					host: '127.0.0.1',
					port,
					tls: secure,
					authTimeout: 5_000,
					idleInterval: IDLE_INTERVAL,
					...(secure ? { tlsOptions: { rejectUnauthorized: false, servername: 'localhost' } } : {}),
				},
				...overrides,
			}),
	};
}

const backstopFiresOnSilence = (fake: ReturnType<typeof useFakeServer>) => async () => {
	const connection = await fake.open({ inactivityTimeout: INACTIVITY_TIMEOUT });
	await connection.openBox('INBOX');

	const errored = new Promise<Error>((resolve) => connection.once('error', resolve));
	fake.server.silent = true;

	const error = await errored;

	expect(error).toBeInstanceOf(ConnectionLostError);
	expect(error.message).toContain(`No data received for ${BACKSTOP_WINDOW} ms`);
};

describe('unresponsive IMAP connection', () => {
	const fake = useFakeServer(false);

	it('completes a full connect -> openBox -> end round trip', async () => {
		const connection = await fake.open();

		await expect(connection.openBox('INBOX')).resolves.toBeDefined();
		connection.end();

		expect(fake.server.received.some((line) => line.includes('SELECT'))).toBe(true);
	});

	it('reports mail already in the mailbox on open, so a reconnect drains the backlog', async () => {
		const onEmpty: number[] = [];
		const empty = await fake.open({ onMail: (count) => onEmpty.push(count) });
		await empty.openBox('INBOX');
		empty.end();

		expect(onEmpty).toEqual([]);

		fake.server.exists = 3;

		const onBacklog: number[] = [];
		const backlog = await fake.open({ onMail: (count) => onBacklog.push(count) });
		await backlog.openBox('INBOX');
		backlog.end();

		// Exactly one notification: imapflow folded the SELECT's `* 3 EXISTS` into the
		// mailbox object without also emitting an `exists` event we would double-count.
		expect(onBacklog).toEqual([3]);
	});

	it('reports an error once the server stops responding', backstopFiresOnSilence(fake));

	it('closes the connection once the server stops responding', async () => {
		const connection = await fake.open({ inactivityTimeout: INACTIVITY_TIMEOUT });
		await connection.openBox('INBOX');

		const closed = new Promise<void>((resolve) => connection.once('close', () => resolve()));
		connection.on('error', () => {});
		fake.server.silent = true;

		await expect(closed).resolves.toBeUndefined();
	});

	it('leaves a connection alone while the server keeps talking', async () => {
		const connection = await fake.open({ inactivityTimeout: INACTIVITY_TIMEOUT });
		await connection.openBox('INBOX');

		const failures: string[] = [];
		connection.on('error', (e: Error) => failures.push(`error: ${e.message}`));
		connection.on('close', () => failures.push('close'));

		const heartbeat = setInterval(() => fake.server.pushUntagged('* OK still here'), 400);
		// Has to outlast the backstop window, or a backstop that ignored the heartbeat
		// would not have fired yet either.
		await new Promise((resolve) => setTimeout(resolve, BACKSTOP_WINDOW + 625));
		clearInterval(heartbeat);

		expect(failures).toEqual([]);
	});

	it('rejects a command instead of hanging when the server never answers', async () => {
		const connection = await fake.open({ inactivityTimeout: INACTIVITY_TIMEOUT });
		await connection.openBox('INBOX');
		connection.on('error', () => {});

		fake.server.silent = true;

		await expect(connection.openBox('INBOX')).rejects.toThrow();
	});
});

// The only package-specific difference TLS makes is `socketOf()`, which arms the
// backstop off an `instanceof Socket` check that a TLSSocket has to satisfy. One
// case that fails if it does not is enough; the rest run over plain TCP.
describe('unresponsive IMAP connection over TLS', () => {
	const fake = useFakeServer(true);

	it('reports an error once the server stops responding', backstopFiresOnSilence(fake));
});
