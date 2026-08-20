import type { FlagsEvent, MessageStructureObject } from 'imapflow';
import type { ConnectionOptions } from 'tls';

export interface ImapSimpleOptions {
	imap: {
		user: string;
		password: string;
		host: string;
		port: number;
		tls?: boolean;
		tlsOptions?: ConnectionOptions;
		/** Milliseconds allowed to establish the connection and read the greeting. */
		authTimeout?: number;

		/**
		 * How often to break and restart IDLE. imapflow holds a single IDLE open
		 * indefinitely unless told otherwise, so leaving this unset means an idle
		 * connection exchanges no bytes at all and a dead one looks identical.
		 */
		idleInterval?: number;
	};

	/**
	 * Milliseconds to wait for a server response before treating the connection as
	 * dead, reporting `error` and closing.
	 *
	 * An open IDLE suspends this, so it only bites once IDLE is broken — which makes
	 * it useless without `idleInterval`, and puts worst-case detection at
	 * `idleInterval + inactivityTimeout`.
	 */
	inactivityTimeout?: number;

	/** Called with the number of newly arrived messages in the open mailbox. */
	onMail?: (numNewMail: number) => void;

	/** Called when message metadata (e.g. flags) changes externally. */
	onUpdate?: (info: FlagsEvent) => void;
}

/**
 * One leaf part of a message's MIME structure. Type, subtype, disposition and
 * parameter keys all arrive lowercased; `null` means the server sent nothing.
 */
export interface MessagePart {
	partID: string;
	/** Reported only; `getPartData` decodes without it. */
	encoding: string | null;
	type: string;
	subtype: string;
	params: Record<string, string> | null;
	disposition: {
		type: string;
		params: Record<string, string> | null;
	} | null;
}

export interface MessageBodyPart {
	/** The requested section: `''` for the whole message, `HEADER`, `TEXT`, or a part id. */
	which: string;
	size: number;
	/** Parsed object for `HEADER`, `Buffer` for the whole message, raw string otherwise. */
	body: string | Buffer | Record<string, string[]>;
}

export interface MessageAttributes {
	uid: number;
	flags: string[];
	date?: Date;
	size?: number;
	struct?: MessageStructureObject;
}

export interface Message {
	attributes: MessageAttributes;
	parts: MessageBodyPart[];
}

/** Which message sections to retrieve, in node-imap's vocabulary. */
export interface FetchOptions {
	/** Section names. `''` means the entire raw message. */
	bodies?: string[];
	/** Also retrieve the MIME structure into `attributes.struct`. */
	struct?: boolean;
}
