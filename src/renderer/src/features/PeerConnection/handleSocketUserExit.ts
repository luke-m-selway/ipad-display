export default (
	peerConnection: PeerConnection,
	payload: { users: PartnerPeerUser[] },
): void => {
	if (!peerConnection.isSocketRoomLocked || !peerConnection.isCallStarted)
		return;

	const activePartnerIsStillInRoom = payload.users.some(
		(user) => user.socketId === peerConnection.partner.socketId,
	);
	if (activePartnerIsStillInRoom) return;

	peerConnection.toggleLockRoom(false);
	peerConnection.selfDestroy();
};
