import { IpcEvents } from '../../../../common/IpcEvents.enum';
import NullSimplePeer from './NullSimplePeer';
import NullUser from './NullUser';

export default function handleSelfDestroy(
	peerConnection: PeerConnection,
	reason: string,
): void {
	if (peerConnection.isIpadMode) {
		peerConnection.stopStallDiagnostics();
		peerConnection.stopCaptureTrackEndedRecovery();
	}
	peerConnection.partner = NullUser;
	window.electron.ipcRenderer.invoke(
		IpcEvents.DisconnectDeviceById,
		peerConnection.partnerDeviceDetails.id,
	);

	// remove window event listener
	if (peerConnection.beforeunloadHandler) {
		window.removeEventListener(
			'beforeunload',
			peerConnection.beforeunloadHandler,
		);
		peerConnection.beforeunloadHandler = null;
	}

	// cleanup peer connection and remove all event listeners
	if (peerConnection.peer !== NullSimplePeer) {
		try {
			// remove all event listeners before destroying
			peerConnection.peer.removeAllListeners();
			peerConnection.peer.destroy();
		} catch (error) {
			console.error('Error destroying peer:', error);
		}
		peerConnection.peer = NullSimplePeer;
	}

	// cleanup media stream
	if (peerConnection.localStream) {
		peerConnection.localStream.getTracks().forEach((track) => {
			track.stop();
		});
		peerConnection.localStream = null;
	}

	if (!peerConnection.isIpadMode) {
		peerConnection.socket.removeAllListeners();
		peerConnection.socket.disconnect();
	}

	window.electron.ipcRenderer.invoke(
		IpcEvents.DestroySharingSessionById,
		peerConnection.isIpadMode
			? { sessionID: peerConnection.sharingSessionID, reason }
			: peerConnection.sharingSessionID,
	);

	if (peerConnection.isIpadMode) {
		// Preserve the reset reason before the owner socket's disconnect can
		// independently request the same generation transition.
		peerConnection.socket.removeAllListeners();
		peerConnection.socket.disconnect();
	}
	peerConnection.onDeviceConnectedCallback = () => {
		// reset callback after destruction
	};
	peerConnection.isCallStarted = false;

	window.electron.ipcRenderer.invoke(
		IpcEvents.UnmarkRoomIDAsTaken,
		peerConnection.roomID,
	);
}
