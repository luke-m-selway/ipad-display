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

test('iPad viewer recreates its answerer and DEVICE_DETAILS handshake on reconnect', () => {
	const socketHandlers = new Map();
	const emittedMessages = [];
	const scheduledCallbacks = [];
	const peers = [];
	const socket = {
		connected: true,
		on(event, handler) {
			socketHandlers.set(event, handler);
		},
		emit(event, payload) {
			emittedMessages.push({ event, payload });
			if (event === 'GET_MY_IP') payload();
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

	const host = { username: 'iPad-Host' };
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

	socketHandlers.get('connect')();
	flushJoinAttempt();
	socketHandlers.get('USER_ENTER')({ users: [host] });
	assert.equal(peers.length, 1);
	assert.equal(countDeviceDetails(), 1);

	socketHandlers.get('connect')();
	flushJoinAttempt();
	socketHandlers.get('USER_ENTER')({ users: [host] });
	assert.equal(peers.length, 2);
	assert.equal(peers[0].destroyed, true);
	assert.equal(countDeviceDetails(), 2);
});
