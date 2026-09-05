import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import { Server } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import ts from 'typescript';

function loadTypeScriptModule(path, requiredModules) {
	const source = readFileSync(path, 'utf8');
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		console,
		process,
		require(id) {
			if (id in requiredModules) return requiredModules[id];
			throw new Error(`Unexpected module import: ${id}`);
		},
	});
	return module.exports;
}

function once(socket, event, predicate = () => true) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off(event, listener);
			reject(new Error(`Timed out waiting for ${event}`));
		}, 2_000);
		const listener = (payload) => {
			if (!predicate(payload)) return;
			clearTimeout(timeout);
			socket.off(event, listener);
			resolve(payload);
		};
		socket.on(event, listener);
	});
}

async function createHarness(t) {
	const lifecycle = loadTypeScriptModule('src/ipad-host/lifecycle.ts', {});
	const runtime = loadTypeScriptModule('src/ipad-host/lifecycleRuntime.ts', {
		'./lifecycle': lifecycle,
	});
	const server = http.createServer();
	const io = new Server(server, { transports: ['websocket'] });
	const socketStore = {
		__esModule: true,
		default: { getServer: () => io },
	};
	const ipService = {
		__esModule: true,
		default: { getSocketIPByID: () => '192.168.2.2' },
	};
	const { default: IpadSocket } = loadTypeScriptModule(
		'src/server/ipadSocket.ts',
		{
			'../ipad-host/lifecycleRuntime': runtime,
			'./socketsIPService': ipService,
			'./store/socketIOServerStore': socketStore,
		},
	);
	const roomId = 'ipad-socket-integration';
	runtime.setIpadLifecycleStateListener((state) => {
		io.to(roomId).emit('IPAD_LIFECYCLE', state);
	});

	io.on('connection', (socket) => {
		Object.defineProperty(socket.request.socket, 'remoteAddress', {
			configurable: true,
			value:
				socket.handshake.auth.role === 'owner' ? '192.168.2.1' : '192.168.2.2',
		});
		new IpadSocket(socket, roomId);
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string')
		throw new Error('Missing test port');
	const url = `http://127.0.0.1:${address.port}`;

	t.after(async () => {
		await new Promise((resolve) => io.close(resolve));
		await new Promise((resolve) => server.close(resolve));
	});

	return { runtime, url };
}

function createClient(url, role) {
	return connectClient(url, {
		auth: { role },
		forceNew: true,
		transports: ['websocket'],
	});
}

async function connect(socket) {
	await once(socket, 'connect');
}

function recordInputs(runtime) {
	const calls = [];
	runtime.setIpadInputHandler((input) => calls.push(input));
	return calls;
}

/** Times out instead of hanging the suite if a test's state assumptions are wrong. */
function waitForInput(runtime, calls, predicate = () => true) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error('Timed out waiting for IPAD_INPUT to reach the handler'));
		}, 2_000);
		runtime.setIpadInputHandler((input) => {
			calls.push(input);
			if (!predicate(input)) return;
			clearTimeout(timeout);
			resolve(input);
		});
	});
}

/** Drives the coordinator straight to streaming without a full WebRTC handshake. */
async function reachStreaming(runtime, url, sessionId) {
	runtime.startIpadLifecycleSession(sessionId);
	const owner = createClient(url, 'owner');
	await connect(owner);
	const ownerBound = once(
		owner,
		'IPAD_LIFECYCLE',
		(state) => state.ownerSocketId === owner.id,
	);
	owner.emit('IPAD_REGISTER_OWNER', { sessionId });
	await ownerBound;

	const viewer = createClient(url, 'viewer');
	await connect(viewer);
	const viewerBound = once(
		viewer,
		'IPAD_LIFECYCLE',
		(state) => state.viewer?.socketId === viewer.id,
	);
	viewer.emit('IPAD_REGISTER_VIEWER', {
		logicalViewerId: 'viewer-1',
		documentId: 'document-1',
	});
	await viewerBound;

	runtime.requestIpadNegotiation(viewer.id);
	runtime.markIpadStreaming(viewer.id);
	const state = runtime.getIpadLifecycleState();
	return { owner, viewer, generation: state.generation, sessionId };
}

/**
 * Socket.IO preserves per-socket message order but delivers asynchronously, so
 * a synchronous runtime.* call right after socket.emit(...) can race ahead of
 * it. GET_MY_IP already acks, so waiting on it proves the server has drained
 * everything queued before it on this socket.
 */
function flush(socket) {
	return new Promise((resolve) => socket.emit('GET_MY_IP', resolve));
}

function validInput(context, overrides = {}) {
	return {
		action: 'click',
		x: 0.5,
		y: 0.5,
		generation: context.generation,
		sessionId: context.sessionId,
		...overrides,
	};
}

test('real Socket.IO owner-first registration reaches negotiating', async (t) => {
	const { runtime, url } = await createHarness(t);
	runtime.startIpadLifecycleSession('session-owner-first');
	const owner = createClient(url, 'owner');
	t.after(() => owner.close());
	await connect(owner);
	const ownerBound = once(
		owner,
		'IPAD_LIFECYCLE',
		(state) => state.ownerSocketId === owner.id,
	);
	owner.emit('IPAD_REGISTER_OWNER', { sessionId: 'session-owner-first' });
	await ownerBound;

	const viewer = createClient(url, 'viewer');
	t.after(() => viewer.close());
	await connect(viewer);
	const viewerBound = once(
		viewer,
		'IPAD_LIFECYCLE',
		(state) =>
			state.viewer?.socketId === viewer.id && state.ownerSocketId === owner.id,
	);
	viewer.emit('IPAD_REGISTER_VIEWER', {
		logicalViewerId: 'viewer-1',
		documentId: 'document-1',
	});
	await viewerBound;

	const deviceDetails = once(
		owner,
		'IPAD_SIGNAL',
		(signal) => signal.type === 'DEVICE_DETAILS',
	);
	viewer.emit('IPAD_DEVICE_DETAILS', { os: 'iPadOS', deviceType: 'tablet' });
	await deviceDetails;
	assert.equal(runtime.getIpadLifecycleState().phase, 'negotiating');
});

test('real Socket.IO viewer-first registration reaches negotiating', async (t) => {
	const { runtime, url } = await createHarness(t);
	runtime.startIpadLifecycleSession('session-viewer-first');
	const viewer = createClient(url, 'viewer');
	t.after(() => viewer.close());
	await connect(viewer);
	viewer.emit('IPAD_REGISTER_VIEWER', {
		logicalViewerId: 'viewer-1',
		documentId: 'document-1',
	});
	await once(
		viewer,
		'IPAD_LIFECYCLE',
		(state) => state.viewer?.socketId === viewer.id && !state.ownerSocketId,
	);

	const owner = createClient(url, 'owner');
	t.after(() => owner.close());
	await connect(owner);
	const ownerBound = once(
		viewer,
		'IPAD_LIFECYCLE',
		(state) =>
			state.ownerSocketId === owner.id && state.viewer?.socketId === viewer.id,
	);
	owner.emit('IPAD_REGISTER_OWNER', { sessionId: 'session-viewer-first' });
	await ownerBound;

	const deviceDetails = once(
		owner,
		'IPAD_SIGNAL',
		(signal) => signal.type === 'DEVICE_DETAILS',
	);
	viewer.emit('IPAD_DEVICE_DETAILS', { os: 'iPadOS', deviceType: 'tablet' });
	await deviceDetails;
	assert.equal(runtime.getIpadLifecycleState().phase, 'negotiating');
});

test('real Socket.IO document replacement resets before the new document joins', async (t) => {
	const { runtime, url } = await createHarness(t);
	runtime.startIpadLifecycleSession('session-document-replacement');
	const owner = createClient(url, 'owner');
	t.after(() => owner.close());
	await connect(owner);
	const ownerBound = once(
		owner,
		'IPAD_LIFECYCLE',
		(state) => state.ownerSocketId === owner.id,
	);
	owner.emit('IPAD_REGISTER_OWNER', {
		sessionId: 'session-document-replacement',
	});
	await ownerBound;

	const viewerA = createClient(url, 'viewer');
	t.after(() => viewerA.close());
	await connect(viewerA);
	const viewerABound = once(
		viewerA,
		'IPAD_LIFECYCLE',
		(state) => state.viewer?.socketId === viewerA.id,
	);
	viewerA.emit('IPAD_REGISTER_VIEWER', {
		logicalViewerId: 'viewer-1',
		documentId: 'document-a',
	});
	await viewerABound;

	const viewerB = createClient(url, 'viewer');
	t.after(() => viewerB.close());
	await connect(viewerB);
	const superseded = once(viewerA, 'IPAD_SUPERSEDED');
	const resetting = once(
		viewerB,
		'IPAD_LIFECYCLE',
		(state) => state.phase === 'resetting',
	);
	viewerB.emit('IPAD_REGISTER_VIEWER', {
		logicalViewerId: 'viewer-1',
		documentId: 'document-b',
	});
	await superseded;
	await resetting;
	assert.equal(runtime.getIpadLifecycleState().viewer.socketId, viewerA.id);
	assert.equal(runtime.getIpadLifecycleState().phase, 'resetting');

	runtime.startIpadLifecycleSession('session-document-replacement-2');
	const viewerBound = once(
		viewerB,
		'IPAD_LIFECYCLE',
		(state) => state.viewer?.socketId === viewerB.id,
	);
	viewerB.emit('IPAD_REGISTER_VIEWER', {
		logicalViewerId: 'viewer-1',
		documentId: 'document-b',
	});
	await viewerBound;
	assert.equal(runtime.getIpadLifecycleState().viewer.socketId, viewerB.id);
});

test('IPAD_TOUCH_CAPABILITY reflects whether an input handler is registered', async (t) => {
	const { runtime, url } = await createHarness(t);
	const viewerDisabled = createClient(url, 'viewer');
	t.after(() => viewerDisabled.close());
	const disabledCapability = once(viewerDisabled, 'IPAD_TOUCH_CAPABILITY');
	await connect(viewerDisabled);
	assert.equal((await disabledCapability).enabled, false);

	recordInputs(runtime);
	const viewerEnabled = createClient(url, 'viewer');
	t.after(() => viewerEnabled.close());
	const enabledCapability = once(viewerEnabled, 'IPAD_TOUCH_CAPABILITY');
	await connect(viewerEnabled);
	assert.equal((await enabledCapability).enabled, true);
});

test('display-only mode (no input handler) ignores IPAD_INPUT entirely', async (t) => {
	const { runtime, url } = await createHarness(t);
	const context = await reachStreaming(runtime, url, 'session-display-only');
	t.after(() => {
		context.owner.close();
		context.viewer.close();
	});
	assert.equal(runtime.isIpadTouchEnabled(), false);
	// No handler is registered, so IPAD_INPUT has nowhere to land; this only
	// proves the socket does not throw when touch mode is off.
	context.viewer.emit('IPAD_INPUT', validInput(context));
});

test('touch mode accepts input from the current streaming viewer', async (t) => {
	const { runtime, url } = await createHarness(t);
	const calls = [];
	const context = await reachStreaming(runtime, url, 'session-touch-accept');
	t.after(() => {
		context.owner.close();
		context.viewer.close();
	});
	const sawUp = waitForInput(runtime, calls, (input) => input.action === 'up');
	context.viewer.emit('IPAD_INPUT', validInput(context, { action: 'down' }));
	context.viewer.emit('IPAD_INPUT', validInput(context, { action: 'up' }));
	await sawUp;
	assert.deepEqual(
		calls.map((call) => call.action),
		['down', 'up'],
	);
});

test('touch mode accepts only known semantic system actions from the current viewer', async (t) => {
	const { runtime, url } = await createHarness(t);
	const calls = [];
	const context = await reachStreaming(runtime, url, 'session-system-actions');
	t.after(() => {
		context.owner.close();
		context.viewer.close();
	});
	const received = waitForInput(runtime, calls);
	context.viewer.emit(
		'IPAD_INPUT',
		validInput(context, { action: 'mission_control' }),
	);
	await received;
	assert.deepEqual(calls.map((call) => call.action), ['mission_control']);
});

test('malformed, non-finite, and out-of-range IPAD_INPUT payloads never reach the handler', async (t) => {
	const { runtime, url } = await createHarness(t);
	const calls = recordInputs(runtime);
	const context = await reachStreaming(runtime, url, 'session-malformed');
	t.after(() => {
		context.owner.close();
		context.viewer.close();
	});
	const malformed = [
		validInput(context, { action: 'teleport' }),
		validInput(context, { x: Number.NaN }),
		validInput(context, { x: Infinity }),
		validInput(context, { x: 1.5 }),
		validInput(context, { y: -0.1 }),
		validInput(context, { generation: 1.5 }),
		validInput(context, { generation: -1 }),
		validInput(context, { sessionId: '' }),
		validInput(context, { sessionId: 42 }),
		{ ...validInput(context), deltaX: 0.1 },
		validInput(context, {
			action: 'scroll',
			deltaX: 2,
			deltaY: 0,
		}),
		null,
		'not-an-object',
	];
	for (const payload of malformed) context.viewer.emit('IPAD_INPUT', payload);

	// A well-formed sentinel confirms the channel still works and that ordering
	// guarantees mean nothing malformed slipped through ahead of it.
	const sentinelReceived = waitForInput(runtime, calls);
	context.viewer.emit('IPAD_INPUT', validInput(context));
	await sentinelReceived;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].action, 'click');
	assert.equal(calls[0].x, 0.5);
	assert.equal(calls[0].y, 0.5);
});

test('pre-streaming, stale-viewer, and stale-generation IPAD_INPUT are ignored', async (t) => {
	const { runtime, url } = await createHarness(t);
	const calls = recordInputs(runtime);
	const sessionId = 'session-stale';
	runtime.startIpadLifecycleSession(sessionId);
	const owner = createClient(url, 'owner');
	t.after(() => owner.close());
	await connect(owner);
	const ownerBound = once(
		owner,
		'IPAD_LIFECYCLE',
		(state) => state.ownerSocketId === owner.id,
	);
	owner.emit('IPAD_REGISTER_OWNER', { sessionId });
	await ownerBound;

	const viewerA = createClient(url, 'viewer');
	t.after(() => viewerA.close());
	await connect(viewerA);
	const viewerABound = once(
		viewerA,
		'IPAD_LIFECYCLE',
		(state) => state.viewer?.socketId === viewerA.id,
	);
	viewerA.emit('IPAD_REGISTER_VIEWER', {
		logicalViewerId: 'viewer-1',
		documentId: 'document-a',
	});
	await viewerABound;

	// Pre-streaming: negotiation has not even started yet.
	const preStreamGeneration = runtime.getIpadLifecycleState().generation;
	viewerA.emit('IPAD_INPUT', {
		action: 'click',
		x: 0.5,
		y: 0.5,
		generation: preStreamGeneration,
		sessionId,
	});
	await flush(viewerA);

	runtime.requestIpadNegotiation(viewerA.id);
	runtime.markIpadStreaming(viewerA.id);
	const streamingGeneration = runtime.getIpadLifecycleState().generation;

	// Stale generation once streaming.
	viewerA.emit('IPAD_INPUT', {
		action: 'click',
		x: 0.5,
		y: 0.5,
		generation: streamingGeneration - 1,
		sessionId,
	});
	await flush(viewerA);

	// Replace the viewer from the same logical document (a same-tab socket
	// reconnect); this atomically swaps state.viewer to viewerB with no reset,
	// while the old socket becomes stale even though it still holds the current
	// generation number.
	const viewerB = createClient(url, 'viewer');
	t.after(() => viewerB.close());
	await connect(viewerB);
	const superseded = once(viewerA, 'IPAD_SUPERSEDED');
	viewerB.emit('IPAD_REGISTER_VIEWER', {
		logicalViewerId: 'viewer-1',
		documentId: 'document-a',
	});
	await superseded;
	viewerA.emit('IPAD_INPUT', {
		action: 'click',
		x: 0.5,
		y: 0.5,
		generation: streamingGeneration,
		sessionId,
	});
	await flush(viewerA);

	// Sentinel through the still-current path proves ordering held and nothing
	// above the fold reached the handler.
	const sentinelReceived = waitForInput(runtime, calls);
	runtime.requestIpadNegotiation(viewerB.id);
	runtime.markIpadStreaming(viewerB.id);
	const finalGeneration = runtime.getIpadLifecycleState().generation;
	viewerB.emit('IPAD_INPUT', {
		action: 'click',
		x: 0.5,
		y: 0.5,
		generation: finalGeneration,
		sessionId,
	});
	await sentinelReceived;
	assert.equal(calls.length, 1);
});

test('the owner socket can never inject input, even in touch mode', async (t) => {
	const { runtime, url } = await createHarness(t);
	const calls = recordInputs(runtime);
	const context = await reachStreaming(runtime, url, 'session-owner-input');
	t.after(() => {
		context.owner.close();
		context.viewer.close();
	});
	context.owner.emit('IPAD_INPUT', validInput(context));

	const sentinelReceived = waitForInput(runtime, calls);
	context.viewer.emit('IPAD_INPUT', validInput(context));
	await sentinelReceived;
	assert.equal(calls.length, 1);
});

test('helper socket startup uses the main-process iPad mode value', () => {
	const helperBootstrap = readFileSync(
		'src/renderer/src/peerConnectionHelperRendererWindowIndex.tsx',
		'utf8',
	);
	const genericIpcHandlers = readFileSync(
		'src/main/helpers/ipcMainHandlers.ts',
		'utf8',
	);
	assert.match(helperBootstrap, /IpcEvents\.GetIpadMode/);
	assert.match(helperBootstrap, /isIpadMode === true/);
	assert.match(genericIpcHandlers, /IpcEvents\.GetIpadMode, \(\) => false/);

	const { default: handleIpadSocket } = loadTypeScriptModule(
		'src/renderer/src/features/PeerConnection/handleIpadSocket.ts',
		{ './NullUser': { __esModule: true, default: { username: '' } } },
	);
	const { default: handleSocket } = loadTypeScriptModule(
		'src/renderer/src/features/PeerConnection/handleSocket.ts',
		{
			'./handleIpadSocket': { __esModule: true, default: handleIpadSocket },
			'./handleSocketUserEnter': { __esModule: true, default: () => undefined },
			'./handleSocketUserExit': { __esModule: true, default: () => undefined },
		},
	);
	const handlers = new Map();
	const emitted = [];
	const peerConnection = {
		isIpadMode: true,
		sharingSessionID: 'session-helper',
		ipadLifecycleGeneration: null,
		ipadLifecycleSessionID: null,
		partner: { username: '' },
		socket: {
			id: 'owner-socket',
			connected: false,
			removeAllListeners() {
				return undefined;
			},
			on(event, listener) {
				handlers.set(event, listener);
			},
			emit(event, payload) {
				emitted.push({ event, payload });
			},
		},
		selfDestroy() {
			return undefined;
		},
		receiveEncryptedMessage() {
			return undefined;
		},
		emitUserEnter() {
			this.socket.emit('IPAD_REGISTER_OWNER', {
				sessionId: this.sharingSessionID,
			});
		},
	};

	handleSocket(peerConnection);
	handlers.get('connect')();
	assert.deepEqual(emitted, [
		{
			event: 'IPAD_REGISTER_OWNER',
			payload: { sessionId: 'session-helper' },
		},
	]);
});
