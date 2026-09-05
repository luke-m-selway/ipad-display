export type RoomDisconnectMember = {
	socketId: string;
	username: string;
	isOwner: boolean;
};

type SocketWithDisconnectData = {
	id: string;
	data: Record<string, unknown>;
};

export type DisconnectOwnership =
	| { kind: 'active'; member: RoomDisconnectMember }
	| { kind: 'duplicate' }
	| { kind: 'stale' };

const DISCONNECT_CLAIM_KEY = 'darkwireDisconnectClaimed';

export function claimCurrentRoomDisconnect(
	socket: SocketWithDisconnectData,
	users: RoomDisconnectMember[],
): DisconnectOwnership {
	if (socket.data[DISCONNECT_CLAIM_KEY] === true) {
		return { kind: 'duplicate' };
	}

	const member = users.find((user) => user.socketId === socket.id);
	if (!member) return { kind: 'stale' };

	// A socket can report both an explicit USER_DISCONNECT and transport
	// disconnect. Claim it before teardown so only its current room membership
	// can produce one USER_EXIT event.
	socket.data[DISCONNECT_CLAIM_KEY] = true;
	return { kind: 'active', member };
}
