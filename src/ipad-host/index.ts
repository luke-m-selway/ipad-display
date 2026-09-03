import { app, desktopCapturer, ipcMain, screen } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import DesktopCapturerSourceType from '../common/DesktopCapturerSourceType';
import { IpcEvents } from '../common/IpcEvents.enum';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import { initGlobals } from '../main/helpers/initGlobals';
import { startLogBufferCleanup } from '../main/utils/LoggerWithFilePrefix';
import { signalingServer } from '../server';
import SharingSession from '../features/SharingSessionService/SharingSession';
import SharingSessionStatusEnum from '../features/SharingSessionService/SharingSessionStatusEnum';
import type { LocalPeerUser } from '../common/LocalPeerUser';

const IPAD_BIND_IP = '192.168.2.1';
const IPAD_PORT = 3131;
const IPAD_FIXED_ROOM_ID = 'ipad-main';
const IPAD_DISPLAY_NAME = 'iPad 4:3 Display';
const IPAD_DISPLAY_WIDTH = 1600;
const IPAD_DISPLAY_HEIGHT = 1200;
const displayIDStateFile =
	process.env.IPAD_DISPLAY_ID_FILE ?? '/tmp/ipad-display/virtual-display-id';

type VirtualDisplaySource = {
	sourceID: string;
	displayID: string;
	width: number;
	height: number;
};

let virtualDisplay: VirtualDisplaySource | null = null;
let sharingSession: SharingSession | null = null;
let restartInProgress = false;
let isQuitting = false;

const hostUser: LocalPeerUser = {
	username: 'iPad-Host',
	id: 'ipad-host',
};

function getExpectedDisplayID(): string {
	if (!existsSync(displayIDStateFile)) {
		throw new Error(
			`Virtual display identity file is missing: ${displayIDStateFile}`,
		);
	}

	const displayID = readFileSync(displayIDStateFile, 'utf8').trim();
	if (!/^\d+$/.test(displayID)) {
		throw new Error(
			`Virtual display identity file contains an invalid display ID: ${displayIDStateFile}`,
		);
	}
	return displayID;
}

async function findVirtualDisplay(): Promise<VirtualDisplaySource | null> {
	const expectedDisplayID = getExpectedDisplayID();
	const primaryDisplayID = String(screen.getPrimaryDisplay().id);
	const displays = screen.getAllDisplays();
	const display = displays.find((candidate) => String(candidate.id) === expectedDisplayID);

	if (!display) {
		console.log(
			`[iPad Host] Virtual display ${expectedDisplayID} is not available yet`,
		);
		return null;
	}
	if (String(display.id) === primaryDisplayID) {
		throw new Error('Refusing to capture the primary display');
	}
	if (
		display.bounds.width !== IPAD_DISPLAY_WIDTH ||
		display.bounds.height !== IPAD_DISPLAY_HEIGHT
	) {
		throw new Error(
			`Virtual display ${expectedDisplayID} has ${display.bounds.width}x${display.bounds.height}; expected ${IPAD_DISPLAY_WIDTH}x${IPAD_DISPLAY_HEIGHT}`,
		);
	}

	const sources = await desktopCapturer.getSources({
		types: [DesktopCapturerSourceType.SCREEN],
		thumbnailSize: { width: 0, height: 0 },
		fetchWindowIcons: false,
	});
	const source = sources.find(
		(candidate) => candidate.display_id === expectedDisplayID,
	);

	if (!source) {
		console.log(
			`[iPad Host] No desktop-capturer source for virtual display ${expectedDisplayID} yet`,
		);
		return null;
	}
	if (source.name !== IPAD_DISPLAY_NAME) {
		throw new Error(
			`Virtual display ${expectedDisplayID} is named ${JSON.stringify(source.name)}; expected ${JSON.stringify(IPAD_DISPLAY_NAME)}`,
		);
	}

	return {
		sourceID: source.id,
		displayID: expectedDisplayID,
		width: display.bounds.width,
		height: display.bounds.height,
	};
}

async function waitForVirtualDisplay(): Promise<VirtualDisplaySource> {
	for (let attempt = 1; attempt <= 30; attempt += 1) {
		const source = await findVirtualDisplay();
		if (source) return source;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(
		`Virtual display ${getExpectedDisplayID()} did not become capture-ready within 30 seconds`,
	);
}

function startSharingForConnectedViewer(session: SharingSession): void {
	return session.setOnDeviceConnectedCallback((device) => {
		if (sharingSession !== session || session.status !== SharingSessionStatusEnum.NOT_CONNECTED) {
			console.log('[iPad Host] Ignoring a duplicate viewer connection event');
			return;
		}

		const deskreenGlobal = getDeskreenGlobal();
		if (!deskreenGlobal.connectedDevicesService.isSlotAvailable()) {
			void session.denyConnectionForPartner();
			return;
		}

		try {
			deskreenGlobal.connectedDevicesService.addDevice(device);
			session.setDeviceID(device.id);
			// CONNECTED emits ALLOWED_TO_CONNECT through Deskreen's existing path.
			session.setStatus(SharingSessionStatusEnum.CONNECTED);
			session.callPeer();
			session.setStatus(SharingSessionStatusEnum.SHARING);
			console.log('[iPad Host] Viewer approved; starting Deskreen simple-peer call');
		} catch (error) {
			console.error('[iPad Host] Failed to start viewer stream', error);
			session.setStatus(SharingSessionStatusEnum.ERROR);
			void session.denyConnectionForPartner();
		}
	});
}

function createSharingSession(source: VirtualDisplaySource): SharingSession {
	const deskreenGlobal = getDeskreenGlobal();
	deskreenGlobal.roomIDService.markRoomIDAsTaken(IPAD_FIXED_ROOM_ID);

	const session = new SharingSession(
		IPAD_FIXED_ROOM_ID,
		hostUser,
		deskreenGlobal.rendererWebrtcHelpersService,
	);
	session.setDesktopCapturerSourceID(source.sourceID);
	deskreenGlobal.sharingSessionService.sharingSessions.set(session.id, session);
	startSharingForConnectedViewer(session);
	return session;
}

async function restartSharingSession(sessionID: string): Promise<void> {
	if (isQuitting || restartInProgress || sharingSession?.id !== sessionID) return;
	restartInProgress = true;
	try {
		const previousSession = sharingSession;
		sharingSession = null;
		previousSession?.destroy();
		const deskreenGlobal = getDeskreenGlobal();
		deskreenGlobal.sharingSessionService.sharingSessions.delete(sessionID);
		deskreenGlobal.roomIDService.unmarkRoomIDAsTaken(IPAD_FIXED_ROOM_ID);
		if (!virtualDisplay) throw new Error('Virtual display source was lost');
		sharingSession = createSharingSession(virtualDisplay);
		console.log('[iPad Host] Reset session after viewer disconnect');
	} finally {
		restartInProgress = false;
	}
}

function registerIpadIPCHandlers(): void {
	ipcMain.handle(IpcEvents.GetPort, () => signalingServer.port);
	ipcMain.handle(IpcEvents.GetSourceDisplayIDByDesktopCapturerSourceID, (_, sourceID) =>
		virtualDisplay?.sourceID === sourceID ? virtualDisplay.displayID : '',
	);
	ipcMain.handle('get-display-size-by-display-id', (_, displayID: string) => {
		if (!virtualDisplay || displayID !== virtualDisplay.displayID) return undefined;
		return { width: virtualDisplay.width, height: virtualDisplay.height };
	});
	ipcMain.handle(IpcEvents.GetAppLanguage, () => 'en');
	ipcMain.handle(IpcEvents.DisconnectDeviceById, (_, deviceID: string) =>
		getDeskreenGlobal().connectedDevicesService.disconnectDeviceByID(deviceID),
	);
	ipcMain.handle(IpcEvents.DestroySharingSessionById, (_, sessionID: string) => {
		void restartSharingSession(sessionID);
	});
	// The fixed room remains owned for the host lifetime; a reconnect gets a fresh
	// helper session without exposing a transient unpaired room to another client.
	ipcMain.handle(IpcEvents.UnmarkRoomIDAsTaken, () => undefined);
}

async function startIpadHost(): Promise<void> {
	if (process.env.IPAD_BIND_IP && process.env.IPAD_BIND_IP !== IPAD_BIND_IP) {
		throw new Error(`iPad mode requires ${IPAD_BIND_IP}, not ${process.env.IPAD_BIND_IP}`);
	}
	if (process.env.IPAD_FIXED_ROOM_ID && process.env.IPAD_FIXED_ROOM_ID !== IPAD_FIXED_ROOM_ID) {
		throw new Error(`iPad mode requires room ${IPAD_FIXED_ROOM_ID}`);
	}

	app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
	if (!app.requestSingleInstanceLock()) {
		throw new Error('Another iPad host instance is already running');
	}
	await app.whenReady();
	if (process.platform === 'darwin') app.setActivationPolicy('accessory');

	startLogBufferCleanup();
	const appPath = join(__dirname, '..');
	initGlobals(appPath, IPAD_BIND_IP, true);
	registerIpadIPCHandlers();

	await signalingServer.start();
	if (signalingServer.port !== IPAD_PORT) {
		throw new Error(`iPad mode unexpectedly selected port ${signalingServer.port}`);
	}
	virtualDisplay = await waitForVirtualDisplay();
	sharingSession = createSharingSession(virtualDisplay);
	console.log(`[iPad Host] Ready at http://${IPAD_BIND_IP}:${IPAD_PORT}/`);
}

app.on('before-quit', () => {
	isQuitting = true;
	sharingSession?.destroy();
	try {
		signalingServer.stop();
	} catch (_) {
		// The server may not have reached listen() when startup failed.
	}
});

void startIpadHost().catch((error) => {
	console.error('[iPad Host] Fatal startup error:', error);
	app.exit(1);
});
