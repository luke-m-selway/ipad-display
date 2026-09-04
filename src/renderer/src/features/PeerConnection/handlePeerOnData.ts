import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import getDesktopSourceStreamBySourceID from './getDesktopSourceStreamBySourceID';
import NullSimplePeer from './NullSimplePeer';
import prepareDataMessageToSendScreenSourceType from './prepareDataMessageToSendScreenSourceType';

export default async function handlePeerOnData(
	peerConnection: PeerConnection,
	data: string,
): Promise<void> {
	const dataJSON = JSON.parse(data);

	if (dataJSON.type === 'set_video_quality') {
		const maxVideoQualityMultiplier = dataJSON.payload.value;
		const minVideoQualityMultiplier =
			maxVideoQualityMultiplier === 1 ? 0.5 : maxVideoQualityMultiplier;

		if (
			!peerConnection.desktopCapturerSourceID.includes(
				DesktopCapturerSourceType.SCREEN,
			)
		)
			return;

		const captureSize =
			peerConnection.sourceCaptureSize ?? peerConnection.sourceDisplaySize;
		const captureMultiplier = peerConnection.sourceCaptureSize
			? 1
			: maxVideoQualityMultiplier;
		const newStream = await getDesktopSourceStreamBySourceID(
			peerConnection.desktopCapturerSourceID,
			captureSize?.width,
			captureSize?.height,
			peerConnection.sourceCaptureSize ? 1 : minVideoQualityMultiplier,
			captureMultiplier,
			peerConnection.sourceCaptureSize ? 15 : 60,
			peerConnection.sourceCaptureSize ? 30 : 60,
		);
		peerConnection.applyIpadVideoTrackContentHint(newStream);
		const newVideoTrack = newStream.getVideoTracks()[0];
		const oldStream = peerConnection.localStream;
		const oldTrack = oldStream?.getVideoTracks()[0];

		if (oldTrack && oldStream && peerConnection.peer !== NullSimplePeer) {
			await peerConnection.peer.replaceTrack(
				oldTrack,
				newVideoTrack,
				oldStream,
			);
			// stop only the old track (it's already removed from the stream by replaceTrack)
			oldTrack.stop();
			// stop any remaining tracks in the old stream, but don't stop the new track
			oldStream.getTracks().forEach((track) => {
				if (track.id !== newVideoTrack.id) {
					track.stop();
				}
			});
		}

		// update local stream reference to new stream
		peerConnection.localStream = newStream;
	}

	if (dataJSON.type === 'get_sharing_source_type') {
		const sourceType = peerConnection.desktopCapturerSourceID.includes(
			DesktopCapturerSourceType.SCREEN,
		)
			? DesktopCapturerSourceType.SCREEN
			: DesktopCapturerSourceType.WINDOW;

		peerConnection.peer.send(
			prepareDataMessageToSendScreenSourceType(sourceType),
		);
	}
}
