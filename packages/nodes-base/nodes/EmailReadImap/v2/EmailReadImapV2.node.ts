import type { ICredentialsDataImap } from '@credentials/Imap.credentials';
import { isCredentialsDataImap } from '@credentials/Imap.credentials';
import type {
	ImapSimple,
	ImapSimpleOptions,
	Message,
	MessagePart,
	SearchCriteria,
} from '@n8n/imap';
import { connect as imapConnect } from '@n8n/imap';
import isEmpty from 'lodash/isEmpty';
import { DateTime } from 'luxon';
import type {
	ITriggerFunctions,
	IBinaryData,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	INodeCredentialTestResult,
	INodeType,
	INodeTypeBaseDescription,
	INodeTypeDescription,
	ITriggerResponse,
	JsonObject,
	INodeExecutionData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, OperationalError } from 'n8n-workflow';

import { getNewEmails } from './utils';

/** After this, a forced reconnect is reported so n8n can re-activate the trigger. */
const RECONNECT_TIMEOUT = 45_000;

/** How often IDLE is broken and restarted, and so the longest a healthy connection stays silent. */
const IDLE_INTERVAL = 120_000;

/**
 * How long a silent server is tolerated once IDLE has been broken. Worst-case
 * detection is therefore `IDLE_INTERVAL + INACTIVITY_TIMEOUT`.
 */
const INACTIVITY_TIMEOUT = 120_000;

const withTimeout = async <T>(operation: Promise<T>, ms: number, message: string): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new OperationalError(message)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

const toError = (value: unknown): Error =>
	value instanceof Error ? value : new Error(String(value));

const versionDescription: INodeTypeDescription = {
	displayName: 'Email Trigger (IMAP)',
	name: 'emailReadImap',
	icon: 'fa:inbox',
	iconColor: 'green',
	group: ['trigger'],
	version: [2, 2.1, 2.2],
	description: 'Triggers the workflow when a new email is received',
	eventTriggerDescription: 'Waiting for you to receive an email',
	defaults: {
		name: 'Email Trigger (IMAP)',
		color: '#44AA22',
	},
	triggerPanel: {
		header: '',
		executionsHelp: {
			inactive:
				"<b>While building your workflow</b>, click the 'execute step' button, then send an email to make an event happen. This will trigger an execution, which will show up in this editor.<br /> <br /><b>Once you're happy with your workflow</b>, publish it. Then every time an email is received, the workflow will execute. These executions will show up in the <a data-key='executions'>executions list</a>, but not in the editor.",
			active:
				"<b>While building your workflow</b>, click the 'execute step' button, then send an email to make an event happen. This will trigger an execution, which will show up in this editor.<br /> <br /><b>Your workflow will also execute automatically</b>, since it's activated. Every time an email is received, this node will trigger an execution. These executions will show up in the <a data-key='executions'>executions list</a>, but not in the editor.",
		},
		activationHint:
			'Once you’ve finished building your workflow, publish it to have it also listen continuously (you just won’t see those executions here).',
	},
	inputs: [],
	outputs: [NodeConnectionTypes.Main],
	credentials: [
		{
			name: 'imap',
			required: true,
			testedBy: 'imapConnectionTest',
		},
	],
	properties: [
		{
			displayName: 'Mailbox Name',
			name: 'mailbox',
			type: 'string',
			default: 'INBOX',
		},
		{
			displayName: 'Action',
			name: 'postProcessAction',
			type: 'options',
			options: [
				{
					name: 'Mark as Read',
					value: 'read',
				},
				{
					name: 'Nothing',
					value: 'nothing',
				},
			],
			default: 'read',
			description:
				'What to do after the email has been received. If "nothing" gets selected it will be processed multiple times.',
		},
		{
			displayName: 'Download Attachments',
			name: 'downloadAttachments',
			type: 'boolean',
			default: false,
			displayOptions: {
				show: {
					format: ['simple'],
				},
			},
			description:
				'Whether attachments of emails should be downloaded. Only set if needed as it increases processing.',
		},
		{
			displayName: 'Format',
			name: 'format',
			type: 'options',
			options: [
				{
					name: 'RAW',
					value: 'raw',
					description:
						'Returns the full email message data with body content in the raw field as a base64url encoded string; the payload field is not used',
				},
				{
					name: 'Resolved',
					value: 'resolved',
					description:
						'Returns the full email with all data resolved and attachments saved as binary data',
				},
				{
					name: 'Simple',
					value: 'simple',
					description:
						'Returns the full email; do not use if you wish to gather inline attachments',
				},
			],
			default: 'simple',
			description: 'The format to return the message in',
		},
		{
			displayName: 'Property Prefix Name',
			name: 'dataPropertyAttachmentsPrefixName',
			type: 'string',
			default: 'attachment_',
			displayOptions: {
				show: {
					format: ['resolved'],
				},
			},
			description:
				'Prefix for name of the binary property to which to write the attachments. An index starting with 0 will be added. So if name is "attachment_" the first attachment is saved to "attachment_0"',
		},
		{
			displayName: 'Property Prefix Name',
			name: 'dataPropertyAttachmentsPrefixName',
			type: 'string',
			default: 'attachment_',
			displayOptions: {
				show: {
					format: ['simple'],
					downloadAttachments: [true],
				},
			},
			description:
				'Prefix for name of the binary property to which to write the attachments. An index starting with 0 will be added. So if name is "attachment_" the first attachment is saved to "attachment_0"',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add option',
			default: {},
			options: [
				{
					displayName: 'Custom Email Rules',
					name: 'customEmailConfig',
					type: 'string',
					default: '["UNSEEN"]',
					description:
						'Custom email fetching rules. See <a href="https://github.com/mscdex/node-imap">node-imap</a>\'s search function for more details.',
				},
				{
					displayName: 'Force Reconnect Every Minutes',
					name: 'forceReconnect',
					type: 'number',
					default: 60,
					description:
						'Not needed for reliability, as the connection is monitored and re-established automatically. Only useful for servers that enforce a maximum connection age.',
				},
				{
					displayName: 'Fetch Only New Emails',
					name: 'trackLastMessageId',
					type: 'boolean',
					default: true,
					description:
						'Whether to fetch only new emails since the last run, or all emails that match the "Custom Email Rules" (["UNSEEN"] by default)',
					displayOptions: {
						show: {
							'@version': [{ _cnd: { gte: 2.1 } }],
						},
					},
				},
			],
		},
	],
};

export class EmailReadImapV2 implements INodeType {
	description: INodeTypeDescription;

	constructor(baseDescription: INodeTypeBaseDescription) {
		this.description = {
			...baseDescription,
			...versionDescription,
		};
	}

	methods = {
		credentialTest: {
			async imapConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				if (isCredentialsDataImap(credential.data)) {
					const credentials = credential.data as ICredentialsDataImap;
					try {
						const config: ImapSimpleOptions = {
							imap: {
								user: credentials.user,
								password: credentials.password,
								host: credentials.host.trim(),
								port: credentials.port,
								tls: credentials.secure,
								authTimeout: 20000,
							},
						};
						const tlsOptions: IDataObject = {};

						if (credentials.allowUnauthorizedCerts) {
							tlsOptions.rejectUnauthorized = false;
						}

						if (credentials.secure) {
							tlsOptions.servername = credentials.host.trim();
						}
						if (!isEmpty(tlsOptions)) {
							config.imap.tlsOptions = tlsOptions;
						}
						const connection = await imapConnect(config);
						await connection.getBoxes();
						connection.end();
					} catch (error) {
						return {
							status: 'Error',
							message: (error as Error).message,
						};
					}
					return {
						status: 'OK',
						message: 'Connection successful!',
					};
				} else {
					return {
						status: 'Error',
						message: 'Credentials are no IMAP credentials.',
					};
				}
			},
		},
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const node = this.getNode();
		const credentialsObject = await this.getCredentials('imap');
		const credentials = isCredentialsDataImap(credentialsObject) ? credentialsObject : undefined;
		if (!credentials) {
			throw new NodeOperationError(this.getNode(), 'Credentials are not valid for imap node.');
		}
		const mailbox = this.getNodeParameter('mailbox') as string;
		const postProcessAction = this.getNodeParameter('postProcessAction') as string;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const activatedAt = DateTime.now();

		const staticData = this.getWorkflowStaticData('node');
		if (node.typeVersion <= 2) {
			// before v 2.1 staticData.lastMessageUid was never set, preserve that behavior
			staticData.lastMessageUid = undefined;
		}

		if (options.trackLastMessageId === false) {
			staticData.lastMessageUid = undefined;
		}

		this.logger.debug('Loaded static data for node "EmailReadImap"', { staticData });

		let connection: ImapSimple;
		let closeFunctionWasCalled = false;
		/** Connections the node itself threw away; their `close` is expected, not a failure. */
		const discardedConnections = new WeakSet<ImapSimple>();

		const getText = async (
			parts: MessagePart[],
			message: Message,
			subtype: string,
		): Promise<string> => {
			if (!message.attributes.struct) {
				return '';
			}

			const textParts = parts.filter((part) => {
				return (
					part.type.toUpperCase() === 'TEXT' && part.subtype.toUpperCase() === subtype.toUpperCase()
				);
			});

			const part = textParts[0];
			if (!part) {
				return '';
			}

			try {
				const partData = await connection.getPartData(message, part);
				return partData.toString();
			} catch {
				return '';
			}
		};

		const getAttachment = async (
			imapConnection: ImapSimple,
			parts: MessagePart[],
			message: Message,
		): Promise<IBinaryData[]> => {
			if (!message.attributes.struct) {
				return [];
			}

			// Check if the message has attachments and if so get them
			const attachmentParts = parts.filter(
				(part) => part.disposition?.type?.toUpperCase() === 'ATTACHMENT',
			);

			const attachmentPromises = [];
			let attachmentPromise;
			for (const attachmentPart of attachmentParts) {
				attachmentPromise = imapConnection
					.getPartData(message, attachmentPart)
					.then(async (partData) => {
						const fileName = attachmentPart.disposition?.params?.filename;
						return await this.helpers.prepareBinaryData(partData.buffer, fileName);
					});

				attachmentPromises.push(attachmentPromise);
			}

			return await Promise.all(attachmentPromises);
		};

		const returnedPromise = this.helpers.createDeferredPromise();

		const establishConnection = async (): Promise<ImapSimple> => {
			let searchCriteria: SearchCriteria[] = ['UNSEEN'];
			if (options.customEmailConfig !== undefined) {
				try {
					searchCriteria = JSON.parse(options.customEmailConfig as string) as SearchCriteria[];
				} catch (error) {
					throw new NodeOperationError(this.getNode(), 'Custom email config is not valid JSON.');
				}
			}

			const config: ImapSimpleOptions = {
				imap: {
					user: credentials.user,
					password: credentials.password,
					host: credentials.host.trim(),
					port: credentials.port,
					tls: credentials.secure,
					authTimeout: 20000,
					idleInterval: IDLE_INTERVAL,
				},
				inactivityTimeout: INACTIVITY_TIMEOUT,
				onMail: async (numEmails) => {
					this.logger.debug('New emails received in node "EmailReadImap"', {
						numEmails,
					});

					if (connection) {
						// Create a fresh copy to avoid accumulating filters across calls
						const currentSearchCriteria = [...searchCriteria];

						/**
						 * Only process new emails:
						 * - If we've seen emails before (lastMessageUid is set), fetch messages higher UID.
						 * - Otherwise, fetch emails received since the workflow activation date.
						 *
						 * Note: IMAP 'SINCE' only filters by date (not time),
						 * so it may include emails from earlier on the activation day.
						 */
						if (staticData.lastMessageUid !== undefined) {
							/**
							 * A short explanation about UIDs and how they work
							 * can be found here: https://dev.to/kehers/imap-new-messages-since-last-check-44gm
							 * TL;DR:
							 * - You cannot filter using ['UID', 'CURRENT ID + 1:*'] because IMAP
							 * won't return correct results if current id + 1 does not yet exist.
							 * - UIDs can change but this is not being treated here.
							 * If the mailbox is recreated (lets say you remove all emails, remove
							 * the mail box and create another with same name, UIDs will change)
							 * - You can check if UIDs changed in the above example
							 * by checking UIDValidity.
							 */
							currentSearchCriteria.push(['UID', `${staticData.lastMessageUid as number}:*`]);
						} else if (node.typeVersion > 2 && options.trackLastMessageId !== false) {
							currentSearchCriteria.push(['SINCE', activatedAt.toFormat('dd-LLL-yyyy')]);
						}

						this.logger.debug('Querying for new messages on node "EmailReadImap"', {
							searchCriteria: currentSearchCriteria,
						});

						try {
							await getNewEmails.call(this, {
								imapConnection: connection,
								searchCriteria: currentSearchCriteria,
								postProcessAction,
								getText,
								getAttachment,
								onEmailBatch: async (returnData: INodeExecutionData[]) => {
									if (returnData.length) {
										this.emit([returnData]);
									}
								},
							});
						} catch (error) {
							this.logger.error('Email Read Imap node encountered an error fetching new emails', {
								error: error as Error,
							});
							// Wait with resolving till the returnedPromise got resolved, else n8n will be unhappy
							// if it receives an error before the workflow got activated
							await returnedPromise.promise.then(() => {
								this.emitError(error as Error);
							});
						}
					}
				},
				onUpdate: (info) => {
					this.logger.debug(`Email Read Imap:update ${info.seq}`, { uid: info.uid });
				},
			};

			const tlsOptions: IDataObject = {};

			if (credentials.allowUnauthorizedCerts) {
				tlsOptions.rejectUnauthorized = false;
			}

			if (credentials.secure) {
				tlsOptions.servername = credentials.host.trim();
			}

			if (!isEmpty(tlsOptions)) {
				config.imap.tlsOptions = tlsOptions;
			}

			return await imapConnect(config).then((conn) => {
				let errorReported = false;

				conn.on('close', () => {
					if (closeFunctionWasCalled) {
						this.logger.debug('Email Read Imap: Shutting down workflow - connected closed');
					} else if (discardedConnections.has(conn)) {
						this.logger.debug('Email Read Imap: Connected closed for forced reconnecting');
					} else if (!errorReported) {
						this.logger.error('Email Read Imap: Connected closed unexpectedly');
						this.emitError(
							new NodeOperationError(this.getNode(), 'IMAP connection closed unexpectedly', {
								description:
									'The IMAP server closed the connection without reporting an error, usually because the server (or a proxy/firewall) periodically closes long-lived connections, or was temporarily unavailable. n8n will automatically retry reactivating the workflow.',
							}),
						);
					}
					conn.removeAllListeners();
				});
				conn.on('error', (error) => {
					const errorCode =
						((error as JsonObject).code as string | undefined)?.toUpperCase() ?? 'UNKNOWN';
					this.logger.debug(`IMAP connection experienced an error: (${errorCode})`, {
						error: error as Error,
					});
					errorReported = true;
					this.emitError(error as Error);
				});
				return conn;
			});
		};

		connection = await establishConnection();

		await connection.openBox(mailbox);

		let reconnectionTimer: NodeJS.Timeout | undefined;
		let reconnectAttempt = 0;

		/** Never rejects; `end()` is reached even when the server is unresponsive. */
		const disconnect = async (target: ImapSimple) => {
			discardedConnections.add(target);
			try {
				target.end();
			} catch (error) {
				this.logger.warn('Email Read Imap: Could not end the connection cleanly', {
					error: toError(error),
				});
			}
		};

		const reconnect = async (attempt: number) => {
			await disconnect(connection);
			const fresh = await establishConnection();
			// A timed-out attempt keeps running; its late connection must not replace a newer one.
			if (attempt !== reconnectAttempt || closeFunctionWasCalled) {
				await disconnect(fresh);
				return;
			}
			connection = fresh;
			await connection.openBox(mailbox);
		};

		const handleReconnect = async () => {
			reconnectAttempt += 1;
			this.logger.debug('Forcing reconnect to IMAP server');
			try {
				await withTimeout(
					reconnect(reconnectAttempt),
					RECONNECT_TIMEOUT,
					'Reconnecting to the IMAP server timed out',
				);
			} catch (error) {
				this.logger.error('Email Read Imap: Forced reconnect failed', { error: toError(error) });
				this.emitError(toError(error));
			}
		};

		// Rearmed only once an attempt has settled, so a slow or abandoned reconnect
		// can never stack up behind the next tick.
		const scheduleForcedReconnect = (interval: number) => {
			reconnectionTimer = setTimeout(() => {
				void handleReconnect().then(() => {
					if (!closeFunctionWasCalled) scheduleForcedReconnect(interval);
				});
			}, interval);
		};

		if (options.forceReconnect !== undefined) {
			scheduleForcedReconnect((options.forceReconnect as number) * 1000 * 60);
		}

		// An unreachable mail server must never be able to block deactivation, so
		// teardown failures are logged instead of thrown.
		const closeFunction = async () => {
			closeFunctionWasCalled = true;
			clearTimeout(reconnectionTimer);
			await disconnect(connection);
		};

		// Resolve returned-promise so that waiting errors can be emitted
		returnedPromise.resolve();

		return {
			closeFunction,
		};
	}
}
