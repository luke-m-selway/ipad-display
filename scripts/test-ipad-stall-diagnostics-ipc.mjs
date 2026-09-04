import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ipcEvents = readFileSync('src/common/IpcEvents.enum.ts', 'utf8');
const ipadHost = readFileSync('src/ipad-host/index.ts', 'utf8');
const diagnostics = readFileSync(
	'src/renderer/src/features/PeerConnection/ipadStallDiagnostics.ts',
	'utf8',
);

test('iPad stall diagnostics use main-process IPC for activation and logging', () => {
	assert.match(
		ipcEvents,
		/GetIpadStallDiagnosticsEnabled = 'get-ipad-stall-diagnostics-enabled'/,
	);
	assert.match(
		ipcEvents,
		/IpadStallDiagnosticRecord = 'ipad-stall-diagnostic-record'/,
	);
	assert.match(
		ipadHost,
		/IpcEvents\.GetIpadStallDiagnosticsEnabled,[\s\S]*process\.env\.IPAD_STALL_DIAGNOSTICS === '1'/,
	);
	assert.match(
		ipadHost,
		/ipcMain\.on\(IpcEvents\.IpadStallDiagnosticRecord,[\s\S]*console\.log\(record\)/,
	);
	assert.match(
		diagnostics,
		/ipcRenderer\.invoke\([\s\S]*IpcEvents\.GetIpadStallDiagnosticsEnabled/,
	);
	assert.match(
		diagnostics,
		/ipcRenderer\.send\(IpcEvents\.IpadStallDiagnosticRecord, record\)/,
	);
	assert.doesNotMatch(diagnostics, /globalThis\.process|process\.env/);
	assert.match(diagnostics, /const STATS_INTERVAL_MS = 5000/);
});
