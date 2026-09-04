// import SimplePeer from 'simple-peer';
import createDesktopCapturerStream from './createDesktopCapturerStream';
import handlePeerOnData from './handlePeerOnData';
import { startIpadStallDiagnostics } from './ipadStallDiagnostics';
import NullSimplePeer from './NullSimplePeer';
// import simplePeerHandleSdpTransform from './simplePeerHandleSdpTransform';

export default function handleCreatePeer(
	peerConnection: PeerConnection,
): Promise<void> {
	return new Promise((resolve, reject) => {
		peerConnection.stopStallDiagnostics();
		peerConnection.stopCaptureTrackEndedRecovery();
		// cleanup existing peer before creating new one
		if (peerConnection.peer !== NullSimplePeer) {
			try {
				peerConnection.peer.removeAllListeners();
				peerConnection.peer.destroy();
			} catch (error) {
				console.error('Error cleaning up existing peer:', error);
			}
			peerConnection.peer = NullSimplePeer;
		}

		// cleanup existing stream before creating new one
		if (peerConnection.localStream) {
			peerConnection.localStream.getTracks().forEach((track) => {
				track.stop();
			});
			peerConnection.localStream = null;
		}

		// clear old signals and reset call state when recreating peer
		peerConnection.signalsDataToCallUser = [];
		peerConnection.isCallStarted = false;

		createDesktopCapturerStream(
			peerConnection,
			peerConnection.desktopCapturerSourceID,
		)
			.then(() => {
				// if (peerConnection.peer === NullSimplePeer) {
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				peerConnection.peer = new SimplePeer({
					initiator: true,
					// trickle: false,
					// wrtc: window.api.wrtc,
					config: { iceServers: [] },
					// sdpTransform: simplePeerHandleSdpTransform,
				});
				// }

				// TODO: basically here we need a client side simple peer, but we get a nodejs side simple peer
				if (peerConnection.localStream !== null) {
					peerConnection.peer.addStream(peerConnection.localStream);
					if (peerConnection.sourceCaptureSize) {
						void peerConnection.applyDegradationPreference();
					}
				}

				peerConnection.peer.on('signal', (data) => {
					// fired when simple peer and webrtc done preparation to start call on peerConnection machine
					peerConnection.signalsDataToCallUser.push(data);
					// The dedicated host may receive DEVICE_DETAILS before Chromium has
					// generated its first offer. Preserve the normal callPeer contract
					// while delivering any later trickle signal to the approved viewer.
					if (peerConnection.isCallStarted) {
						void peerConnection.sendEncryptedMessage({
							type: 'CALL_USER',
							payload: { signalData: data },
						});
					}
				});

				peerConnection.peer.on('data', (data) => {
					handlePeerOnData(peerConnection, data);
				});

				// ensure cleanup on peer end/error to prevent dangling helper window
				peerConnection.peer.on('close', () => {
					peerConnection.selfDestroy();
				});

				peerConnection.peer.on('error', (e: Error) => {
					console.error('peerConnection peer error', e);
					peerConnection.selfDestroy();
				});
				const captureTrack = peerConnection.localStream?.getVideoTracks()[0];
				if (captureTrack) {
					peerConnection.watchIpadCaptureTrackEnded(captureTrack);
				}
				if (peerConnection.isSelfDestroying) {
					resolve(undefined);
					return;
				}
				const peer = peerConnection.peer;
				void startIpadStallDiagnostics(peerConnection).then((cleanup) => {
					if (!cleanup) return;
					if (peerConnection.peer === peer) {
						peerConnection.stallDiagnosticsCleanup = cleanup;
					} else {
						cleanup();
					}
				});
				resolve(undefined);
			})
			.catch((e) => {
				console.error(e);
				reject();
			});
	});
}
