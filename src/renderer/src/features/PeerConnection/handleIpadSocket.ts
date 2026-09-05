import NullUser from './NullUser';

type IpadLifecycleSnapshot = {
	generation: number;
	sessionId: string | null;
	phase: string;
	ownerSocketId: string | null;
	viewer: { logicalViewerId: string; socketId: string } | null;
};

type IpadSignal = {
	type: string;
	payload: Record<string, unknown>;
	fromSocketID: string;
	generation: number;
	sessionId: string | null;
};

export default function handleIpadSocket(peerConnection: PeerConnection): void {
	peerConnection.socket.removeAllListeners();

	peerConnection.socket.on('disconnect', () => {
		peerConnection.selfDestroy('owner-socket-disconnect');
	});

	peerConnection.socket.on('error', (error: Error) => {
		console.error('iPad peerConnection socket error', error);
		peerConnection.selfDestroy('owner-socket-error');
	});

	peerConnection.socket.on('connect', () => {
		peerConnection.emitUserEnter();
	});

	peerConnection.socket.on('IPAD_LIFECYCLE', (state: IpadLifecycleSnapshot) => {
		if (state.sessionId !== peerConnection.sharingSessionID) return;
		peerConnection.ipadLifecycleGeneration = state.generation;
		peerConnection.ipadLifecycleSessionID = state.sessionId;
		if (state.ownerSocketId !== peerConnection.socket.id || !state.viewer) {
			peerConnection.partner = NullUser;
			return;
		}
		peerConnection.partner = {
			username: state.viewer.logicalViewerId,
			socketId: state.viewer.socketId,
		};
	});

	peerConnection.socket.on('IPAD_SIGNAL', (signal: IpadSignal) => {
		if (
			signal.sessionId !== peerConnection.sharingSessionID ||
			signal.generation !== peerConnection.ipadLifecycleGeneration
		) {
			return;
		}
		peerConnection.receiveEncryptedMessage(signal);
	});

	peerConnection.socket.on('IPAD_REJECTED', (payload: { reason?: string }) => {
		console.error(
			`iPad owner registration rejected: ${payload.reason ?? 'unknown'}`,
		);
		peerConnection.selfDestroy('owner-registration-rejected');
	});

	if (peerConnection.socket.connected) peerConnection.emitUserEnter();
}
