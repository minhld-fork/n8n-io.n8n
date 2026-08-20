import { ImapFlow, type MessageStructureObject } from 'imapflow';
import { Socket } from 'net';

import { toMessageParts } from './body-structure';
import { ConnectionLostError } from './errors';
import { ImapSimple } from './imap-simple';
import type { ImapSimpleOptions, MessagePart } from './types';

/**
 * A quarter beyond imapflow's own worst case (`idleInterval + inactivityTimeout`),
 * so the backstop only ever fires second, and still leaves multiples of the
 * `idleInterval` at which a healthy connection speaks.
 */
const BACKSTOP_FACTOR = 1.25;

/** imapflow does not declare its socket, and a TLSSocket satisfies this too. */
function socketOf(client: ImapFlow): Socket | undefined {
	if (!('socket' in client)) return undefined;
	const { socket } = client;
	return socket instanceof Socket ? socket : undefined;
}

/**
 * Bounds the one silence imapflow does not.
 *
 * Its `socketTimeout` recovers a stalled connection by running a NOOP, but a NOOP
 * queues behind the IDLE it is meant to rescue. That is fine once `maxIdleTime`
 * breaks IDLE — the DONE goes out and the timeout fires against it — but if the
 * connection dies after IDLE is written and before the server confirms it, nothing
 * ever settles and the stall is silent and permanent.
 */
function watchForInactivity(client: ImapFlow, socket: Socket, timeout: number) {
	let timer: NodeJS.Timeout | undefined;

	const stop = () => clearTimeout(timer);
	const restart = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			client.emit('error', new ConnectionLostError(timeout));
			client.close();
		}, timeout);
	};

	socket.on('data', restart);
	socket.once('close', stop);
	socket.once('end', stop);

	restart();
}

export async function connect(options: ImapSimpleOptions): Promise<ImapSimple> {
	const { imap } = options;

	const client = new ImapFlow({
		host: imap.host,
		port: imap.port,
		secure: imap.tls ?? false,
		tls: imap.tlsOptions,
		auth: { user: imap.user, pass: imap.password },
		maxIdleTime: imap.idleInterval,
		socketTimeout: options.inactivityTimeout,
		connectionTimeout: imap.authTimeout,
		greetingTimeout: imap.authTimeout,
		logger: false,
	});

	await client.connect();

	const { idleInterval } = imap;
	const socket = socketOf(client);
	if (idleInterval && options.inactivityTimeout && socket) {
		const window = BACKSTOP_FACTOR * (idleInterval + options.inactivityTimeout);
		watchForInactivity(client, socket, Math.round(window));
	}

	return new ImapSimple(client, options);
}

export function getParts(struct?: MessageStructureObject): MessagePart[] {
	return struct ? toMessageParts(struct) : [];
}

export { type SearchCriteria } from './search-criteria';
export * from './imap-simple';
export * from './errors';
export type * from './types';
