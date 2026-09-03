import socketIO from 'socket.io-client';

export const connectSocket = (
	port: string,
	roomId: string,
	signalingHost = 'http://127.0.0.1',
) => {
	return socketIO(`${signalingHost}:${port}`, {
		query: {
			roomId,
		},
		forceNew: true,
	});
};

export default {};
