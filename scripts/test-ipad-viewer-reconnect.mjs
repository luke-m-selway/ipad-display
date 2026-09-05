import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const viewerHtml = readFileSync('src/ipad-viewer/index.html', 'utf8');
const viewerScript = viewerHtml.match(
	/<script>\s*([\s\S]*?)\s*<\/script>/,
)?.[1];

if (!viewerScript) throw new Error('Could not find the iPad viewer script');

function createEventTarget(properties = {}) {
	const listeners = new Map();
	return {
		...properties,
		addEventListener(event, handler, options) {
			const handlers = listeners.get(event) ?? [];
			handlers.push({ handler, options });
			listeners.set(event, handlers);
		},
		removeEventListener(event, handler) {
			const handlers = listeners.get(event) ?? [];
			listeners.set(
				event,
				handlers.filter((entry) => entry.handler !== handler),
			);
		},
		dispatch(event, payload = {}) {
			const interaction = {
				touches: [],
				changedTouches: [],
				defaultPrevented: false,
				propagationStopped: false,
				preventDefault() {
					this.defaultPrevented = true;
				},
				stopPropagation() {
					this.propagationStopped = true;
				},
				...payload,
			};
			for (const entry of listeners.get(event) ?? []) {
				entry.handler(interaction);
			}
			return interaction;
		},
		listenerCount(event) {
			return (listeners.get(event) ?? []).length;
		},
	};
}

function createViewerHarness({
	storage = new Map(),
	viewerIds = ['viewer-id'],
	elementFullscreen = 'unprefixed',
	standalone = false,
	displayModes = [],
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

	const fullscreenCalls = { unprefixed: 0, prefixed: 0, nativeVideo: 0 };
	const video = createEventTarget({
		srcObject: null,
		videoWidth: 100,
		videoHeight: 100,
		getBoundingClientRect() {
			return { left: 0, top: 0, width: 100, height: 100 };
		},
		play() {
			return Promise.resolve();
		},
	});
	const status = { hidden: false, textContent: '' };
	const fullscreenHint = { hidden: true };
	const touchSurface = createEventTarget({ hidden: true });
	const touchControl = createEventTarget({
		hidden: true,
		textContent: '',
		attributes: new Map(),
		setAttribute(name, value) {
			this.attributes.set(name, value);
		},
	});
	const document = createEventTarget({
		fullscreenElement: null,
		webkitFullscreenElement: null,
		webkitCurrentFullScreenElement: null,
		webkitIsFullScreen: false,
		getElementById(id) {
			return {
				video,
				'touch-surface': touchSurface,
				'touch-control': touchControl,
				status,
				'fullscreen-hint': fullscreenHint,
			}[id];
		},
	});
	const root = {};
	if (elementFullscreen === 'unprefixed') {
		root.requestFullscreen = () => {
			fullscreenCalls.unprefixed += 1;
			document.fullscreenElement = root;
			return Promise.resolve();
		};
	} else if (elementFullscreen === 'prefixed') {
		root.webkitRequestFullscreen = () => {
			fullscreenCalls.prefixed += 1;
			document.webkitFullscreenElement = root;
		};
	}
	document.documentElement = root;
	video.webkitEnterFullscreen = () => {
		fullscreenCalls.nativeVideo += 1;
	};
	const window = {
		SimplePeer: FakePeer,
		io: () => socket,
		location: { origin: 'http://192.168.2.1:3131' },
		navigator: { standalone },
		matchMedia(query) {
			return { matches: displayModes.includes(query) };
		},
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
	return {
		socket,
		socketHandlers,
		peers,
		emitted,
		count,
		status,
		fullscreenHint,
		storage,
		document,
		touchSurface,
		touchControl,
		video,
		fullscreenCalls,
	};
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

function activateTouchStreaming(harness) {
	connectAndAuthorize(harness, lifecycle({ phase: 'streaming' }));
	harness.peers[0].emit('stream', {});
	harness.socketHandlers.get('IPAD_TOUCH_CAPABILITY')({ enabled: true });
}

function touch(identifier, clientX, clientY) {
	return { identifier, clientX, clientY };
}

function inputActions(harness) {
	return harness.emitted
		.filter((entry) => entry.event === 'IPAD_INPUT')
		.map((entry) => entry.payload.action);
}

function tapTouchSurface(harness, identifier = 1) {
	harness.touchSurface.dispatch('touchstart', {
		touches: [touch(identifier, 20, 20)],
	});
	harness.touchSurface.dispatch('touchend', {
		changedTouches: [touch(identifier, 20, 20)],
	});
}

function threeTouches(offsetX = 0, offsetY = 0) {
	return [
		touch(1, 48 + offsetX, 50 + offsetY),
		touch(2, 50 + offsetX, 50 + offsetY),
		touch(3, 52 + offsetX, 50 + offsetY),
	];
}

function startThreeFingerGesture(harness) {
	harness.touchSurface.dispatch('touchstart', { touches: threeTouches() });
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

test('touch mode uses unprefixed element fullscreen and never native video fullscreen', () => {
	const harness = createViewerHarness({ elementFullscreen: 'unprefixed' });
	activateTouchStreaming(harness);

	harness.touchSurface.dispatch('touchend');

	assert.equal(harness.fullscreenCalls.unprefixed, 1);
	assert.equal(harness.fullscreenCalls.nativeVideo, 0);
	assert.equal(harness.touchSurface.hidden, false);
	assert.equal(harness.touchControl.hidden, false);
	assert.equal(harness.touchControl.textContent, 'iPad');
});

test('touch mode uses the WebKit-prefixed element fullscreen API when needed', () => {
	const harness = createViewerHarness({ elementFullscreen: 'prefixed' });
	activateTouchStreaming(harness);

	harness.touchSurface.dispatch('pointerup');

	assert.equal(harness.fullscreenCalls.prefixed, 1);
	assert.equal(harness.fullscreenCalls.nativeVideo, 0);
});

test('active touch mode keeps the video out of the gesture path and suppresses native touch handling', () => {
	const harness = createViewerHarness({ elementFullscreen: 'none' });
	activateTouchStreaming(harness);

	const touchStart = harness.touchSurface.dispatch('touchstart');
	harness.touchSurface.dispatch('pointerup');

	assert.equal(touchStart.defaultPrevented, true);
	assert.equal(harness.video.listenerCount('touchstart'), 0);
	assert.equal(harness.touchSurface.listenerCount('touchstart'), 1);
	assert.equal(harness.fullscreenCalls.nativeVideo, 0);
	assert.match(viewerHtml, /#touch-surface[^}]*touch-action: none/);
});

test('WebKit current fullscreen element enables the touch gate', () => {
	const harness = createViewerHarness();
	activateTouchStreaming(harness);
	harness.document.webkitCurrentFullScreenElement = harness.document.documentElement;

	tapTouchSurface(harness);

	assert.deepEqual(inputActions(harness), ['click']);
});

test('WebKit fullscreen boolean enables the touch gate', () => {
	const harness = createViewerHarness();
	activateTouchStreaming(harness);
	harness.document.webkitIsFullScreen = true;

	tapTouchSurface(harness);

	assert.deepEqual(inputActions(harness), ['click']);
});

test('iOS Home Screen standalone mode is immersive without element fullscreen', () => {
	const harness = createViewerHarness({ standalone: true });
	activateTouchStreaming(harness);

	tapTouchSurface(harness);

	assert.equal(harness.fullscreenHint.hidden, true);
	assert.equal(harness.fullscreenCalls.unprefixed, 0);
	assert.deepEqual(inputActions(harness), ['click']);
});

for (const mode of ['standalone', 'fullscreen']) {
	test(`display-mode ${mode} is immersive without element fullscreen`, () => {
		const harness = createViewerHarness({
			displayModes: [`(display-mode: ${mode})`],
		});
		activateTouchStreaming(harness);

		tapTouchSurface(harness);

		assert.equal(harness.fullscreenHint.hidden, true);
		assert.deepEqual(inputActions(harness), ['click']);
	});
}

test('ordinary browser touch input remains blocked until element fullscreen is observed', () => {
	const harness = createViewerHarness();
	activateTouchStreaming(harness);

	tapTouchSurface(harness);

	assert.equal(harness.fullscreenHint.hidden, false);
	assert.deepEqual(inputActions(harness), []);
});

test('restoring Mac control from standalone mode does not request browser fullscreen', () => {
	const harness = createViewerHarness({ standalone: true });
	activateTouchStreaming(harness);

	harness.touchControl.dispatch('click');
	assert.equal(harness.touchControl.textContent, 'Mac');
	harness.touchControl.dispatch('click');

	assert.equal(harness.touchControl.textContent, 'iPad');
	assert.equal(harness.touchSurface.hidden, false);
	assert.equal(harness.fullscreenCalls.unprefixed, 0);
});

test('the local touch control releases an active drag, blocks input while disabled, and restores Mac control', () => {
	const harness = createViewerHarness({ elementFullscreen: 'unprefixed' });
	activateTouchStreaming(harness);
	harness.document.fullscreenElement = harness.document.documentElement;

	harness.touchSurface.dispatch('touchstart', {
		touches: [touch(1, 10, 10)],
	});
	harness.touchSurface.dispatch('touchmove', {
		touches: [touch(1, 30, 10)],
	});
	assert.deepEqual(inputActions(harness), ['down', 'drag']);

	const disable = harness.touchControl.dispatch('click');
	assert.equal(disable.defaultPrevented, true);
	assert.equal(disable.propagationStopped, true);
	assert.deepEqual(inputActions(harness), ['down', 'drag', 'up']);
	assert.equal(harness.touchSurface.hidden, true);
	assert.equal(harness.touchControl.textContent, 'Mac');

	harness.touchSurface.dispatch('touchend', {
		changedTouches: [touch(1, 30, 10)],
	});
	assert.deepEqual(inputActions(harness), ['down', 'drag', 'up']);

	harness.document.fullscreenElement = null;
	harness.touchControl.dispatch('click');
	assert.equal(harness.touchSurface.hidden, false);
	assert.equal(harness.touchControl.textContent, 'iPad');
	assert.equal(harness.fullscreenCalls.unprefixed, 1);

	harness.touchSurface.dispatch('touchstart', {
		touches: [touch(2, 20, 20)],
	});
	harness.touchSurface.dispatch('touchend', {
		changedTouches: [touch(2, 20, 20)],
	});
	assert.deepEqual(inputActions(harness), ['down', 'drag', 'up', 'click']);
});

test('touch-control button gestures never become Mac input', () => {
	const harness = createViewerHarness();
	activateTouchStreaming(harness);
	harness.document.fullscreenElement = harness.document.documentElement;

	harness.touchControl.dispatch('touchstart');
	harness.touchControl.dispatch('click');

	assert.deepEqual(inputActions(harness), []);
	assert.equal(harness.touchControl.textContent, 'Mac');
});

test('three-finger up emits Mission Control once before all fingers lift', () => {
	const harness = createViewerHarness({ standalone: true });
	activateTouchStreaming(harness);

	startThreeFingerGesture(harness);
	harness.touchSurface.dispatch('touchmove', { touches: threeTouches(0, -46) });
	harness.touchSurface.dispatch('touchmove', { touches: threeTouches(0, -80) });
	harness.touchSurface.dispatch('touchend', { changedTouches: threeTouches(0, -80) });

	assert.deepEqual(inputActions(harness), ['mission_control']);
});

test('three-finger horizontal swipes use natural Space directions', () => {
	const left = createViewerHarness({ standalone: true });
	activateTouchStreaming(left);
	startThreeFingerGesture(left);
	left.touchSurface.dispatch('touchmove', { touches: threeTouches(-46, 10) });
	left.touchSurface.dispatch('touchend', { changedTouches: threeTouches(-46, 10) });

	const right = createViewerHarness({ standalone: true });
	activateTouchStreaming(right);
	startThreeFingerGesture(right);
	right.touchSurface.dispatch('touchmove', { touches: threeTouches(46, 10) });
	right.touchSurface.dispatch('touchend', { changedTouches: threeTouches(46, 10) });

	assert.deepEqual(inputActions(left), ['space_right']);
	assert.deepEqual(inputActions(right), ['space_left']);
});

test('three-finger movement below the 45px threshold emits nothing', () => {
	const harness = createViewerHarness({ standalone: true });
	activateTouchStreaming(harness);

	startThreeFingerGesture(harness);
	harness.touchSurface.dispatch('touchmove', { touches: threeTouches(44, 0) });
	harness.touchSurface.dispatch('touchend', { changedTouches: threeTouches(44, 0) });

	assert.deepEqual(inputActions(harness), []);
});

test('a pending gesture can become a three-finger system gesture without clicking', () => {
	const harness = createViewerHarness({ standalone: true });
	activateTouchStreaming(harness);
	harness.touchSurface.dispatch('touchstart', { touches: [touch(1, 30, 50)] });
	startThreeFingerGesture(harness);
	harness.touchSurface.dispatch('touchmove', { touches: threeTouches(0, -46) });
	harness.touchSurface.dispatch('touchend', { changedTouches: threeTouches(0, -46) });

	assert.deepEqual(inputActions(harness), ['mission_control']);
});

test('a committed drag releases and cannot turn into a three-finger system gesture', () => {
	const harness = createViewerHarness({ standalone: true });
	activateTouchStreaming(harness);
	harness.touchSurface.dispatch('touchstart', { touches: [touch(1, 30, 50)] });
	harness.touchSurface.dispatch('touchmove', { touches: [touch(1, 50, 50)] });
	startThreeFingerGesture(harness);
	harness.touchSurface.dispatch('touchmove', { touches: threeTouches(0, -60) });
	harness.touchSurface.dispatch('touchend', { changedTouches: threeTouches(0, -60) });

	assert.deepEqual(inputActions(harness), ['down', 'drag', 'up']);
});

test('disabled Mac control emits no three-finger system action', () => {
	const harness = createViewerHarness({ standalone: true });
	activateTouchStreaming(harness);
	harness.touchControl.dispatch('click');
	startThreeFingerGesture(harness);
	harness.touchSurface.dispatch('touchmove', { touches: threeTouches(0, -60) });
	harness.touchSurface.dispatch('touchend', { changedTouches: threeTouches(0, -60) });

	assert.equal(harness.touchControl.textContent, 'Mac');
	assert.deepEqual(inputActions(harness), []);
});

test('display-only mode retains document fullscreen entry and native-video fallback', () => {
	const harness = createViewerHarness({ elementFullscreen: 'none' });
	connectAndAuthorize(harness, lifecycle({ phase: 'streaming' }));
	harness.peers[0].emit('stream', {});
	harness.socketHandlers.get('IPAD_TOUCH_CAPABILITY')({ enabled: false });

	harness.document.dispatch('touchend');

	assert.equal(harness.touchSurface.hidden, true);
	assert.equal(harness.touchControl.hidden, true);
	assert.equal(harness.document.listenerCount('touchend'), 1);
	assert.equal(harness.fullscreenCalls.nativeVideo, 1);
});
