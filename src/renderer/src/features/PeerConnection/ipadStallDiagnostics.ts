import type PeerConnection from './index';
import NullSimplePeer from './NullSimplePeer';

const STATS_INTERVAL_MS = 5000;

type DiagnosticPeer = {
	_pc?: RTCPeerConnection;
	on(event: 'close', listener: () => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
	removeListener(event: 'close', listener: () => void): void;
	removeListener(event: 'error', listener: (error: Error) => void): void;
};

type NumericCounters = {
	captured?: number;
	encoded?: number;
	sent?: number;
	bytes?: number;
};

type StatsEntry = Record<string, unknown>;

type RuntimeProcess = {
	env?: Record<string, string | undefined>;
};

export function isIpadStallDiagnosticsEnabled(): boolean {
	const runtime = globalThis as typeof globalThis & {
		process?: RuntimeProcess;
	};
	return runtime.process?.env?.IPAD_STALL_DIAGNOSTICS === '1';
}

function getNumber(
	entry: StatsEntry | undefined,
	...keys: string[]
): number | undefined {
	for (const key of keys) {
		const value = entry?.[key];
		if (typeof value === 'number' && Number.isFinite(value)) return value;
	}
	return undefined;
}

function getString(
	entry: StatsEntry | undefined,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = entry?.[key];
		if (typeof value === 'string' && value !== '') return value;
	}
	return undefined;
}

function formatCounter(
	value: number | undefined,
	previous: number | undefined,
): string {
	if (value === undefined) return '-';
	if (previous === undefined) return String(value);
	return `${value}(+${value - previous})`;
}

function findStats(
	stats: RTCStatsReport,
	predicate: (entry: StatsEntry) => boolean,
): StatsEntry | undefined {
	for (const entry of stats.values()) {
		const record = entry as unknown as StatsEntry;
		if (predicate(record)) return record;
	}
	return undefined;
}

function writeState(peerConnection: PeerConnection, event: string): void {
	const track = peerConnection.localStream?.getVideoTracks()[0];
	const peer = peerConnection.peer as unknown as DiagnosticPeer;
	const pc = peer._pc;
	console.log(
		`[iPad Stall] ${new Date().toISOString()} event=${event} track=${track?.readyState ?? '-'} muted=${track?.muted ?? '-'} pc=${pc?.connectionState ?? '-'} ice=${pc?.iceConnectionState ?? '-'} gathering=${pc?.iceGatheringState ?? '-'} signaling=${pc?.signalingState ?? '-'}`,
	);
}

export function startIpadStallDiagnostics(
	peerConnection: PeerConnection,
): (() => void) | null {
	if (
		!isIpadStallDiagnosticsEnabled() ||
		peerConnection.peer === NullSimplePeer
	)
		return null;

	const peer = peerConnection.peer as unknown as DiagnosticPeer;
	const pc = peer._pc;
	const track = peerConnection.localStream?.getVideoTracks()[0];
	let previousCounters: NumericCounters = {};
	let stopped = false;

	const onTrackEnded = () => writeState(peerConnection, 'track-ended');
	const onTrackMute = () => writeState(peerConnection, 'track-mute');
	const onTrackUnmute = () => writeState(peerConnection, 'track-unmute');
	const onConnectionStateChange = () =>
		writeState(peerConnection, 'connection-state-change');
	const onIceConnectionStateChange = () =>
		writeState(peerConnection, 'ice-connection-state-change');
	const onIceGatheringStateChange = () =>
		writeState(peerConnection, 'ice-gathering-state-change');
	const onSignalingStateChange = () =>
		writeState(peerConnection, 'signaling-state-change');
	const onPeerClose = () => writeState(peerConnection, 'simple-peer-close');
	const onPeerError = (error: Error) =>
		console.error(
			`[iPad Stall] ${new Date().toISOString()} event=simple-peer-error message=${error.message}`,
		);

	track?.addEventListener('ended', onTrackEnded);
	track?.addEventListener('mute', onTrackMute);
	track?.addEventListener('unmute', onTrackUnmute);
	pc?.addEventListener('connectionstatechange', onConnectionStateChange);
	pc?.addEventListener('iceconnectionstatechange', onIceConnectionStateChange);
	pc?.addEventListener('icegatheringstatechange', onIceGatheringStateChange);
	pc?.addEventListener('signalingstatechange', onSignalingStateChange);
	peer.on('close', onPeerClose);
	peer.on('error', onPeerError);

	const logStats = async (): Promise<void> => {
		if (stopped || !pc) return;
		try {
			const stats = await pc.getStats();
			if (stopped) return;
			const mediaSource = findStats(
				stats,
				(entry) => entry.type === 'media-source' && entry.kind === 'video',
			);
			const outboundRtp = findStats(
				stats,
				(entry) => entry.type === 'outbound-rtp' && entry.kind === 'video',
			);
			const codecID = getString(outboundRtp, 'codecId');
			const codec = codecID
				? (stats.get(codecID) as unknown as StatsEntry | undefined)
				: undefined;
			const counters: NumericCounters = {
				captured: getNumber(mediaSource, 'frames', 'framesCaptured'),
				encoded: getNumber(outboundRtp, 'framesEncoded'),
				sent: getNumber(outboundRtp, 'framesSent'),
				bytes: getNumber(outboundRtp, 'bytesSent'),
			};
			console.log(
				`[iPad Stall] ${new Date().toISOString()} stats track=${track?.readyState ?? '-'} muted=${track?.muted ?? '-'} capture=${formatCounter(counters.captured, previousCounters.captured)} fps=${getNumber(mediaSource, 'framesPerSecond') ?? '-'} encoded=${formatCounter(counters.encoded, previousCounters.encoded)} sent=${formatCounter(counters.sent, previousCounters.sent)} bytes=${formatCounter(counters.bytes, previousCounters.bytes)} size=${getNumber(outboundRtp, 'frameWidth') ?? '-'}x${getNumber(outboundRtp, 'frameHeight') ?? '-'} quality=${getString(outboundRtp, 'qualityLimitationReason') ?? '-'} encoder=${getString(outboundRtp, 'encoderImplementation') ?? getString(codec, 'implementation') ?? '-'}`,
			);
			previousCounters = counters;
		} catch (error) {
			console.error(
				`[iPad Stall] ${new Date().toISOString()} event=stats-error message=${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	writeState(peerConnection, 'diagnostics-started');
	void logStats();
	const interval = setInterval(() => void logStats(), STATS_INTERVAL_MS);

	return () => {
		stopped = true;
		clearInterval(interval);
		track?.removeEventListener('ended', onTrackEnded);
		track?.removeEventListener('mute', onTrackMute);
		track?.removeEventListener('unmute', onTrackUnmute);
		pc?.removeEventListener('connectionstatechange', onConnectionStateChange);
		pc?.removeEventListener(
			'iceconnectionstatechange',
			onIceConnectionStateChange,
		);
		pc?.removeEventListener(
			'icegatheringstatechange',
			onIceGatheringStateChange,
		);
		pc?.removeEventListener('signalingstatechange', onSignalingStateChange);
		peer.removeListener('close', onPeerClose);
		peer.removeListener('error', onPeerError);
	};
}
