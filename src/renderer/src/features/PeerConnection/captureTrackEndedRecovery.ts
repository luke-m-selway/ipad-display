type CaptureTrack = Pick<
	MediaStreamTrack,
	'addEventListener' | 'readyState' | 'removeEventListener'
>;

export default function watchCaptureTrackEnded(
	track: CaptureTrack,
	isCurrentTrack: () => boolean,
	onUnexpectedEnd: () => void,
): () => void {
	let stopped = false;
	let recoveryRequested = false;

	const onEnded = (): void => {
		if (stopped || recoveryRequested || !isCurrentTrack()) return;
		recoveryRequested = true;
		onUnexpectedEnd();
	};

	track.addEventListener('ended', onEnded);
	if (track.readyState === 'ended') onEnded();

	return () => {
		stopped = true;
		track.removeEventListener('ended', onEnded);
	};
}
