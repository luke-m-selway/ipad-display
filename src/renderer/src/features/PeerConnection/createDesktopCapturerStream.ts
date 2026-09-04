import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import getDesktopSourceStreamBySourceID from './getDesktopSourceStreamBySourceID';

export default async function createDesktopCapturerStream(
	peerConnection: PeerConnection,
	sourceID: string,
): Promise<void> {
	try {
		if (process.env.RUN_MODE === 'test') return;

		if (sourceID.includes(DesktopCapturerSourceType.SCREEN)) {
			const captureSize =
				peerConnection.sourceCaptureSize ?? peerConnection.sourceDisplaySize;
			const captureMultiplier = peerConnection.sourceCaptureSize
				? 1
				: undefined;
			const stream = await getDesktopSourceStreamBySourceID(
				sourceID,
				captureSize?.width,
				captureSize?.height,
				captureMultiplier ?? 0.5,
				captureMultiplier ?? 1,
				15,
				peerConnection.sourceCaptureSize ? 30 : 60,
			);
			peerConnection.localStream = stream;
			peerConnection.applyIpadVideoTrackContentHint();
		} else {
			// when source is app window
			const stream = await getDesktopSourceStreamBySourceID(sourceID);
			peerConnection.localStream = stream;
		}
	} catch (e) {
		console.error(e);
	}
}
