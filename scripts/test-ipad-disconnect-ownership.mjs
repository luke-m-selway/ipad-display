import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadTypeScriptModule(path) {
	const source = readFileSync(path, 'utf8');
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports });
	return module.exports;
}

const { claimCurrentRoomDisconnect } = loadTypeScriptModule(
	'src/server/disconnectOwnership.ts',
);
const { default: handleSocketUserExit } = loadTypeScriptModule(
	'src/renderer/src/features/PeerConnection/handleSocketUserExit.ts',
);

const owner = {
	socketId: 'owner-socket',
	username: 'iPad-Host',
	isOwner: true,
};
const viewerA = {
	socketId: 'viewer-a',
	username: 'ipad-viewer',
	isOwner: false,
};
const viewerB = {
	socketId: 'viewer-b',
	username: 'ipad-viewer',
	isOwner: false,
};

function socket(id) {
	return { id, data: {} };
}

test('active viewer disconnect claims exactly one reset-producing event', () => {
	const activeViewerSocket = socket(viewerA.socketId);

	const activeClaim = claimCurrentRoomDisconnect(activeViewerSocket, [
		owner,
		viewerA,
	]);
	assert.equal(activeClaim.kind, 'active');
	if (activeClaim.kind === 'active') {
		assert.equal(activeClaim.member.socketId, viewerA.socketId);
	}
	assert.equal(
		claimCurrentRoomDisconnect(activeViewerSocket, [owner]).kind,
		'duplicate',
	);
});

test('a delayed viewer A disconnect cannot claim viewer B room membership', () => {
	const delayedViewerSocket = socket(viewerA.socketId);

	assert.equal(
		claimCurrentRoomDisconnect(delayedViewerSocket, [owner, viewerB]).kind,
		'stale',
	);
	assert.equal(
		claimCurrentRoomDisconnect(socket(viewerB.socketId), [owner, viewerB]).kind,
		'active',
	);
});

test('a stale USER_EXIT that still contains viewer B cannot tear down B session', () => {
	let destroyCount = 0;
	const peerConnection = {
		isSocketRoomLocked: true,
		isCallStarted: true,
		partner: viewerB,
		toggleLockRoom() {
			throw new Error('stale viewer exit must not unlock the active room');
		},
		selfDestroy() {
			destroyCount += 1;
		},
	};

	handleSocketUserExit(peerConnection, { users: [owner, viewerB] });
	assert.equal(destroyCount, 0);
});

test('current viewer B exit tears down B session once', () => {
	let unlockCount = 0;
	let destroyCount = 0;
	const peerConnection = {
		isSocketRoomLocked: true,
		isCallStarted: true,
		partner: viewerB,
		toggleLockRoom() {
			unlockCount += 1;
		},
		selfDestroy() {
			destroyCount += 1;
		},
	};

	handleSocketUserExit(peerConnection, { users: [owner] });
	assert.equal(unlockCount, 1);
	assert.equal(destroyCount, 1);
});
