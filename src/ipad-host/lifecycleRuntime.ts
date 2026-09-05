import {
	IpadLifecycleCoordinator,
	type IpadLifecycleResult,
	type IpadLifecycleState,
} from './lifecycle';

const coordinator = new IpadLifecycleCoordinator();

let resetHandler: ((sessionId: string, reason: string) => void) | null = null;
let stateListener:
	| ((state: IpadLifecycleState, result: IpadLifecycleResult) => void)
	| null = null;
const isDiagnosticsEnabled = process.env.IPAD_STALL_DIAGNOSTICS === '1';

function publish(result: IpadLifecycleResult): IpadLifecycleResult {
	if (isDiagnosticsEnabled) {
		const state = result.state;
		const replacement =
			result.kind === 'viewer-replaced'
				? ` replace=${result.previousSocketId}->${state.viewer?.socketId ?? 'none'}`
				: result.kind === 'viewer-document-replaced'
					? ` document-replace=${result.previousSocketId}`
					: '';
		console.log(
			`[iPad Lifecycle] event=${result.kind}${replacement} generation=${state.generation} session=${state.sessionId ?? 'none'} phase=${state.phase} owner=${state.ownerSocketId ?? 'none'} logicalViewer=${state.viewer?.logicalViewerId ?? 'none'} document=${state.viewer?.documentId ?? 'none'} viewer=${state.viewer?.socketId ?? 'none'} reset=${state.resetReason ?? 'none'}`,
		);
	}
	stateListener?.(result.state, result);
	if (result.kind === 'start-reset') {
		resetHandler?.(result.sessionId, result.reason);
	}
	return result;
}

export function getIpadLifecycleState(): IpadLifecycleState {
	return coordinator.getState();
}

export function setIpadLifecycleResetHandler(
	handler: (sessionId: string, reason: string) => void,
): void {
	resetHandler = handler;
}

export function setIpadLifecycleStateListener(
	listener: (state: IpadLifecycleState, result: IpadLifecycleResult) => void,
): void {
	stateListener = listener;
}

export function startIpadLifecycleSession(
	sessionId: string,
): IpadLifecycleResult {
	return publish(coordinator.startSession(sessionId));
}

export function registerIpadOwner(
	sessionId: string,
	socketId: string,
): IpadLifecycleResult {
	return publish(coordinator.registerOwner(sessionId, socketId));
}

export function registerIpadViewer(
	logicalViewerId: string,
	documentId: string,
	socketId: string,
): IpadLifecycleResult {
	return publish(
		coordinator.registerViewer(logicalViewerId, documentId, socketId),
	);
}

export function requestIpadNegotiation(socketId: string): IpadLifecycleResult {
	return publish(coordinator.requestNegotiation(socketId));
}

export function getIpadSignalTarget(
	socketId: string,
	type: string,
): IpadLifecycleResult & { targetSocketId?: string } {
	return coordinator.getSignalTarget(socketId, type);
}

export function markIpadStreaming(socketId: string): IpadLifecycleResult {
	return publish(coordinator.markStreaming(socketId));
}

export function requestIpadReset(
	sessionId: string,
	reason: string,
): IpadLifecycleResult {
	return publish(coordinator.requestReset(sessionId, reason));
}

export function disconnectIpadSocket(
	socketId: string,
	reason: string,
): IpadLifecycleResult {
	return publish(coordinator.disconnect(socketId, reason));
}
