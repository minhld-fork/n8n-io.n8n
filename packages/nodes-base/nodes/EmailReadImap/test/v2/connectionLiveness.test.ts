import { EventEmitter } from 'events';
import type { IDataObject, INode, INodeTypeBaseDescription, ITriggerFunctions } from 'n8n-workflow';
import type { Mock } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { type ICredentialsDataImap } from '@credentials/Imap.credentials';

import { EmailReadImapV2 } from '../../v2/EmailReadImapV2.node';

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));

vi.mock('@n8n/imap', () => ({ connect: connectMock }));
vi.mock('../../v2/utils', () => ({ getNewEmails: vi.fn().mockResolvedValue(undefined) }));

const neverSettles = async <T>(): Promise<T> => await new Promise<T>(() => {});

const createConnection = () =>
	Object.assign(new EventEmitter(), {
		openBox: vi.fn().mockResolvedValue({}),
		end: vi.fn(),
		search: vi.fn().mockResolvedValue([]),
		getPartData: vi.fn(),
		addFlags: vi.fn().mockResolvedValue(undefined),
	});

type MockConnection = ReturnType<typeof createConnection>;

describe('EmailReadImapV2 connection liveness', () => {
	const staticData: IDataObject = {};

	const triggerFunctions = mock<ITriggerFunctions>({
		helpers: {
			createDeferredPromise: vi.fn().mockImplementation(() => {
				let resolve!: () => void;
				let reject!: (e: Error) => void;
				const promise = new Promise<void>((res, rej) => {
					resolve = res;
					reject = rej;
				});
				return { promise, resolve, reject };
			}),
		},
	});

	const credentials: ICredentialsDataImap = {
		host: 'imap.test.com',
		port: 993,
		user: 'user',
		password: 'password',
		secure: true,
		allowUnauthorizedCerts: false,
	};

	const baseDescription: INodeTypeBaseDescription = {
		displayName: 'EmailReadImapV2',
		name: 'emailReadImapV2',
		icon: 'fa:inbox',
		group: ['trigger'],
		description: 'Test',
	};

	/** Minutes; the node turns this into a setInterval. */
	const FORCE_RECONNECT = 1;
	const RECONNECT_INTERVAL_MS = FORCE_RECONNECT * 60_000;

	const startTrigger = async (options: IDataObject = { forceReconnect: FORCE_RECONNECT }) => {
		triggerFunctions.getNodeParameter.mockImplementation(((param: string) => {
			const values: Record<string, unknown> = {
				mailbox: 'INBOX',
				postProcessAction: 'nothing',
				options,
			};
			return values[param];
		}) as typeof triggerFunctions.getNodeParameter);

		return await new EmailReadImapV2(baseDescription).trigger.call(triggerFunctions);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		Object.keys(staticData).forEach((key) => delete staticData[key]);
		connectMock.mockReset();

		triggerFunctions.getCredentials.calledWith('imap').mockResolvedValue(credentials);
		triggerFunctions.getNode.mockReturnValue(mock<INode>({ typeVersion: 2.1 }));
		triggerFunctions.getWorkflowStaticData.calledWith('node').mockReturnValue(staticData);
		triggerFunctions.logger.debug = vi.fn();
		triggerFunctions.logger.error = vi.fn();
		triggerFunctions.logger.warn = vi.fn();
		(triggerFunctions as { emitError: Mock }).emitError = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	// Every test here mocks @n8n/imap wholesale, so nothing else would notice the node
	// dropping the options that make a wedged connection detectable.
	it('asks @n8n/imap to watch the connection for inactivity', async () => {
		connectMock.mockResolvedValueOnce(createConnection());

		await startTrigger();

		expect(connectMock).toHaveBeenCalledWith(
			expect.objectContaining({
				inactivityTimeout: expect.any(Number),
				imap: expect.objectContaining({ idleInterval: expect.any(Number) }),
			}),
		);
	});

	describe('forced reconnect against an unresponsive socket', () => {
		it('replaces the connection even when ending the dead one throws', async () => {
			const dead = createConnection();
			dead.end.mockImplementation(() => {
				throw new Error('connection already ended');
			});
			const fresh = createConnection();
			connectMock.mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);

			await startTrigger();
			await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS + 1_000);

			expect(dead.end).toHaveBeenCalled();
			expect(connectMock).toHaveBeenCalledTimes(2);
			expect(fresh.openBox).toHaveBeenCalledWith('INBOX');
		});

		it('reports the failure to the error workflow when re-establishing fails', async () => {
			const dead = createConnection();
			connectMock
				.mockResolvedValueOnce(dead)
				.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND imap.test.com'));

			await startTrigger();
			await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS + 60_000);

			expect(triggerFunctions.emitError).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining('ENOTFOUND') }),
			);
		});

		it('still reports an unexpected close while a reconnect is stuck', async () => {
			const dead = createConnection();
			connectMock.mockResolvedValueOnce(dead).mockImplementation(neverSettles);

			await startTrigger();
			await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS + 60_000);

			dead.emit('close', false);
			await vi.advanceTimersByTimeAsync(60_000);

			expect(triggerFunctions.emitError).toHaveBeenCalled();
		});
	});

	describe('closeFunction', () => {
		const settle = async (connection: MockConnection) => {
			connectMock.mockResolvedValueOnce(connection);

			const { closeFunction } = await startTrigger({});
			let settled = false;
			void closeFunction!().then(
				() => (settled = true),
				() => (settled = true),
			);
			await vi.advanceTimersByTimeAsync(120_000);
			return settled;
		};

		it('settles so deactivation cannot wedge', async () => {
			expect(await settle(createConnection())).toBe(true);
		});

		it('ends the connection', async () => {
			const connection = createConnection();
			await settle(connection);
			expect(connection.end).toHaveBeenCalled();
		});

		it('settles even when ending the connection throws', async () => {
			const connection = createConnection();
			connection.end.mockImplementation(() => {
				throw new Error('connection already ended');
			});

			expect(await settle(connection)).toBe(true);
			expect(connection.end).toHaveBeenCalled();
		});
	});
});
