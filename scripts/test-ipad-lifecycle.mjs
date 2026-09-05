import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadCoordinator() {
	const source = readFileSync('src/ipad-host/lifecycle.ts', 'utf8');
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports });
	return module.exports.IpadLifecycleCoordinator;
}

const Coordinator = loadCoordinator();

function startWithOwnerAndViewer() {
	const coordinator = new Coordinator();
	coordinator.startSession('session-1');
	coordinator.registerOwner('session-1', 'owner-1');
	coordinator.registerViewer('viewer-1', 'document-1', 'viewer-a');
	return coordinator;
}

test('A: owner first then viewer has one generation and starts negotiation once', () => {
	const coordinator = startWithOwnerAndViewer();
	assert.equal(coordinator.getState().generation, 1);
	assert.equal(
		coordinator.requestNegotiation('viewer-a').kind,
		'start-negotiation',
	);
	assert.equal(coordinator.requestNegotiation('viewer-a').kind, 'ignored');
});

test('B: viewer first then owner converges without changing viewer authority', () => {
	const coordinator = new Coordinator();
	coordinator.startSession('session-1');
	coordinator.registerViewer('viewer-1', 'document-1', 'viewer-a');
	coordinator.registerOwner('session-1', 'owner-1');
	assert.equal(
		coordinator.requestNegotiation('viewer-a').kind,
		'start-negotiation',
	);
});

test('C: viewer during reset is rejected until replacement generation exists', () => {
	const coordinator = startWithOwnerAndViewer();
	coordinator.requestReset('session-1', 'track-ended');
	assert.equal(
		coordinator.registerViewer('viewer-1', 'document-1', 'viewer-b').kind,
		'rejected',
	);
	coordinator.startSession('session-2');
	assert.equal(
		coordinator.registerViewer('viewer-1', 'document-1', 'viewer-b').kind,
		'accepted',
	);
});

test('D: fast close and reopen makes the old generation stale', () => {
	const coordinator = startWithOwnerAndViewer();
	assert.equal(
		coordinator.disconnect('viewer-a', 'viewer-disconnect').kind,
		'start-reset',
	);
	coordinator.startSession('session-2');
	assert.equal(
		coordinator.requestReset('session-1', 'late-close').kind,
		'ignored',
	);
});

test('E/I/J: same logical viewer atomically replaces socket A with B', () => {
	const coordinator = startWithOwnerAndViewer();
	const replacement = coordinator.registerViewer(
		'viewer-1',
		'document-1',
		'viewer-b',
	);
	assert.equal(replacement.kind, 'viewer-replaced');
	assert.equal(coordinator.getState().viewer.socketId, 'viewer-b');
	assert.equal(
		coordinator.disconnect('viewer-a', 'late-disconnect').kind,
		'ignored',
	);
	assert.equal(
		coordinator.getSignalTarget('viewer-a', 'CALL_ACCEPTED').kind,
		'ignored',
	);
	assert.equal(
		coordinator.disconnect('viewer-b', 'active-disconnect').kind,
		'start-reset',
	);
});

test('F/G/H: peer, capture, and transport failures share one reset boundary', () => {
	for (const reason of [
		'peer-close',
		'track-ended',
		'owner-transport-failed',
	]) {
		const coordinator = startWithOwnerAndViewer();
		assert.equal(
			coordinator.requestReset('session-1', reason).kind,
			'start-reset',
		);
		assert.equal(
			coordinator.requestReset('session-1', `${reason}-again`).kind,
			'ignored',
		);
	}
});

test('K: a different logical viewer is deterministically rejected', () => {
	const coordinator = startWithOwnerAndViewer();
	assert.equal(
		coordinator.registerViewer('viewer-2', 'document-2', 'viewer-b').kind,
		'rejected',
	);
	assert.equal(coordinator.getState().viewer.socketId, 'viewer-a');
});

test('Safari-style document replacement quiesces the old generation', () => {
	const coordinator = startWithOwnerAndViewer();
	const replacement = coordinator.registerViewer(
		'viewer-1',
		'document-2',
		'viewer-b',
	);
	assert.equal(replacement.kind, 'viewer-document-replaced');
	assert.equal(replacement.previousSocketId, 'viewer-a');
	assert.equal(coordinator.getState().viewer.socketId, 'viewer-a');
	assert.equal(
		coordinator.requestReset('session-1', 'viewer-document-replaced').kind,
		'start-reset',
	);
	coordinator.startSession('session-2');
	assert.equal(
		coordinator.registerViewer('viewer-1', 'document-2', 'viewer-b').kind,
		'accepted',
	);
});

test('L: duplicate and late signalling is harmless and direct', () => {
	const coordinator = startWithOwnerAndViewer();
	assert.equal(
		coordinator.getSignalTarget('viewer-a', 'CALL_ACCEPTED').kind,
		'ignored',
	);
	coordinator.requestNegotiation('viewer-a');
	assert.equal(
		coordinator.getSignalTarget('owner-1', 'CALL_USER').targetSocketId,
		'viewer-a',
	);
	assert.equal(
		coordinator.getSignalTarget('viewer-a', 'CALL_ACCEPTED').targetSocketId,
		'owner-1',
	);
	assert.equal(
		coordinator.getSignalTarget('unknown', 'CALL_USER').kind,
		'ignored',
	);
	assert.equal(coordinator.markStreaming('viewer-a').kind, 'accepted');
});

test('M: input is ignored before streaming and accepted once streaming', () => {
	const coordinator = startWithOwnerAndViewer();
	assert.equal(
		coordinator.acceptInput('viewer-a', 1, 'session-1').kind,
		'ignored',
	);
	coordinator.requestNegotiation('viewer-a');
	assert.equal(
		coordinator.acceptInput('viewer-a', 1, 'session-1').kind,
		'ignored',
	);
	coordinator.markStreaming('viewer-a');
	assert.equal(
		coordinator.acceptInput('viewer-a', 1, 'session-1').kind,
		'accepted',
	);
});

test('N: input from a stale viewer, wrong generation, or wrong session is ignored', () => {
	const coordinator = startWithOwnerAndViewer();
	coordinator.requestNegotiation('viewer-a');
	coordinator.markStreaming('viewer-a');
	assert.equal(
		coordinator.acceptInput('viewer-b', 1, 'session-1').kind,
		'ignored',
	);
	assert.equal(
		coordinator.acceptInput('viewer-a', 2, 'session-1').kind,
		'ignored',
	);
	assert.equal(
		coordinator.acceptInput('viewer-a', 1, 'session-2').kind,
		'ignored',
	);
	assert.equal(
		coordinator.acceptInput('viewer-a', 1, 'session-1').kind,
		'accepted',
	);
});

test('O: input from a replaced viewer becomes stale immediately', () => {
	const coordinator = startWithOwnerAndViewer();
	coordinator.requestNegotiation('viewer-a');
	coordinator.markStreaming('viewer-a');
	coordinator.registerViewer('viewer-1', 'document-1', 'viewer-b');
	assert.equal(
		coordinator.acceptInput('viewer-a', 1, 'session-1').kind,
		'ignored',
	);
});
