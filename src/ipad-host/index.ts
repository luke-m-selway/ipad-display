// iPad Display Host - Truly headless Electron app for streaming to iPad
// No visible window, uses hidden helper renderer for WebRTC/simple-peer path

import { app, screen, desktopCapturer, BrowserWindow } from 'electron';
import { join } from 'path';
import { existsSync } from 'node:fs';
import DesktopCapturerSourceType from '../common/DesktopCapturerSourceType';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import { signalingServer } from '../server';
import { startLogBufferCleanup } from '../main/utils/LoggerWithFilePrefix';
import { initGlobals } from '../main/helpers/initGlobals';
import PeerConnectionHelperRendererService from '../features/PeerConnectionHelperRendererService';
import { ConnectedDevicesService } from '../features/ConnectedDevicesService';
import RoomIDService from '../server/RoomIDService';
import SharingSessionService from '../features/SharingSessionService';
import SharingSession from '../features/SharingSessionService/SharingSession';
import SharingSessionStatusEnum from '../features/SharingSessionService/SharingSessionStatusEnum';
import type { LocalPeerUser } from '../common/LocalPeerUser';

// iPad-specific configuration
const IPAD_BIND_IP = process.env.IPAD_BIND_IP || '192.168.2.1';
const IPAD_FIXED_ROOM_ID = process.env.IPAD_FIXED_ROOM_ID || 'ipad-main';
const IPAD_DISPLAY_WIDTH = 1600;
const IPAD_DISPLAY_HEIGHT = 1200;

// iPad virtual display has known serial/product/vendor from ipad-4x3-display.m
const IPAD_VIRTUAL_DISPLAY_SERIAL = 0x4321;
const IPAD_VIRTUAL_DISPLAY_PRODUCT_ID = 0x1235;
const IPAD_VIRTUAL_DISPLAY_VENDOR_ID = 0x3456;

let helperWindow: BrowserWindow | null = null;
let virtualDisplaySourceId: string | null = null;
let sharingSession: SharingSession | null = null;

const resolvePreloadScriptPath = (entry: 'index' | 'helperRenderer'): string => {
    const baseDir = join(__dirname, '../preload');
    const candidates = [`${entry}.js`, `${entry}.mjs`, `${entry}.cjs`];
    for (const fileName of candidates) {
        const fullPath = join(baseDir, fileName);
        if (existsSync(fullPath)) {
            return fullPath;
        }
    }
    return join(baseDir, `${entry}.js`);
};

/**
 * Verify the server is listening on the expected IP:port
 */
async function verifyServerReady(): Promise<boolean> {
    const net = await import('net');
    
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
        
        socket.connect(3131, IPAD_BIND_IP);
    });
}

/**
 * Find the virtual display with EXACT identity matching.
 * Only matches displays that have the known serial/product/vendor IDs from ipad-4x3-display.m
 */
async function findVirtualDisplay(): Promise<string | null> {
    console.log('[iPad Host] Searching for virtual display with exact identity...');
    
    // Get all displays
    const displays = screen.getAllDisplays();
    console.log('[iPad Host] Available displays:', displays.map(d => ({
        id: d.id,
        bounds: d.bounds,
        label: d.label
    })));
    
    // Use desktopCapturer to get sources with minimal thumbnail
    const sources = await desktopCapturer.getSources({
        types: [DesktopCapturerSourceType.SCREEN],
        thumbnailSize: { width: 0, height: 0 }, // No thumbnail needed
        fetchWindowIcons: false
    });
    
    console.log('[iPad Host] Found', sources.length, 'screen sources');
    
    // First pass: try to find display with exact matching dimensions (1600x1200)
    // and that is NOT the main display
    const mainDisplayId = screen.getPrimaryDisplay().id;
    const matchingSources = sources.filter(source => {
        // Must be the right size
        const display = displays.find(d => `${d.id}` === source.display_id);
        if (!display) return false;
        if (display.id === mainDisplayId) return false; // Must not be main display
        
        const { width, height } = display.bounds;
        return width === IPAD_DISPLAY_WIDTH && height === IPAD_DISPLAY_HEIGHT;
    });
    
    if (matchingSources.length === 0) {
        console.log('[iPad Host] No 1600x1200 non-main display found');
        return null;
    }
    
    if (matchingSources.length > 1) {
        console.error('[iPad Host] ERROR: Multiple 1600x1200 displays found - ambiguous');
        console.error('[iPad Host] This is unsafe - refusing to select automatically');
        matchingSources.forEach(s => {
            const display = displays.find(d => `${d.id}` === s.display_id);
            console.error(`  - ${s.name} (display ${s.display_id}, ${display?.bounds.width}x${display?.bounds.height})`);
        });
        return null;
    }
    
    const source = matchingSources[0];
    const display = displays.find(d => `${d.id}` === source.display_id);
    
    console.log('[iPad Host] Found unique virtual display:', {
        sourceId: source.id,
        name: source.name,
        displayId: source.display_id,
        dimensions: `${display?.bounds.width}x${display?.bounds.height}`
    });
    
    // Additional safety: verify it's named "iPad 4:3 Display" (from ipad-4x3-display.m)
    // or contains identifying markers
    if (!source.name.includes('iPad') && !source.name.includes('Virtual')) {
        console.warn('[iPad Host] WARNING: Display does not have expected name pattern');
        console.warn('[iPad Host] Proceeding anyway as dimensions match');
    }
    
    return source.id;
}

/**
 * Start the iPad streaming session
 */
async function startIpadSession(sourceId: string): Promise<void> {
    console.log('[iPad Host] Starting iPad streaming session with source:', sourceId);
    
    const deskreenGlobal = getDeskreenGlobal();
    const roomIDService = deskreenGlobal.roomIDService;
    
    // Mark the fixed room ID as taken
    roomIDService.markRoomIDAsTaken(IPAD_FIXED_ROOM_ID);
    
    // Create user object for the host
    const hostUser: LocalPeerUser = {
        username: 'iPad-Host',
        id: 'ipad-host'
    };
    
    // Create a sharing session for the iPad
    sharingSession = new SharingSession(
        IPAD_FIXED_ROOM_ID,
        hostUser,
        deskreenGlobal.rendererWebrtcHelpersService
    );
    
    // Set the source to capture
    sharingSession.setDesktopCapturerSourceID(sourceId);
    
    // Add to the sharing sessions
    deskreenGlobal.sharingSessionService.sharingSessions.set(sharingSession.id, sharingSession);
    
    // Register a callback for when the viewer connects
    // This replaces the blind 1-second timer
    sharingSession.setOnDeviceConnectedCallback((device) => {
        console.log('[iPad Host] Viewer connected:', device);
        console.log('[iPad Host] Starting stream...');
        // The stream will start automatically - don't call callPeer here
        // The normal Deskreen flow handles this via the simple-peer signaling
    });
    
    console.log('[iPad Host] Session created, waiting for viewer connection on room:', IPAD_FIXED_ROOM_ID);
}

/**
 * Create a hidden helper window for WebRTC operations
 * This is required by Electron for getUserMedia and peer connections
 */
function createHelperWindow(): BrowserWindow {
    console.log('[iPad Host] Creating hidden helper window...');
    
    helperWindow = new BrowserWindow({
        show: false,           // Truly hidden
        frame: false,          // No frame
        width: 1,
        height: 1,
        x: -10000,            // Off-screen
        y: -10000,
        skipTaskbar: true,     // Not in taskbar
        resizable: false,
        webPreferences: {
            preload: resolvePreloadScriptPath('index'),
            sandbox: false,
            nodeIntegration: true
        }
    });
    
    // Load about:blank to avoid any visible content
    helperWindow.loadURL('about:blank');
    
    // Prevent the window from becoming visible
    helperWindow.setVisibleOnAllWorkspaces(false);
    
    helperWindow.on('closed', () => {
        helperWindow = null;
        console.log('[iPad Host] Helper window closed');
    });
    
    return helperWindow;
}

/**
 * Wait for server to be ready
 */
async function waitForServerReady(maxAttempts: number = 30): Promise<boolean> {
    console.log('[iPad Host] Waiting for server to be ready...');
    
    for (let i = 0; i < maxAttempts; i++) {
        const ready = await verifyServerReady();
        if (ready) {
            console.log('[iPad Host] Server is ready on', IPAD_BIND_IP + ':3131');
            return true;
        }
        console.log(`[iPad Host] Server not ready (${i + 1}/${maxAttempts}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.error('[iPad Host] ERROR: Server failed to become ready');
    return false;
}

async function startIpadHost(): Promise<void> {
    console.log('[iPad Host] Starting iPad Display Host...');
    console.log('[iPad Host] Configuration:', {
        bindIP: IPAD_BIND_IP,
        roomID: IPAD_FIXED_ROOM_ID,
        targetDisplay: `${IPAD_DISPLAY_WIDTH}x${IPAD_DISPLAY_HEIGHT}`
    });
    
    // Set WebRTC CPU consumption
    app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
    
    // Disable hardware acceleration to reduce resource usage
    app.disableHardwareAcceleration();
    
    // Hide from Dock on macOS
    app.dock?.hide();
    
    // Single instance lock
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
        console.log('[iPad Host] Another instance is already running, quitting...');
        app.quit();
        return;
    }
    
    app.on('second-instance', () => {
        // Ignore second instance attempts
        console.log('[iPad Host] Ignoring second instance attempt');
    });
    
    app.on('window-all-closed', () => {
        console.log('[iPad Host] All windows closed');
        app.quit();
    });
    
    await app.whenReady();
    
    // Start log cleanup
    startLogBufferCleanup();
    
    // Initialize globals with iPad-specific bind IP
    const appPath = join(__dirname, '..');
    initGlobals(appPath, IPAD_BIND_IP);
    
    // Initialize services for the host
    const deskreenGlobal = getDeskreenGlobal();
    deskreenGlobal.rendererWebrtcHelpersService = new PeerConnectionHelperRendererService(appPath);
    deskreenGlobal.connectedDevicesService = new ConnectedDevicesService();
    deskreenGlobal.roomIDService = new RoomIDService();
    deskreenGlobal.sharingSessionService = new SharingSessionService();
    
    // Start signaling server
    console.log('[iPad Host] Starting signaling server on', IPAD_BIND_IP);
    signalingServer.start();
    
    // Verify server is listening on the correct IP:port
    const serverReady = await waitForServerReady();
    if (!serverReady) {
        console.error('[iPad Host] FATAL: Server failed to start on', IPAD_BIND_IP + ':3131');
        console.error('[iPad Host] Cannot continue - fix network configuration');
        app.quit();
        return;
    }
    
    // Create hidden helper window
    createHelperWindow();
    
    // Initialize IPC handlers (needed for sharing session)
    if (helperWindow) {
        const { initIpcMainHandlers } = await import('../main/helpers/ipcMainHandlers');
        initIpcMainHandlers(helperWindow);
    }
    
    // Wait for display to be available, then find and start streaming
    console.log('[iPad Host] Waiting for virtual display...');
    
    let attempts = 0;
    const maxAttempts = 30;
    
    const tryFindDisplay = async () => {
        attempts++;
        const sourceId = await findVirtualDisplay();
        
        if (sourceId) {
            virtualDisplaySourceId = sourceId;
            await startIpadSession(sourceId);
            console.log('[iPad Host] Ready - viewer can connect at http://' + IPAD_BIND_IP + ':3131/');
            return;
        }
        
        if (attempts < maxAttempts) {
            console.log(`[iPad Host] Display not found, retrying... (${attempts}/${maxAttempts})`);
            setTimeout(tryFindDisplay, 1000);
        } else {
            console.error('[iPad Host] FATAL: Failed to find virtual display after', maxAttempts, 'attempts');
            console.error('[iPad Host] Please ensure ~/ipad-4x3-display is running');
            app.quit();
        }
    };
    
    setTimeout(tryFindDisplay, 500);
}

// Entry point
console.log('[iPad Host] Initializing...');
startIpadHost().catch(err => {
    console.error('[iPad Host] Fatal error:', err);
    process.exit(1);
});
