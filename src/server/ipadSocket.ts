import type Io from 'socket.io';
import {
	disconnectIpadSocket,
	getIpadLifecycleState,
	getIpadSignalTarget,
	markIpadStreaming,
	registerIpadOwner,
	registerIpadViewer,
	requestIpadNegotiation,
} from '../ipad-host/lifecycleRuntime';
import socketsIPService from './socketsIPService';
import socketIOServerStore from './store/socketIOServerStore';

const IPAD_HOST_SOCKET_IP = '192.168.2.1';
const isDiagnosticsEnabled = process.env.IPAD_STALL_DIAGNOSTICS === '1';

type IpadSignal = {
	type: string;
	payload: Record<string, unknown>;
};

function isOwnerSocket(socket: Io.Socket): boolean {
	const remoteAddress = socket.request.socket.remoteAddress ?? '';
	return (
		remoteAddress === IPAD_HOST_SOCKET_IP ||
		remoteAddress === `::ffff:${IPAD_HOST_SOCKET_IP}`
	);
}

function getSocketById(socketId: string): Io.Socket | undefined {
	const sockets = socketIOServerStore.getServer().sockets.sockets;
	// Socket.IO v4 uses a Map. Keep the fallback for the app's older typed
	// surface without making direct iPad routing depend on room broadcasts.
	if (typeof sockets.get === 'function')
		return sockets.get(socketId) as Io.Socket | undefined;
	return (sockets as unknown as Record<string, Io.Socket>)[socketId];
}

function logLifecycle(event: string): void {
	if (!isDiagnosticsEnabled) return;
	const state = getIpadLifecycleState();
	console.log(
		`[iPad Lifecycle] ${event} generation=${state.generation} session=${state.sessionId ?? 'none'} phase=${state.phase} owner=${state.ownerSocketId ?? 'none'} viewer=${state.viewer?.socketId ?? 'none'} logicalViewer=${state.viewer?.logicalViewerId ?? 'none'} reset=${state.resetReason ?? 'none'}`,
	);
}

/** iPad-only protocol. Generic Deskreen continues to use DarkwireSocket. */
export default class IpadSocket {
	constructor(
		private readonly socket: Io.Socket,
		private readonly roomId: string,
	) {
		this.socket.join(this.roomId);
		this.installHandlers();
	}

	private installHandlers(): void {
		this.socket.on('GET_MY_IP', (acknowledge: (ip: string) => void) => {
			acknowledge(socketsIPService.getSocketIPByID(this.socket.id) ?? '');
		});

		this.socket.on(
			'GET_IP_BY_SOCKET_ID',
			(socketId: string, acknowledge: (ip: string) => void) => {
				if (!isOwnerSocket(this.socket)) return;
				acknowledge(socketsIPService.getSocketIPByID(socketId) ?? '');
			},
		);

		this.socket.on(
			'IPAD_REGISTER_OWNER',
			(payload: { sessionId?: unknown }) => {
				if (
					!isOwnerSocket(this.socket) ||
					typeof payload?.sessionId !== 'string'
				) {
					this.socket.emit('IPAD_REJECTED', { reason: 'owner-required' });
					return;
				}
				const result = registerIpadOwner(payload.sessionId, this.socket.id);
				if (result.kind === 'rejected' || result.kind === 'ignored') {
					this.socket.emit('IPAD_REJECTED', { reason: result.reason });
				}
				logLifecycle(
					`owner-register socket=${this.socket.id} result=${result.kind}`,
				);
			},
		);

		this.socket.on(
			'IPAD_REGISTER_VIEWER',
			(payload: { logicalViewerId?: unknown }) => {
				if (
					isOwnerSocket(this.socket) ||
					typeof payload?.logicalViewerId !== 'string' ||
					payload.logicalViewerId.length === 0
				) {
					this.socket.emit('IPAD_REJECTED', { reason: 'viewer-required' });
					return;
				}
				const result = registerIpadViewer(
					payload.logicalViewerId,
					this.socket.id,
				);
				if (result.kind === 'rejected' || result.kind === 'ignored') {
					this.socket.emit('IPAD_REJECTED', { reason: result.reason });
				}
				if (result.kind === 'viewer-replaced') {
					const oldSocket = getSocketById(result.previousSocketId);
					oldSocket?.emit('IPAD_SUPERSEDED', {
						generation: result.state.generation,
					});
					logLifecycle(
						`viewer-replaced ${result.previousSocketId}->${this.socket.id}`,
					);
				}
				logLifecycle(
					`viewer-register socket=${this.socket.id} result=${result.kind}`,
				);
			},
		);

		this.socket.on(
			'IPAD_DEVICE_DETAILS',
			(payload: Record<string, unknown>) => {
				const result = requestIpadNegotiation(this.socket.id);
				if (result.kind !== 'start-negotiation') {
					logLifecycle(
						`device-details socket=${this.socket.id} result=${result.kind}`,
					);
					return;
				}
				const ownerSocketId = result.state.ownerSocketId;
				if (!ownerSocketId) return;
				this.emitSignal(ownerSocketId, 'DEVICE_DETAILS', payload, result.state);
				logLifecycle(`negotiation-started viewer=${this.socket.id}`);
			},
		);

		this.socket.on('IPAD_SIGNAL', (signal: IpadSignal) => {
			if (!signal || typeof signal.type !== 'string' || !signal.payload) return;
			const result = getIpadSignalTarget(this.socket.id, signal.type);
			if (!result.targetSocketId) {
				logLifecycle(
					`signal type=${signal.type} socket=${this.socket.id} result=${result.kind}`,
				);
				return;
			}
			if (signal.type === 'CALL_ACCEPTED') markIpadStreaming(this.socket.id);
			this.emitSignal(
				result.targetSocketId,
				signal.type,
				signal.payload,
				result.state,
			);
		});

		this.socket.on('disconnect', () => {
			const result = disconnectIpadSocket(this.socket.id, 'socket-disconnect');
			logLifecycle(`disconnect socket=${this.socket.id} result=${result.kind}`);
		});
	}

	private emitSignal(
		targetSocketId: string,
		type: string,
		payload: Record<string, unknown>,
		state: ReturnType<typeof getIpadLifecycleState>,
	): void {
		getSocketById(targetSocketId)?.emit('IPAD_SIGNAL', {
			type,
			payload,
			fromSocketID: this.socket.id,
			generation: state.generation,
			sessionId: state.sessionId,
		});
	}
}
