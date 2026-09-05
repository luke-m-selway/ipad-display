import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync('scripts/ipad', 'utf8');
const readme = readFileSync('README.md', 'utf8');

test('scripts/ipad is valid bash', () => {
	assert.doesNotThrow(() => {
		execFileSync('bash', ['-n', 'scripts/ipad']);
	});
});

test('plain `ipad` starts and stops only display mode', () => {
	assert.match(script, /start\)\s*start_stack display\s*;;/);
	assert.match(script, /stop\)\s*stop_requested_mode display\s*;;/);
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

test('README command reference matches the unified script contract', () => {
	for (const command of [
		'ipad',
		'ipad stop',
		'ipad touch',
		'ipad touch stop',
		'ipad status',
	]) {
		assert.match(readme, new RegExp(`\\\`${command}\\\``));
	}
	assert.match(readme, /Plain `ipad` remains[\s\S]*never starts the native input helper/);
});
