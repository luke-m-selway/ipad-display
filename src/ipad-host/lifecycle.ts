export type IpadLifecyclePhase =
	| 'preparing'
	| 'waiting-owner'
	| 'waiting-viewer'
	| 'negotiating'
	| 'streaming'
	| 'resetting';

export type IpadViewerBinding = {
	logicalViewerId: string;
	socketId: string;
};

export type IpadLifecycleState = {
	generation: number;
	sessionId: string | null;
	phase: IpadLifecyclePhase;
	ownerSocketId: string | null;
	viewer: IpadViewerBinding | null;
	negotiationStarted: boolean;
	resetReason: string | null;
};

export type IpadLifecycleResult =
	| { kind: 'accepted'; state: IpadLifecycleState }
	| {
			kind: 'viewer-replaced';
			previousSocketId: string;
			state: IpadLifecycleState;
	  }
	| { kind: 'start-negotiation'; state: IpadLifecycleState }
	| {
			kind: 'start-reset';
			sessionId: string;
			reason: string;
			state: IpadLifecycleState;
	  }
	| { kind: 'ignored'; reason: string; state: IpadLifecycleState }
	| { kind: 'rejected'; reason: string; state: IpadLifecycleState };

const initialState = (): IpadLifecycleState => ({
	generation: 0,
	sessionId: null,
	phase: 'preparing',
	ownerSocketId: null,
	viewer: null,
	negotiationStarted: false,
	resetReason: null,
});

function phaseForBindings(
	ownerSocketId: string | null,
	viewer: IpadViewerBinding | null,
): IpadLifecyclePhase {
	if (!ownerSocketId) return 'waiting-owner';
	if (!viewer) return 'waiting-viewer';
	return 'waiting-viewer';
}

/**
 * The coordinator owns the only authority transfer in the iPad protocol. A
 * physical socket is never meaningful without its generation and logical viewer.
 */
export class IpadLifecycleCoordinator {
	private state: IpadLifecycleState = initialState();

	getState(): IpadLifecycleState {
		return {
			...this.state,
			viewer: this.state.viewer ? { ...this.state.viewer } : null,
		};
	}

	startSession(sessionId: string): IpadLifecycleResult {
		this.state = {
			generation: this.state.generation + 1,
			sessionId,
			phase: 'waiting-owner',
			ownerSocketId: null,
			viewer: null,
			negotiationStarted: false,
			resetReason: null,
		};
		return { kind: 'accepted', state: this.getState() };
	}

	registerOwner(sessionId: string, socketId: string): IpadLifecycleResult {
		if (!this.isCurrentSession(sessionId)) {
			return this.ignored('stale-session');
		}
		if (this.state.phase === 'resetting') return this.ignored('resetting');
		if (
			this.state.ownerSocketId !== null &&
			this.state.ownerSocketId !== socketId
		) {
			return this.rejected('owner-already-bound');
		}

		this.state.ownerSocketId = socketId;
		this.state.phase = phaseForBindings(
			this.state.ownerSocketId,
			this.state.viewer,
		);
		return this.accepted();
	}

	registerViewer(
		logicalViewerId: string,
		socketId: string,
	): IpadLifecycleResult {
		if (!this.state.sessionId) return this.rejected('no-current-session');
		if (this.state.phase === 'resetting') return this.rejected('resetting');

		const currentViewer = this.state.viewer;
		if (!currentViewer) {
			this.state.viewer = { logicalViewerId, socketId };
			this.state.phase = phaseForBindings(
				this.state.ownerSocketId,
				this.state.viewer,
			);
			return this.accepted();
		}
		if (currentViewer.logicalViewerId !== logicalViewerId) {
			return this.rejected('different-viewer-active');
		}
		if (currentViewer.socketId === socketId) return this.accepted();

		this.state.viewer = { logicalViewerId, socketId };
		return {
			kind: 'viewer-replaced',
			previousSocketId: currentViewer.socketId,
			state: this.getState(),
		};
	}

	requestNegotiation(socketId: string): IpadLifecycleResult {
		if (!this.isCurrentViewer(socketId)) return this.ignored('stale-viewer');
		if (!this.state.ownerSocketId) return this.ignored('owner-not-ready');
		if (this.state.negotiationStarted)
			return this.ignored('negotiation-started');
		if (this.state.phase === 'resetting') return this.ignored('resetting');

		this.state.negotiationStarted = true;
		this.state.phase = 'negotiating';
		return { kind: 'start-negotiation', state: this.getState() };
	}

	markStreaming(socketId: string): IpadLifecycleResult {
		if (!this.isCurrentViewer(socketId)) return this.ignored('stale-viewer');
		if (!this.state.negotiationStarted) return this.ignored('not-negotiating');
		if (this.state.phase !== 'resetting') this.state.phase = 'streaming';
		return this.accepted();
	}

	getSignalTarget(
		socketId: string,
		type: string,
	): IpadLifecycleResult & { targetSocketId?: string } {
		if (this.state.phase === 'resetting') return this.ignored('resetting');
		if (socketId === this.state.ownerSocketId) {
			if (!this.state.viewer || !this.state.negotiationStarted) {
				return this.ignored('viewer-not-negotiating');
			}
			return { ...this.accepted(), targetSocketId: this.state.viewer.socketId };
		}
		if (this.isCurrentViewer(socketId)) {
			if (type === 'DEVICE_DETAILS')
				return this.ignored('device-details-must-start');
			if (!this.state.ownerSocketId || !this.state.negotiationStarted) {
				return this.ignored('owner-not-negotiating');
			}
			return { ...this.accepted(), targetSocketId: this.state.ownerSocketId };
		}
		return this.ignored('stale-socket');
	}

	requestReset(sessionId: string, reason: string): IpadLifecycleResult {
		if (!this.isCurrentSession(sessionId)) return this.ignored('stale-session');
		if (this.state.phase === 'resetting') return this.ignored('resetting');
		this.state.phase = 'resetting';
		this.state.resetReason = reason;
		return {
			kind: 'start-reset',
			sessionId,
			reason,
			state: this.getState(),
		};
	}

	disconnect(socketId: string, reason: string): IpadLifecycleResult {
		if (
			socketId === this.state.ownerSocketId ||
			this.isCurrentViewer(socketId)
		) {
			if (!this.state.sessionId) return this.ignored('no-current-session');
			return this.requestReset(this.state.sessionId, reason);
		}
		return this.ignored('stale-socket');
	}

	private isCurrentSession(sessionId: string): boolean {
		return this.state.sessionId === sessionId;
	}

	private isCurrentViewer(socketId: string): boolean {
		return this.state.viewer?.socketId === socketId;
	}

	private accepted(): IpadLifecycleResult {
		return { kind: 'accepted', state: this.getState() };
	}

	private ignored(reason: string): IpadLifecycleResult {
		return { kind: 'ignored', reason, state: this.getState() };
	}

	private rejected(reason: string): IpadLifecycleResult {
		return { kind: 'rejected', reason, state: this.getState() };
	}
}
