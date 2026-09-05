/*
 * original JS code from darkwire.io
 * translated to typescript for Deskreen app
 * by Pavlo (Paul) Buidenkov
 * */

import http from 'http';
import Koa from 'koa';
import crypto from 'crypto';
import { Server } from 'socket.io';
import cors from 'kcors';
import Router from 'koa-router';
import koaStatic from 'koa-static';
import koaSend from 'koa-send';
import detectPort from 'detect-port';
import config from '../common/config';
import startPollForInactiveRooms from './startPollForInactiveRooms';
import Logger from '../main/utils/LoggerWithFilePrefix';
import SocketsIPService from './socketsIPService';
import socketIOServerStore from './store/socketIOServerStore';
import DarkwireSocket from './darkwireSocket';
import getStore from './store';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import getMyLocalIpV4 from '../main/helpers/getMyLocalIpV4';
import { getClientViewerDistPath, getIpadViewerDistPath } from './getClientViewerDistPath';
import { setIpadLifecycleStateListener } from '../ipad-host/lifecycleRuntime';
import IpadSocket from './ipadSocket';

const { hostname, primaryPort, backupPort } = config;

// Check if running in iPad mode
const isIpadMode = process.env.IPAD_MODE === '1';
const IPAD_BIND_IP = '192.168.2.1';
const IPAD_PORT = 3131;

const getRoomIdHash = (id: string): string => {
	return crypto.createHash('sha256').update(id).digest('hex');
};

const ioHandleOnConnection = (socket): void => {
	const { roomId } = socket.handshake.query;
	const store = getStore();

	const installRoomHandlers = async (): Promise<void> => {
		if (!getDeskreenGlobal().roomIDService.isRoomIDTaken(roomId)) {
			socket.emit('NOT_ALLOWED');
			setTimeout(() => {
				socket.disconnect(true);
			}, 1000);
			return;
		}
		const roomIdHash = getRoomIdHash(roomId);
		if (isIpadMode) {
			new IpadSocket(socket, roomIdHash);
			return;
		}

		const storedRoom = await store.get('rooms', roomIdHash);
		const parsedRoom =
			typeof storedRoom === 'string' ? JSON.parse(storedRoom) : {};

		new DarkwireSocket({
			roomIdOriginal: roomId,
			roomId: roomIdHash,
			socket,
			room: parsedRoom as Room,
		});
	};

	if (isIpadMode) {
		// The private host helper follows Deskreen's immediate registration contract.
		void installRoomHandlers();
		return;
	}

	setTimeout(() => {
		void installRoomHandlers();
	}, 500); // timeout 500 millisecond for throttling malicious connections
};

function setStaticFileHeaders(
	ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>,
): void {
	ctx.set({
		'strict-transport-security': 'max-age=31536000',
		'X-Frame-Options': 'deny',
		'X-XSS-Protection': '1; mode=block',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Feature-Policy':
			"geolocation 'none'; vr 'none'; payment 'none'; microphone 'none'",
		// 'Cache-Control': 'max-age=0', // make browser get fresh files and make new connection when client connected
	});
}

class DeskreenSignalingServer {
	log = new Logger(__filename);

	server = {} as unknown as http.Server;

	hostname: string;

	primaryPort: number;

	backupPort: number;

	port: number;

	app: Koa | undefined;

	clientDistDirectory: string;

	constructor() {
		const localIp = getMyLocalIpV4();
		this.hostname = localIp || String(hostname);
		this.primaryPort = parseInt(primaryPort as unknown as string, 10);
		this.backupPort = parseInt(backupPort as unknown as string, 10);

		this.port = isIpadMode ? IPAD_PORT : this.primaryPort;

		// Use iPad viewer in iPad mode, otherwise use standard client viewer
		if (isIpadMode) {
			this.clientDistDirectory = getIpadViewerDistPath();
			if (this.clientDistDirectory) {
				this.log.info('Using iPad viewer bundle');
			} else {
				this.log.error('iPad viewer bundle is missing or incomplete');
			}
		} else {
			this.clientDistDirectory = getClientViewerDistPath();
		}

		if (!this.clientDistDirectory) {
			this.log.error(
				'Client viewer bundle is missing. Remote connections will fail.',
			);
		}

		this.init();
	}

	init(): void {
		this.app = new Koa();
		const router = new Router();

		this.app.use(cors());
		this.app.use(router.routes());

		const clientDistDirectory = this.clientDistDirectory;

		if (clientDistDirectory) {
			this.app.use(async (ctx, next) => {
				setStaticFileHeaders(ctx);
				await koaStatic(clientDistDirectory)(ctx, next);
			});

			this.app.use(async (ctx) => {
				setStaticFileHeaders(ctx);
				await koaSend(ctx, 'index.html', { root: clientDistDirectory });
			});
		} else {
			this.app.use(async (ctx) => {
				ctx.body = { ready: true };
			});
		}

		const protocol = http;

		this.server = protocol.createServer(this.app.callback());
		const io = new Server(this.server, {
			pingInterval: 20000,
			pingTimeout: 5000,
			serveClient: false,
		});

		io.sockets.on('connection', (socket) => {
			const socketId = socket.id;

			const clientIp = socket.request.socket.remoteAddress;
			SocketsIPService.setIPOfSocketID(socketId, clientIp || '');
			if (isIpadMode) {
				this.log.info(
					`[iPad Signaling] Socket.IO connected: ${socketId} from ${clientIp || 'unknown'}`,
				);
			}
		});

		io.on('connection', (socket) => {
			ioHandleOnConnection(socket);
		});

		socketIOServerStore.setServer(io);
		if (isIpadMode) {
			const ipadRoomHash = getRoomIdHash('ipad-main');
			setIpadLifecycleStateListener((state) => {
				io.to(ipadRoomHash).emit('IPAD_LIFECYCLE', state);
			});
		}
	}

	async start(): Promise<http.Server> {
		if (isIpadMode && !this.clientDistDirectory) {
			throw new Error('iPad viewer bundle is missing or incomplete');
		}
		startPollForInactiveRooms();
		this.server = await this.callListenOnHttpServer();
		return this.server;
	}

	listenCallback() {
		return () => {
			this.log.info(
				`Deskreen CE signaling server is online at port ${this.port}`,
			);
			this.log.info(
				`🌐 Server available at http://${this.hostname}:${this.port}`,
			);
		};
	}

	async callListenOnHttpServer(): Promise<http.Server> {
		return new Promise<http.Server>((resolve, reject) => {
			if (
				isIpadMode &&
				process.env.IPAD_BIND_IP &&
				process.env.IPAD_BIND_IP !== IPAD_BIND_IP
			) {
				reject(new Error(`iPad mode requires ${IPAD_BIND_IP}, not ${process.env.IPAD_BIND_IP}`));
				return;
			}
			const tryListen = (port: number, bindHost: string): void => {
				// Remove any previous error listeners
				this.server.removeAllListeners('error');

				// Set up error handler
				this.server.once('error', async (error: NodeJS.ErrnoException) => {
					if (error.code === 'EADDRINUSE' && port === this.primaryPort) {
						// In iPad mode, fail clearly instead of falling back
						if (isIpadMode) {
							this.log.error(`FATAL: Port ${port} is already in use`);
							this.log.error(`iPad mode requires exactly ${bindHost}:${port}`);
							this.log.error(`Please stop any other application using port ${port}`);
							reject(new Error(`Port ${port} is already in use - iPad mode requires this exact port`));
							return;
						}

						// Normal mode: try backup port
						this.log.error(`Port ${port} is already in use`);
						this.log.warn(
							`Port ${primaryPort} is in use. Trying backup port ${backupPort}...`,
						);

						try {
							const detectedBackupPort = await detectPort(backupPort);

							if (backupPort === detectedBackupPort) {
								this.log.info(`Backup port ${backupPort} is available.`);
								this.port = backupPort;
								tryListen(backupPort, bindHost);
							} else {
								const errorMsg = `Both primary port ${primaryPort} and backup port ${backupPort} are in use`;
								this.log.error(`Error: ${errorMsg}`);
								this.port = await detectPort();
								this.log.warn(`Using detected available port ${this.port}`);
								tryListen(this.port, bindHost);
							}
						} catch (err) {
							this.log.error(
								'An unexpected error occurred while detecting ports:',
								err,
							);
							reject(err);
						}
					} else if (error.code === 'EADDRNOTAVAIL') {
						// Address not available (e.g., 192.168.2.1 doesn't exist)
						this.log.error(`FATAL: Address ${bindHost} is not available`);
						this.log.error(`iPad mode requires this exact address for USB/private link`);
						reject(new Error(`Address ${bindHost} is not available - check network configuration`));
					} else {
						// Some other error
						this.log.error(`Failed to start server on ${bindHost}:${port}:`, error);
						reject(error);
					}
				});

				// Bind to specific IP (USB/private link) or all interfaces
				this.server.listen(port, bindHost, () => {
					this.listenCallback()();
					resolve(this.server);
				});
			};

			// In iPad mode, bind to the specific IP; otherwise bind to all interfaces
			const bindHost = isIpadMode ? IPAD_BIND_IP : '0.0.0.0';

			if (isIpadMode) {
				this.log.info(`iPad mode: binding to fixed address ${bindHost}:${this.port}`);
			}

			// Start with the primary port
			tryListen(this.port, bindHost);
		});
	}

	stop(): void {
		this.server.close();
	}
}

export const signalingServer = new DeskreenSignalingServer();
