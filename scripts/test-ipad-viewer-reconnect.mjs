import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const viewerHtml = readFileSync('src/ipad-viewer/index.html', 'utf8');
const viewerScript = viewerHtml.match(
	/<script>\s*([\s\S]*?)\s*<\/script>/,
)?.[1];

if (!viewerScript) {
	throw new Error('Could not find the iPad viewer script');
}

function createViewerHarness() {
	const socketHandlers = new Map();
	const emittedMessages = [];
	const scheduledCallbacks = [];
	const peers = [];
	const windowHandlers = new Map();
	const socket = {
		connected: true,
		disconnectCount: 0,
		connectCount: 0,
		on(event, handler) {
			socketHandlers.set(event, handler);
		},
		emit(event, payload) {
			emittedMessages.push({ event, payload });
			if (event === 'GET_MY_IP') payload();
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

		signal() {
			return undefined;
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
		setTimeout(callback) {
			scheduledCallbacks.push(callback);
		},
		addEventListener(event, handler) {
			windowHandlers.set(event, handler);
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
		crypto: { randomUUID: () => 'viewer-id' },
		document,
		navigator: { userAgent: 'Safari test' },
		window,
	});

	const flushJoinAttempt = () => {
		const callback = scheduledCallbacks.shift();
		assert.ok(callback, 'expected a scheduled join attempt');
		callback();
	};
	const countDeviceDetails = () =>
		emittedMessages.filter(
			({ event, payload }) =>
				event === 'MESSAGE' && payload.type === 'DEVICE_DETAILS',
		).length;

	return {
		socket,
		socketHandlers,
		peers,
		windowHandlers,
		flushJoinAttempt,
		countDeviceDetails,
	};
}

const host = { username: 'iPad-Host' };

function connectAndJoin(harness) {
	harness.socketHandlers.get('connect')();
	harness.flushJoinAttempt();
	harness.socketHandlers.get('USER_ENTER')({ users: [host] });
}

test('iPad viewer recreates its answerer and DEVICE_DETAILS handshake on reconnect', () => {
	const harness = createViewerHarness();

	connectAndJoin(harness);
	const { peers } = harness;
	assert.equal(peers.length, 1);
	assert.equal(harness.countDeviceDetails(), 1);

	connectAndJoin(harness);
	assert.equal(peers.length, 2);
	assert.equal(peers[0].destroyed, true);
	assert.equal(harness.countDeviceDetails(), 2);
	assert.equal(harness.socket.disconnectCount, 0);
	assert.equal(harness.socket.connectCount, 0);
});

test('iPad viewer recovers once from an unexpected peer close', () => {
	const harness = createViewerHarness();
	connectAndJoin(harness);

	const oldPeer = harness.peers[0];
	oldPeer.emit('close');
	oldPeer.emit('close');

	assert.equal(oldPeer.destroyed, true);
	assert.equal(harness.socket.disconnectCount, 1);
	assert.equal(harness.socket.connectCount, 1);
	assert.equal(harness.peers.length, 1);

	connectAndJoin(harness);
	assert.equal(harness.peers.length, 2);
	assert.equal(harness.countDeviceDetails(), 2);
});

test('iPad viewer recovers once from an unexpected peer error', () => {
	const harness = createViewerHarness();
	connectAndJoin(harness);

	const oldPeer = harness.peers[0];
	oldPeer.emit('error', new Error('transport failed'));
	oldPeer.emit('close');

	assert.equal(oldPeer.destroyed, true);
	assert.equal(harness.socket.disconnectCount, 1);
	assert.equal(harness.socket.connectCount, 1);

	connectAndJoin(harness);
	assert.equal(harness.peers.length, 2);
	assert.equal(harness.countDeviceDetails(), 2);
});
