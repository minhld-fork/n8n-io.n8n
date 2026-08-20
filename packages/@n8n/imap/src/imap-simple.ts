import { EventEmitter } from 'events';
import type { ImapFlow, ListResponse, MailboxObject } from 'imapflow';

import { ConnectionLostError } from './errors';
import { toFetchQuery, toMessageBodyParts } from './fetch';
import { PartData } from './part-data';
import { toSearchObject, type SearchCriteria } from './search-criteria';
import type { FetchOptions, ImapSimpleOptions, Message, MessagePart } from './types';

const LOGOUT_GRACE_PERIOD = 2000;

/** imapflow issues one sequential partial FETCH per chunk; its 64 KB default is a lot of round trips. */
const DOWNLOAD_CHUNK_SIZE = 1024 * 1024;

export class ImapSimple extends EventEmitter {
	private readonly onMail: ImapSimpleOptions['onMail'];

	constructor(
		private readonly client: ImapFlow,
		options: Pick<ImapSimpleOptions, 'onMail' | 'onUpdate'> = {},
	) {
		super();

		this.client.on('error', (error: Error) => this.emit('error', error));
		this.client.on('close', () => this.emit('close'));

		this.onMail = options.onMail;
		if (options.onMail) {
			this.client.on('exists', ({ count, prevCount }) => {
				if (count > prevCount) this.notifyMail(count - prevCount);
			});
		}
		if (options.onUpdate) this.client.on('flags', options.onUpdate);
	}

	/**
	 * `onMail` may be async, and its rejection has to reach the `error` channel the
	 * caller listens on rather than escaping as an unhandled rejection.
	 */
	private notifyMail(count: number): void {
		try {
			void Promise.resolve(this.onMail?.(count)).catch((e: Error) => this.emit('error', e));
		} catch (e) {
			this.emit('error', e);
		}
	}

	/**
	 * imapflow settles some commands with a falsy value rather than rejecting when
	 * the connection dies under them, which would otherwise read as an empty result.
	 */
	private assertRan<T>(result: T | false | undefined, command: string): T {
		if (result === false || result === undefined) {
			if (!this.client.usable) throw new ConnectionLostError();
			throw new Error(`IMAP ${command} did not complete`);
		}
		return result;
	}

	/** A `HEADER` part's body comes back parsed into an object, the rest as sent. */
	async search(
		searchCriteria: SearchCriteria[],
		fetchOptions: FetchOptions,
		/** Fetch at most this many of the oldest matches. */
		limit?: number,
	): Promise<Message[]> {
		const found = await this.client.search(toSearchObject(searchCriteria), { uid: true });
		const uids = this.assertRan(Array.isArray(found) ? found : undefined, 'SEARCH');
		if (uids.length === 0) return [];

		// oldest first, because imapflow returns SEARCH results in ascending UID order
		const wanted = limit && limit > 0 ? uids.slice(0, limit) : uids;
		const messages: Message[] = [];

		for await (const message of this.client.fetch(wanted, toFetchQuery(fetchOptions), {
			uid: true,
		})) {
			messages.push({
				attributes: {
					uid: message.uid,
					flags: [...(message.flags ?? [])],
					date: message.internalDate ? new Date(message.internalDate) : undefined,
					size: message.size,
					struct: message.bodyStructure,
				},
				parts: toMessageBodyParts(message, fetchOptions),
			});
		}

		// `fetch` yields nothing at all when the mailbox went away under it, which
		// would otherwise read as "no new mail" and lose the batch silently.
		if (messages.length === 0 && !this.client.usable) throw new ConnectionLostError();

		return messages;
	}

	async getPartData(message: Message, part: MessagePart): Promise<PartData> {
		const downloaded = await this.client.download(String(message.attributes.uid), part.partID, {
			uid: true,
			chunkSize: DOWNLOAD_CHUNK_SIZE,
		});

		const content = this.assertRan(downloaded?.content, 'FETCH');

		const chunks: Buffer[] = [];
		for await (const chunk of content) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
		}

		return new PartData(Buffer.concat(chunks));
	}

	async addFlags(uids: number[], flags: string | string[]): Promise<void> {
		if (uids.length === 0) return;

		const applied = await this.client.messageFlagsAdd(
			uids.join(','),
			Array.isArray(flags) ? flags : [flags],
			{ uid: true },
		);

		// A matching-nothing STORE still reports true, so `false` is always a refusal —
		// a read-only mailbox, or one whose PERMANENTFLAGS omits the flag.
		this.assertRan(applied || undefined, 'STORE');
	}

	async getBoxes(): Promise<ListResponse[]> {
		const boxes = await this.client.list();
		if (boxes.length === 0 && !this.client.usable) throw new ConnectionLostError();
		return boxes;
	}

	async openBox(boxName: string): Promise<MailboxObject> {
		const opened = await this.client.mailboxOpen(boxName);
		const mailbox = this.assertRan(opened || undefined, 'SELECT');

		if (mailbox.exists > 0) this.notifyMail(mailbox.exists);

		return mailbox;
	}

	/** Disconnects. Returns immediately; the connection is gone shortly after. */
	end(): void {
		this.client.removeAllListeners();

		this.client.once('close', () => this.emit('close'));
		this.client.on('error', () => {});

		const teardown = setTimeout(() => this.client.close(), LOGOUT_GRACE_PERIOD);
		teardown.unref();

		void this.client
			.logout()
			.catch(() => this.client.close())
			.finally(() => clearTimeout(teardown));
	}
}
