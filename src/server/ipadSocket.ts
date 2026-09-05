import type Io from 'socket.io';
import {
	acceptIpadInput,
	disconnectIpadSocket,
	getIpadLifecycleState,
	getIpadSignalTarget,
	markIpadStreaming,
	registerIpadOwner,
	registerIpadViewer,
	requestIpadNegotiation,
	requestIpadReset,
	isIpadTouchEnabled,
} from '../ipad-host/lifecycleRuntime';
import type { IpadInput } from '../ipad-host/lifecycleRuntime';
import socketsIPService from './socketsIPService';
import socketIOServerStore from './store/socketIOServerStore';

const IPAD_HOST_SOCKET_IP = '192.168.2.1';
const isDiagnosticsEnabled = process.env.IPAD_STALL_DIAGNOSTICS === '1';

type IpadSignal = {
	type: string;
	payload: Record<string, unknown>;
};

type IpadInputPayload = IpadInput & {
	generation: number;
	sessionId: string;
};

function isFiniteUnit(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseIpadInput(payload: unknown): IpadInputPayload | null {
	if (!payload || typeof payload !== 'object') return null;
	const candidate = payload as Record<string, unknown>;
	const action = candidate.action;
	if (
		action !== 'click' &&
		action !== 'down' &&
		action !== 'up' &&
		action !== 'drag' &&
		action !== 'scroll' &&
		action !== 'move' &&
		action !== 'mission_control' &&
		action !== 'space_left' &&
		action !== 'space_right'
	)
		return null;
	if (
		!isFiniteUnit(candidate.x) ||
		!isFiniteUnit(candidate.y) ||
		typeof candidate.generation !== 'number' ||
		!Number.isInteger(candidate.generation) ||
		candidate.generation < 0 ||
		typeof candidate.sessionId !== 'string' ||
		candidate.sessionId.length === 0
	)
		return null;
	if (action === 'scroll') {
		if (
			typeof candidate.deltaX !== 'number' ||
			typeof candidate.deltaY !== 'number' ||
			!Number.isFinite(candidate.deltaX) ||
			!Number.isFinite(candidate.deltaY) ||
			Math.abs(candidate.deltaX) > 1 ||
			Math.abs(candidate.deltaY) > 1
		)
			return null;
		return {
			action,
			x: candidate.x,
			y: candidate.y,
			deltaX: candidate.deltaX,
			deltaY: candidate.deltaY,
			generation: candidate.generation,
			sessionId: candidate.sessionId,
		};
	}
	if ('deltaX' in candidate || 'deltaY' in candidate) return null;
	return {
		action,
		x: candidate.x,
		y: candidate.y,
		generation: candidate.generation,
		sessionId: candidate.sessionId,
	};
}

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
		`[iPad Lifecycle] ${event} generation=${state.generation} session=${state.sessionId ?? 'none'} phase=${state.phase} owner=${state.ownerSocketId ?? 'none'} viewer=${state.viewer?.socketId ?? 'none'} logicalViewer=${state.viewer?.logicalViewerId ?? 'none'} document=${state.viewer?.documentId ?? 'none'} reset=${state.resetReason ?? 'none'}`,
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
		this.socket.emit('IPAD_TOUCH_CAPABILITY', {
			enabled: isIpadTouchEnabled(),
		});
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
			(payload: { logicalViewerId?: unknown; documentId?: unknown }) => {
				if (
					isOwnerSocket(this.socket) ||
					typeof payload?.logicalViewerId !== 'string' ||
					payload.logicalViewerId.length === 0 ||
					typeof payload?.documentId !== 'string' ||
					payload.documentId.length === 0
				) {
					this.socket.emit('IPAD_REJECTED', { reason: 'viewer-required' });
					return;
				}
				const result = registerIpadViewer(
					payload.logicalViewerId,
					payload.documentId,
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
				if (result.kind === 'viewer-document-replaced') {
					// A new document cannot answer for the old document's peer. Quiesce
					// the old document before advancing the shared generation.
					getSocketById(result.previousSocketId)?.emit('IPAD_SUPERSEDED', {
						generation: result.state.generation,
					});
					requestIpadReset(
						result.state.sessionId ?? '',
						'viewer-document-replaced',
					);
					logLifecycle(
						`viewer-document-replaced ${result.previousSocketId}->${this.socket.id}`,
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

		this.socket.on('IPAD_INPUT', (payload: unknown) => {
			if (!isIpadTouchEnabled() || isOwnerSocket(this.socket)) return;
			const input = parseIpadInput(payload);
			if (!input) return;
			const result = acceptIpadInput(
				this.socket.id,
				input.generation,
				input.sessionId,
				input,
			);
			logLifecycle(
				`input action=${input.action} socket=${this.socket.id} result=${result.kind}`,
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
