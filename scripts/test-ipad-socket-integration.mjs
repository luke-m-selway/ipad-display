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
	viewer.emit('IPAD_REGISTER_VIEWER', { logicalViewerId: 'viewer-1' });
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
	viewer.emit('IPAD_REGISTER_VIEWER', { logicalViewerId: 'viewer-1' });
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

test('helper socket startup uses the main-process iPad mode value', () => {
	const helperBootstrap = readFileSync(
		'src/renderer/src/peerConnectionHelperRendererWindowIndex.tsx',
		'utf8',
	);
	assert.match(helperBootstrap, /IpcEvents\.GetIpadMode/);
	assert.match(helperBootstrap, /isIpadMode === true/);

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
