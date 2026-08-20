/** Thrown when the connection died while a command was in flight, or before one could be sent. */
export class ConnectionLostError extends Error {
	constructor(
		/** Set only when a watchdog declared the loss, rather than the socket reporting it. */
		readonly inactivityTimeout?: number,
	) {
		let message = 'Connection to the IMAP server was lost';
		if (inactivityTimeout) {
			message += `. No data received for ${inactivityTimeout} ms`;
		}
		super(message);
	}
}
