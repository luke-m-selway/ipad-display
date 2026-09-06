import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync('scripts/ipad', 'utf8');
const installScript = readFileSync('scripts/install', 'utf8');
const doctorScript = readFileSync('scripts/ipad-doctor', 'utf8');
const readme = readFileSync('README.md', 'utf8');

test('iPad shell entrypoints are valid bash', () => {
	for (const path of ['scripts/ipad', 'scripts/install', 'scripts/ipad-doctor']) {
		assert.doesNotThrow(() => {
			execFileSync('bash', ['-n', path]);
		});
	}
});

test('plain `ipad` starts and stops only display mode', () => {
	assert.match(script, /start\)\s*start_stack display\s*;;/);
	assert.match(script, /stop\)\s*stop_requested_mode display\s*;;/);
});

test('the host PID is the real Electron process, not npm\'s transient launcher', () => {
	assert.match(
		script,
		/REPO_DIR\/node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron/,
	);
	assert.doesNotMatch(script, /REPO_DIR\/node_modules\/\.bin\/electron/);
});

test('`ipad touch` starts and stops touch mode without touching display-only paths', () => {
	assert.match(script, /touch\)\s*\n\s*case "\$\{2:-start\}" in\s*\n\s*start\) start_stack touch ;;\s*\n\s*stop\) stop_requested_mode touch ;;/);
});

test('the input helper is only built and passed IPAD_TOUCH_MODE=1 for the touch request path', () => {
	assert.match(
		script,
		/if \[ "\$requested_mode" = "touch" \]; then\s*\n\s*ensure_input_helper/,
	);
	assert.match(
		script,
		/IPAD_TOUCH_MODE="\$\(\[ "\$requested_mode" = "touch" \] && echo 1 \|\| echo 0\)"/,
	);
});

test('start_stack refuses to switch a running stack between modes without the matching stop', () => {
	assert.match(
		script,
		/if \[ "\$active_mode" = "\$requested_mode" \]; then\s*\n\s*log "iPad \$\{requested_mode\} mode is already running"\s*\n\s*return 0\s*\n\s*fi\s*\n\s*error "iPad \$\{active_mode\} mode is running/,
	);
});

test('stop_requested_mode refuses to stop a stack running in the other mode', () => {
	assert.match(
		script,
		/stop_requested_mode\(\) \{[\s\S]*?if \[ "\$active_mode" != "\$requested_mode" \]; then\s*\n\s*error "iPad \$\{active_mode\} mode is running/,
	);
});

test('running_mode treats a pre-touch stack (no mode file) as display, never touch', () => {
	assert.match(
		script,
		/# Pre-touch stacks have no mode record and are always the safe display mode\.\s*\n\s*printf '%s\\n' "display"/,
	);
});

test('status distinguishes stopped, display-only, and touch', () => {
	assert.match(
		script,
		/case "\$active_mode" in\s*\n\s*display\) echo "iPad mode: display-only" ;;\s*\n\s*touch\) echo "iPad mode: touch" ;;\s*\n\s*\*\) echo "iPad mode: stopped" ;;/,
	);
});

test('status is read-only for ownership records', () => {
	const statusFunction = script.match(
		/status_stack\(\) \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(statusFunction);
	assert.match(statusFunction, /active_mode="\$\(status_mode \|\| true\)"/);
	assert.doesNotMatch(statusFunction, /clear_stale_record|rm -f/);
	assert.match(
		script,
		/status_mode\(\) \{\s*# Status must not discard another invocation's ownership record[\s\S]*?mode_for_owned_host false/,
	);
});

test('stopping the stack always clears the mode record', () => {
	assert.match(script, /stop_stack\(\) \{[\s\S]*?rm -f "\$MODE_FILE"/);
});

test('doctor is exposed without becoming a lifecycle operation', () => {
	assert.match(script, /doctor\) exec "\$REPO_DIR\/scripts\/ipad-doctor" ;;/);
	assert.doesNotMatch(doctorScript, /clear_stale_record|stop_stack|terminate_owned_process|rm -f "\$MODE_FILE"/);
});

test('doctor does not execute a stale touch helper', () => {
	assert.match(
		doctorScript,
		/if \[\[ "\$REPO_DIR\/scripts\/ipad-input-helper\.m" -nt "\$INPUT_HELPER" \]\]; then[\s\S]*?warn "Touch input helper is older than its source; run \.\/scripts\/install before checking Accessibility"[\s\S]*?else[\s\S]*?"\$INPUT_HELPER" --accessibility-check/,
	);
});

test('installer pins and checksum-verifies the Intel Node runtime', () => {
	assert.match(installScript, /NODE_VERSION="v23\.11\.1"/);
	assert.match(installScript, /SHASUMS256\.txt/);
	assert.match(installScript, /shasum -a 256/);
	assert.match(installScript, /node-\$\{NODE_VERSION\}-darwin-x64/);
});

test('installer isolates npm cache from ambient user npm state', () => {
	assert.match(installScript, /NPM_CACHE="\$INSTALL_ROOT\/npm-cache"/);
	assert.match(installScript, /export npm_config_cache="\$NPM_CACHE"/);
});

test('README command reference matches the unified script contract', () => {
	for (const command of [
		'ipad',
		'ipad stop',
		'ipad touch',
		'ipad touch stop',
		'ipad status',
		'ipad doctor',
	]) {
		assert.match(readme, new RegExp(`\\\`${command}\\\``));
	}
	assert.match(readme, /Plain `ipad` remains[\s\S]*never starts the native input helper/);
});
