// iPad Display Host - Lightweight Electron app for streaming to iPad
// This replaces the full Deskreen UI with a minimal streaming-only host

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

let mainWindow: BrowserWindow | null = null;
let virtualDisplaySourceId: string | null = null;

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

async function findVirtualDisplay(): Promise<string | null> {
    console.log('[iPad Host] Searching for virtual display...');
    
    // Get all displays to log for debugging
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
    
    for (const source of sources) {
        console.log('[iPad Host] Source:', {
            id: source.id,
            name: source.name,
            display_id: source.display_id
        });
        
        // Try to match by display ID
        const display = displays.find(d => `${d.id}` === source.display_id);
        if (display) {
            const { width, height } = display.bounds;
            console.log(`[iPad Host] Display ${display.id}: ${width}x${height}`);
            
            // Match the 1600x1200 virtual display
            if (width === IPAD_DISPLAY_WIDTH && height === IPAD_DISPLAY_HEIGHT) {
                console.log('[iPad Host] Found matching virtual display:', source.id);
                return source.id;
            }
        }
        
        // Fallback: match by name
        if (source.name.includes('iPad') || source.name.includes('Virtual')) {
            console.log('[iPad Host] Found potential virtual display by name:', source.id);
            return source.id;
        }
    }
    
    console.log('[iPad Host] WARNING: No 1600x1200 virtual display found');
    return null;
}

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
    const sharingSession = new SharingSession(
        IPAD_FIXED_ROOM_ID,
        hostUser,
        deskreenGlobal.rendererWebrtcHelpersService
    );
    
    // Set the source to capture
    sharingSession.setDesktopCapturerSourceID(sourceId);
    
    // Add to the sharing sessions
    deskreenGlobal.sharingSessionService.sharingSessions.set(sharingSession.id, sharingSession);
    
    // Auto-start the stream after a short delay
    setTimeout(() => {
        console.log('[iPad Host] Calling peer to start streaming...');
        sharingSession.callPeer();
        sharingSession.setStatus(SharingSessionStatusEnum.CONNECTED);
    }, 1000);
}

function createMainWindow(): BrowserWindow {
    console.log('[iPad Host] Creating minimal window...');
    
    mainWindow = new BrowserWindow({
        show: true, // Show the window for debugging
        width: 400,
        height: 200,
        frame: true,
        skipTaskbar: false,
        webPreferences: {
            preload: resolvePreloadScriptPath('index'),
            sandbox: false,
            nodeIntegration: true
        }
    });
    
    // Load a minimal status page
    mainWindow.loadURL('data:text/html,<html><body style="background:#1a1a2e;color:#fff;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;"><h2>iPad Display Active</h2><p style="margin-top:10px;">Connect iPad at: <strong>http://192.168.2.1:3131/</strong></p><p style="margin-top:20px;font-size:12px;color:#888;">Streaming from 1600x1200 virtual display</p></body></html>');
    
    mainWindow.on('closed', () => {
        mainWindow = null;
        console.log('[iPad Host] Main window closed');
    });
    
    return mainWindow;
}

async function startIpadHost(): Promise<void> {
    console.log('[iPad Host] Starting iPad Display Host...');
    console.log('[iPad Host] Configuration:', {
        bindIP: IPAD_BIND_IP,
        roomID: IPAD_FIXED_ROOM_ID,
        targetDisplay: `${IPAD_DISPLAY_WIDTH}x${IPAD_DISPLAY_HEIGHT}`
    });
    
    // Disable GPU for potentially better compatibility
    // app.disableHardwareAcceleration();
    
    // Set WebRTC CPU consumption
    app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
    
    // Single instance lock
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
        console.log('[iPad Host] Another instance is already running, quitting...');
        app.quit();
        return;
    }
    
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
    
    app.on('window-all-closed', () => {
        console.log('[iPad Host] All windows closed');
        if (process.platform !== 'darwin') {
            app.quit();
        }
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
    
    // Create main window
    createMainWindow();
    
    // Initialize IPC handlers (needed for sharing session)
    if (mainWindow) {
        const { initIpcMainHandlers } = await import('../main/helpers/ipcMainHandlers');
        initIpcMainHandlers(mainWindow);
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
            return;
        }
        
        if (attempts < maxAttempts) {
            console.log(`[iPad Host] Display not found, retrying... (${attempts}/${maxAttempts})`);
            setTimeout(tryFindDisplay, 1000);
        } else {
            console.error('[iPad Host] Failed to find virtual display after', maxAttempts, 'attempts');
            console.error('[iPad Host] Please ensure the virtual display is running');
            console.error('[iPad Host] Run: ~/ipad-4x3-display');
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
