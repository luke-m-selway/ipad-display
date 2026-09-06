import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync('scripts/ipad', 'utf8');

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === 'ESRCH') return false;
		throw error;
	}
}

function startDetachedSleep() {
	return Number(
		execFileSync('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], {
			encoding: 'utf8',
		}).trim(),
	);
}

function makeHarness(pid, psCommand) {
	const root = mkdtempSync(join(tmpdir(), 'ipad-stop-reconcile-'));
	const repo = join(root, 'repo');
	const scripts = join(repo, 'scripts');
	const state = join(root, 'state');
	const fakeBin = join(root, 'bin');
	mkdirSync(scripts, { recursive: true });
	mkdirSync(fakeBin, { recursive: true });

	const patched = source.replace(
		'STATE_DIR="/tmp/ipad-display"',
		`STATE_DIR="${state}"`,
	);
	const ipad = join(scripts, 'ipad');
	writeFileSync(ipad, patched);
	chmodSync(ipad, 0o755);

	const pgrep = join(fakeBin, 'pgrep');
	writeFileSync(pgrep, '#!/bin/bash\nprintf \'%s\\n\' "$FAKE_DISPLAY_PID"\n');
	chmodSync(pgrep, 0o755);

	const ps = join(fakeBin, 'ps');
	writeFileSync(ps, '#!/bin/bash\nprintf \'%s\\n\' "$FAKE_PS_COMMAND"\n');
	chmodSync(ps, 0o755);

	return {
		root,
		state,
		ipad,
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH}`,
			FAKE_DISPLAY_PID: String(pid),
			FAKE_PS_COMMAND: psCommand(state),
		},
	};
}

test('stop reconciles the exact legacy project virtual-display helper without a PID record', () => {
	const pid = startDetachedSleep();
	const harness = makeHarness(
		pid,
		(state) => `${state}/ipad-4x3-display --state-file ${state}/virtual-display-id`,
	);
	try {
		assert.equal(processExists(pid), true);
		const output = execFileSync(harness.ipad, ['stop'], {
			encoding: 'utf8',
			env: harness.env,
		});
		assert.match(output, /reconciling orphaned iPad virtual display/);
		assert.match(output, /iPad display stack stopped/);
		assert.equal(processExists(pid), false);
	} finally {
		if (processExists(pid)) process.kill(pid, 'SIGKILL');
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test('stop leaves a similarly named process with a different executable path untouched', () => {
	const pid = startDetachedSleep();
	const harness = makeHarness(
		pid,
		(state) => `/tmp/not-ipad-display/ipad-4x3-display --state-file ${state}/virtual-display-id`,
	);
	try {
		const output = execFileSync(harness.ipad, ['stop'], {
			encoding: 'utf8',
			env: harness.env,
		});
		assert.match(output, /iPad display stack is already stopped/);
		assert.equal(processExists(pid), true);
	} finally {
		if (processExists(pid)) process.kill(pid, 'SIGKILL');
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test('status reports an orphaned managed virtual display without stopping it', () => {
	const pid = startDetachedSleep();
	const harness = makeHarness(
		pid,
		(state) => `${state}/ipad-4x3-display --state-file ${state}/virtual-display-id`,
	);
	try {
		const output = execFileSync(harness.ipad, ['status'], {
			encoding: 'utf8',
			env: harness.env,
		});
		assert.match(output, /iPad mode: stopped/);
		assert.match(output, /Orphaned iPad virtual display detected; run 'ipad stop'/);
		assert.equal(processExists(pid), true);
	} finally {
		if (processExists(pid)) process.kill(pid, 'SIGKILL');
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test('startup never borrows an existing virtual display without ownership', () => {
	assert.doesNotMatch(source, /use_existing_virtual_display_if_present/);
	assert.doesNotMatch(source, /--write-existing-id/);
	assert.match(source, /Removing orphaned virtual-display helper from an earlier invocation/);
	assert.match(
		source,
		/"\$VIRTUAL_DISPLAY_BIN" --state-file "\$DISPLAY_ID_FILE" --ipad-display-owner "\$owner_token"/,
	);
});
