import socketIO from 'socket.io-client';

const IPAD_HOST_SIGNALING_URL = 'http://192.168.2.1';

export const connectSocket = (port: string, roomId: string) => {
	const signalingHost =
		process.env.IPAD_MODE === '1'
			? IPAD_HOST_SIGNALING_URL
			: 'http://127.0.0.1';
	return socketIO(`${signalingHost}:${port}`, {
		query: {
			roomId,
		},
		forceNew: true,
	});
};

export default {};
