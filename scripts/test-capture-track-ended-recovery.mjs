import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadTypeScriptModule(path, requiredModules = {}) {
	const source = readFileSync(path, 'utf8');
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require(id) {
			if (id in requiredModules) return requiredModules[id];
			return {};
		},
	});
	return module.exports;
}

class FakeTrack {
	readyState = 'live';
	listeners = new Set();

	addEventListener(event, listener) {
		if (event === 'ended') this.listeners.add(listener);
	}

	removeEventListener(event, listener) {
		if (event === 'ended') this.listeners.delete(listener);
	}

	end() {
		this.readyState = 'ended';
		for (const listener of this.listeners) listener();
	}
}

const { default: watchCaptureTrackEnded } = loadTypeScriptModule(
	'src/renderer/src/features/PeerConnection/captureTrackEndedRecovery.ts',
);

test('active capture track end requests exactly one teardown', () => {
	const track = new FakeTrack();
	let teardownCount = 0;
	watchCaptureTrackEnded(
		track,
		() => true,
		() => {
			teardownCount += 1;
		},
	);

	track.end();
	track.end();

	assert.equal(teardownCount, 1);
});

test('track end and peer close share the PeerConnection teardown guard', () => {
	let teardownCount = 0;
	const { default: PeerConnection } = loadTypeScriptModule(
		'src/renderer/src/features/PeerConnection/index.ts',
		{
			'./handleSelfDestroy': { default: () => (teardownCount += 1) },
		},
	);
	const peerConnection = Object.create(PeerConnection.prototype);
	peerConnection.isSelfDestroying = false;
	const track = new FakeTrack();
	watchCaptureTrackEnded(
		track,
		() => true,
		() => peerConnection.selfDestroy(),
	);

	track.end();
	peerConnection.selfDestroy();

	assert.equal(teardownCount, 1);
});

test('intentional cleanup removes the active track listener', () => {
	const track = new FakeTrack();
	let teardownCount = 0;
	const stop = watchCaptureTrackEnded(
		track,
		() => true,
		() => {
			teardownCount += 1;
		},
	);

	stop();
	track.end();

	assert.equal(teardownCount, 0);
});

test('a stale old track cannot tear down its replacement session', () => {
	const oldTrack = new FakeTrack();
	let activeTrack = oldTrack;
	let teardownCount = 0;
	watchCaptureTrackEnded(
		oldTrack,
		() => activeTrack === oldTrack,
		() => {
			teardownCount += 1;
		},
	);

	activeTrack = new FakeTrack();
	oldTrack.end();

	assert.equal(teardownCount, 0);
});
