import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const viewerHtml = readFileSync('src/ipad-viewer/index.html', 'utf8');
const viewerScript = viewerHtml.match(
	/<script>\s*([\s\S]*?)\s*<\/script>/,
)?.[1];

if (!viewerScript) throw new Error('Could not find the iPad viewer script');

function createViewerHarness({
	storage = new Map(),
	viewerIds = ['viewer-id'],
} = {}) {
	const socketHandlers = new Map();
	const emitted = [];
	const peers = [];
	const socket = {
		id: 'viewer-a',
		connected: true,
		disconnectCount: 0,
		connectCount: 0,
		on(event, handler) {
			socketHandlers.set(event, handler);
		},
		emit(event, payload) {
			emitted.push({ event, payload });
		},
		disconnect() {
			this.disconnectCount += 1;
			this.connected = false;
		},
		connect() {
			this.connectCount += 1;
			this.connected = true;
		},
	};

	class FakePeer {
		constructor() {
			this.handlers = new Map();
			this.destroyed = false;
			this.receivedSignals = [];
			this.hasEmittedAnswer = false;
			peers.push(this);
		}

		on(event, handler) {
			this.handlers.set(event, handler);
		}

		removeAllListeners() {
			this.handlers.clear();
		}

		destroy() {
			this.destroyed = true;
		}

		emit(event, ...args) {
			this.handlers.get(event)?.(...args);
		}

		signal(signalData) {
			this.receivedSignals.push(signalData);
			if (!this.hasEmittedAnswer) {
				this.hasEmittedAnswer = true;
				this.emit('signal', { type: 'answer', for: signalData });
			}
		}
	}

	const video = { srcObject: null };
	const status = { hidden: false, textContent: '' };
	const fullscreenHint = { hidden: true };
	const document = {
		fullscreenElement: null,
		webkitFullscreenElement: null,
		getElementById(id) {
			return { video, status, 'fullscreen-hint': fullscreenHint }[id];
		},
		addEventListener() {
			return undefined;
		},
		documentElement: {
			requestFullscreen() {
				return undefined;
			},
		},
	};
	const window = {
		SimplePeer: FakePeer,
		io: () => socket,
		location: { origin: 'http://192.168.2.1:3131' },
		screen: { width: 1024, height: 768 },
		localStorage: {
			getItem(key) {
				return storage.get(key) ?? null;
			},
			setItem(key, value) {
				storage.set(key, value);
			},
		},
		addEventListener() {
			return undefined;
		},
	};

	vm.runInNewContext(viewerScript, {
		console: {
			debug() {
				return undefined;
			},
			error() {
				return undefined;
			},
		},
		crypto: { randomUUID: () => viewerIds.shift() ?? 'unexpected-viewer-id' },
		document,
		navigator: { userAgent: 'Safari test' },
		window,
	});

	const count = (event) =>
		emitted.filter((entry) => entry.event === event).length;
	return { socket, socketHandlers, peers, emitted, count, status, storage };
}

function lifecycle({
	generation = 1,
	sessionId = `session-${generation}`,
	phase = 'waiting-viewer',
	viewerSocketId = 'viewer-a',
	ownerSocketId = 'owner-1',
} = {}) {
	return {
		generation,
		sessionId,
		phase,
		ownerSocketId,
		viewer: viewerSocketId
			? { logicalViewerId: 'viewer-id', socketId: viewerSocketId }
			: null,
	};
}

function connectAndAuthorize(harness, state = lifecycle()) {
	harness.socketHandlers.get('connect')();
	harness.socketHandlers.get('IPAD_LIFECYCLE')(state);
}

test('viewer waits for an authoritative owner before sending DEVICE_DETAILS', () => {
	const harness = createViewerHarness();
	connectAndAuthorize(
		harness,
		lifecycle({ phase: 'waiting-owner', ownerSocketId: null }),
	);
	assert.equal(harness.count('IPAD_DEVICE_DETAILS'), 0);

	harness.socketHandlers.get('IPAD_LIFECYCLE')(lifecycle());
	assert.equal(harness.count('IPAD_DEVICE_DETAILS'), 1);
});

test('viewer registers once per connection and sends one DEVICE_DETAILS payload', () => {
	const harness = createViewerHarness();
	connectAndAuthorize(harness);
	assert.equal(harness.count('IPAD_REGISTER_VIEWER'), 1);
	assert.equal(harness.count('IPAD_DEVICE_DETAILS'), 1);

	harness.socketHandlers.get('IPAD_LIFECYCLE')(lifecycle());
	assert.equal(harness.count('IPAD_DEVICE_DETAILS'), 1);
});

test('viewer persists its logical identity across a Safari-style document reopen', () => {
	const storage = new Map();
	const firstDocument = createViewerHarness({
		storage,
		viewerIds: ['viewer-from-first-document'],
	});
	firstDocument.socketHandlers.get('connect')();
	assert.equal(firstDocument.emitted[0].event, 'IPAD_REGISTER_VIEWER');
	assert.equal(
		firstDocument.emitted[0].payload.logicalViewerId,
		'viewer-from-first-document',
	);

	const reopenedDocument = createViewerHarness({
		storage,
		viewerIds: ['viewer-should-not-be-used'],
	});
	reopenedDocument.socketHandlers.get('connect')();
	assert.equal(reopenedDocument.emitted[0].event, 'IPAD_REGISTER_VIEWER');
	assert.equal(
		reopenedDocument.emitted[0].payload.logicalViewerId,
		'viewer-from-first-document',
	);
	assert.notEqual(
		firstDocument.emitted[0].payload.documentId,
		reopenedDocument.emitted[0].payload.documentId,
	);
});

test('same-page socket A to B reconnect retains the peer and does not renegotiate', () => {
	const harness = createViewerHarness();
	connectAndAuthorize(harness, lifecycle({ phase: 'streaming' }));
	const firstPeer = harness.peers[0];

	harness.socket.id = 'viewer-b';
	harness.socketHandlers.get('connect')();
	harness.socketHandlers.get('IPAD_LIFECYCLE')(
		lifecycle({ phase: 'streaming', viewerSocketId: 'viewer-b' }),
	);

	assert.equal(harness.peers.length, 1);
	assert.equal(firstPeer.destroyed, false);
	assert.equal(harness.count('IPAD_DEVICE_DETAILS'), 0);
	assert.equal(
		harness.emitted[0].payload.documentId,
		harness.emitted[1].payload.documentId,
	);
});

test('unexpected peer close reconnects once and creates one fresh answerer', () => {
	const harness = createViewerHarness();
	connectAndAuthorize(harness);
	const oldPeer = harness.peers[0];

	oldPeer.emit('close');
	oldPeer.emit('close');
	assert.equal(oldPeer.destroyed, true);
	assert.equal(harness.socket.disconnectCount, 1);
	assert.equal(harness.socket.connectCount, 1);

	harness.socket.id = 'viewer-b';
	connectAndAuthorize(
		harness,
		lifecycle({ generation: 2, viewerSocketId: 'viewer-b' }),
	);
	assert.equal(harness.peers.length, 2);
	assert.equal(harness.count('IPAD_DEVICE_DETAILS'), 2);
});

test('generation-bound CALL_USER emits one direct CALL_ACCEPTED', () => {
	const harness = createViewerHarness();
	connectAndAuthorize(harness, lifecycle({ phase: 'negotiating' }));

	harness.socketHandlers.get('IPAD_SIGNAL')({
		type: 'CALL_USER',
		payload: { signalData: 'offer' },
		generation: 1,
		sessionId: 'session-1',
	});
	harness.socketHandlers.get('IPAD_SIGNAL')({
		type: 'CALL_USER',
		payload: { signalData: 'late-offer' },
		generation: 0,
		sessionId: 'session-0',
	});

	assert.deepEqual(harness.peers[0].receivedSignals, ['offer']);
	assert.equal(harness.count('IPAD_SIGNAL'), 1);
});

test('a rejected different viewer remains able to join a later generation', () => {
	const harness = createViewerHarness();
	connectAndAuthorize(
		harness,
		lifecycle({ viewerSocketId: 'other-viewer', phase: 'streaming' }),
	);
	const registrations = harness.count('IPAD_REGISTER_VIEWER');
	harness.socketHandlers.get('IPAD_REJECTED')({
		reason: 'different-viewer-active',
	});
	harness.socketHandlers.get('IPAD_LIFECYCLE')(
		lifecycle({ viewerSocketId: 'other-viewer', phase: 'streaming' }),
	);
	assert.equal(harness.count('IPAD_REGISTER_VIEWER'), registrations);

	harness.socketHandlers.get('IPAD_LIFECYCLE')(
		lifecycle({ generation: 2, viewerSocketId: null, phase: 'waiting-owner' }),
	);
	assert.equal(harness.count('IPAD_REGISTER_VIEWER'), registrations + 1);

	harness.socketHandlers.get('IPAD_LIFECYCLE')(
		lifecycle({ generation: 2, viewerSocketId: 'viewer-a' }),
	);
	assert.equal(harness.count('IPAD_DEVICE_DETAILS'), 1);
});
