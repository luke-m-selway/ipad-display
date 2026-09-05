import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadTypeScriptModule(filePath, requiredModules) {
	const source = readFileSync(filePath, 'utf8');
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

function createFakeChild() {
	const child = new EventEmitter();
	child.writes = [];
	child.stdin = {
		write(command) {
			// The bridge newline-terminates each command for the helper's
			// line-based stdin protocol; strip it here for readable assertions.
			child.writes.push(command.replace(/\n$/, ''));
		},
		ended: false,
		end() {
			child.stdin.ended = true;
		},
	};
	child.stderr = new EventEmitter();
	return child;
}

function loadIpadInputBridge() {
	const spawned = [];
	const spawn = (command, args, options) => {
		const child = createFakeChild();
		spawned.push({ command, args, options, child });
		return child;
	};
	const { IpadInputBridge } = loadTypeScriptModule(
		'src/ipad-host/inputBridge.ts',
		{
			'node:child_process': { spawn },
			'node:os': os,
			'node:path': path,
			'./lifecycleRuntime': {},
		},
	);
	return { IpadInputBridge, spawned };
}

const bounds = { x: 100, y: 50, width: 1600, height: 1200 };

test('start() spawns exactly one helper child and is idempotent', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.start();
	assert.equal(spawned.length, 1);
});

test('down/drag/up writes the expected mapped commands in order', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.handle({ action: 'down', x: 0, y: 0 });
	bridge.handle({ action: 'drag', x: 1, y: 0.5 });
	bridge.handle({ action: 'up', x: 1, y: 0.5 });
	assert.deepEqual(spawned[0].child.writes, [
		'down 100.000 50.000',
		'drag 1699.000 649.500',
		'up 1699.000 649.500',
	]);
});

test('a repeated down while already held does not resend down', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.handle({ action: 'down', x: 0, y: 0 });
	bridge.handle({ action: 'down', x: 0, y: 0 });
	assert.deepEqual(spawned[0].child.writes, ['down 100.000 50.000']);
});

test('drag and up while no button is held are no-ops', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.handle({ action: 'drag', x: 0.5, y: 0.5 });
	bridge.handle({ action: 'up', x: 0.5, y: 0.5 });
	assert.deepEqual(spawned[0].child.writes, []);
});

test('click always releases a held button first, exactly once', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.handle({ action: 'down', x: 0, y: 0 });
	bridge.handle({ action: 'click', x: 0.25, y: 0.25 });
	assert.deepEqual(spawned[0].child.writes, [
		'down 100.000 50.000',
		'release',
		'click 499.750 349.750',
	]);
});

test('release() is idempotent when no button is held', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.release();
	bridge.release();
	assert.deepEqual(spawned[0].child.writes, []);
});

test('release() after down writes exactly one release command', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.handle({ action: 'down', x: 0, y: 0 });
	bridge.release();
	bridge.release();
	assert.deepEqual(spawned[0].child.writes, ['down 100.000 50.000', 'release']);
});

test('scroll with zero delta is dropped; nonzero delta is scaled to bounds', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.handle({ action: 'scroll', x: 0.5, y: 0.5, deltaX: 0, deltaY: 0 });
	bridge.handle({ action: 'scroll', x: 0.5, y: 0.5, deltaX: 0.01, deltaY: -0.02 });
	assert.deepEqual(spawned[0].child.writes, [
		'scroll 899.500 649.500 16 -24',
	]);
});

test('stop() releases a held button, ends stdin, and drops the child reference', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.handle({ action: 'down', x: 0, y: 0 });
	bridge.stop();
	assert.deepEqual(spawned[0].child.writes, ['down 100.000 50.000', 'release']);
	assert.equal(spawned[0].child.stdin.ended, true);
	// With the child reference cleared, further writes are silently dropped
	// rather than throwing against a dead process.
	bridge.handle({ action: 'click', x: 0, y: 0 });
	assert.deepEqual(spawned[0].child.writes, ['down 100.000 50.000', 'release']);
});

test('an unexpected helper exit resets held-button tracking for the next spawn', () => {
	const { IpadInputBridge, spawned } = loadIpadInputBridge();
	const bridge = new IpadInputBridge(bounds);
	bridge.start();
	bridge.handle({ action: 'down', x: 0, y: 0 });
	spawned[0].child.emit('exit', null, 'SIGKILL');

	bridge.start();
	bridge.handle({ action: 'down', x: 0, y: 0 });
	assert.equal(spawned.length, 2);
	// Held-button state must not have survived the crash, or this would be a no-op.
	assert.deepEqual(spawned[1].child.writes, ['down 100.000 50.000']);
});
