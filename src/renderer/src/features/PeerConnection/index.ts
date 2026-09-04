import { Socket } from 'socket.io-client';
import { connectSocket } from '../../../../common/connectSocket';
import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import { Device } from '../../../../common/Device';
import getAppLanguage from '../../../../common/getAppLanguage';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import { LocalPeerUser } from '../../../../common/LocalPeerUser';
import type { SendEncryptedMessagePayload } from '../../../../common/SendEncryptedMessagePayload';
import { handleRecieveEncryptedMessage } from '../../utils/handleRecieveEncryptedMessage';
import { prepare as prepareMessage } from '../../utils/message';
import getDesktopSourceStreamBySourceID from './getDesktopSourceStreamBySourceID';
import handleCreatePeer from './handleCreatePeer';
import handleSelfDestroy from './handleSelfDestroy';
import setDisplaySizeFromLocalStream from './handleSetDisplaySizeFromLocalStream';
import handleSocket from './handleSocket';
import NullSimplePeer from './NullSimplePeer';
import NullUser from './NullUser';

type DisplaySize = { width: number; height: number };
type IpadDisplaySize = DisplaySize & {
	captureWidth?: number;
	captureHeight?: number;
};
type SimplePeerWithRTCPeerConnection = {
	_pc?: RTCPeerConnection;
};
type WebRTCStats = RTCStats & Record<string, unknown>;

function reportIpadDiagnostic(
	kind: 'Capture' | 'Sender',
	values: Record<string, unknown>,
): void {
	window.electron.ipcRenderer.send(IpcEvents.IpadDiagnostic, { kind, values });
}

function getVideoOutboundStats(
	report: RTCStatsReport,
): WebRTCStats | undefined {
	let outbound: WebRTCStats | undefined;
	report.forEach((stats) => {
		const candidate = stats as WebRTCStats;
		if (
			candidate.type === 'outbound-rtp' &&
			(candidate.kind === 'video' || candidate.mediaType === 'video')
		) {
			outbound = candidate;
		}
	});
	return outbound;
}

function numericStat(
	stats: WebRTCStats | undefined,
	name: string,
): number | undefined {
	const value = stats?.[name];
	return typeof value === 'number' ? value : undefined;
}

export interface PartnerPeerUser {
	username: string;
}

export default class PeerConnection {
	sharingSessionID: string;
	roomID: string;
	socket: Socket;
	user: LocalPeerUser;
	partner: PartnerPeerUser;
	peer = NullSimplePeer;
	desktopCapturerSourceID: string;
	localStream: MediaStream | null;
	isSocketRoomLocked: boolean;
	partnerDeviceDetails = {
		id: '',
		sharingSessionID: '',
		deviceOS: '',
		deviceType: '',
		deviceIP: '',
		deviceBrowser: '',
		deviceScreenWidth: 0,
		deviceScreenHeight: 0,
	} as Device;
	signalsDataToCallUser: unknown[];
	isCallStarted: boolean;
	onDeviceConnectedCallback: (device: Device) => void;
	displayID: string;
	sourceDisplaySize: DisplaySize | undefined;
	sourceCaptureSize: DisplaySize | undefined;
	beforeunloadHandler: (() => void) | null = null;

	constructor(
		roomID: string,
		sharingSessionID: string,
		user: LocalPeerUser,
		port: string,
		signalingHost?: string,
	) {
		this.sharingSessionID = sharingSessionID;
		this.isSocketRoomLocked = false;
		this.roomID = encodeURI(roomID);
		this.socket = connectSocket(port, this.roomID, signalingHost);
		this.user = user;
		this.partner = NullUser;
		this.desktopCapturerSourceID = '';
		this.signalsDataToCallUser = [];
		this.isCallStarted = false;
		this.localStream = null;
		this.displayID = '';
		this.sourceDisplaySize = undefined;
		this.sourceCaptureSize = undefined;
		this.onDeviceConnectedCallback = () => {
			// noop until UI layer registers callback
		};

		handleSocket(this);

		this.beforeunloadHandler = () => {
			this.socket.emit('USER_DISCONNECT');
		};
		window.addEventListener('beforeunload', this.beforeunloadHandler);
	}

	notifyClientWithNewLanguage(): void {
		setTimeout(async () => {
			this.sendEncryptedMessage({
				type: 'APP_LANGUAGE',
				payload: {
					value: await getAppLanguage(),
				},
			});
		}, 1000);
	}

	async setDesktopCapturerSourceID(id: string): Promise<void> {
		this.desktopCapturerSourceID = id;
		if (process.env.RUN_MODE === 'test') return;

		// clear old display size when switching sources to ensure new source uses correct dimensions
		this.sourceDisplaySize = undefined;
		this.sourceCaptureSize = undefined;
		this.displayID = '';

		await this.setDisplayIDByDesktopCapturerSourceID();

		await this.handleCreatePeerAfterDesktopCapturerSourceIDWasSet();
	}

	async setDisplayIDByDesktopCapturerSourceID(): Promise<void> {
		if (
			!this.desktopCapturerSourceID.includes(DesktopCapturerSourceType.SCREEN)
		) {
			// clear display size for window sources
			this.sourceDisplaySize = undefined;
			this.sourceCaptureSize = undefined;
			return;
		}

		this.displayID = await window.electron.ipcRenderer.invoke(
			IpcEvents.GetSourceDisplayIDByDesktopCapturerSourceID,
			this.desktopCapturerSourceID,
		);

		if (this.displayID !== '') {
			// await to ensure sourceDisplaySize is set before creating stream
			await this.setDisplaySizeRetreivedFromMainProcess();
		}
	}

	async setDisplaySizeRetreivedFromMainProcess(): Promise<void> {
		const size: IpadDisplaySize | undefined =
			await window.electron.ipcRenderer.invoke(
				'get-display-size-by-display-id',
				this.displayID,
			);
		if (size) {
			this.sourceDisplaySize = { width: size.width, height: size.height };
			if (size.captureWidth && size.captureHeight) {
				this.sourceCaptureSize = {
					width: size.captureWidth,
					height: size.captureHeight,
				};
			}
		}
	}

	async handleCreatePeerAfterDesktopCapturerSourceIDWasSet(): Promise<void> {
		// if peer already exists, replace the track instead of creating a new peer
		if (this.peer !== NullSimplePeer && this.localStream) {
			try {
				const oldTrack = this.localStream.getVideoTracks()[0];
				if (!oldTrack) {
					await this.createPeer();
					if (!this.sourceDisplaySize) {
						setDisplaySizeFromLocalStream(this);
					}
					return;
				}

				const captureSize = this.sourceCaptureSize ?? this.sourceDisplaySize;
				const captureMultiplier = this.sourceCaptureSize ? 1 : undefined;
				const newStream = await getDesktopSourceStreamBySourceID(
					this.desktopCapturerSourceID,
					captureSize?.width,
					captureSize?.height,
					captureMultiplier ?? 0.5,
					captureMultiplier ?? 1,
				);
				this.configureIpadVideoTrack(newStream);
				const newVideoTrack = newStream.getVideoTracks()[0];

				if (!newVideoTrack) {
					await this.createPeer();
					if (!this.sourceDisplaySize) {
						setDisplaySizeFromLocalStream(this);
					}
					return;
				}

				// store reference to old stream before replacement
				const oldStream = this.localStream;

				// replace the track in the existing peer
				// replaceTrack will add the new track to the old stream
				await this.peer.replaceTrack(oldTrack, newVideoTrack, oldStream);

				// stop only the old track (it's already removed from the stream by replaceTrack)
				oldTrack.stop();

				// stop any remaining tracks in the old stream (should be none, but just in case)
				// but don't stop the new track that was just added by replaceTrack
				oldStream.getTracks().forEach((track) => {
					if (track.id !== newVideoTrack.id) {
						track.stop();
					}
				});

				// update local stream reference to the new stream
				// the new stream's track is now being used in the peer connection
				this.localStream = newStream;

				// update sourceDisplaySize from actual stream to ensure correct resolution
				// this is critical when switching sources to get the actual stream dimensions
				if (
					this.desktopCapturerSourceID.includes(
						DesktopCapturerSourceType.SCREEN,
					)
				) {
					setDisplaySizeFromLocalStream(this);
				} else {
					// clear for window sources
					this.sourceDisplaySize = undefined;
				}
			} catch (error) {
				console.error('Failed to replace stream track:', error);
				// fallback to creating a new peer if replacement fails
				await this.createPeer();
				if (!this.sourceDisplaySize) {
					setDisplaySizeFromLocalStream(this);
				}
			}
		} else {
			await this.createPeer();
			if (!this.sourceDisplaySize) {
				setDisplaySizeFromLocalStream(this);
			}
		}
	}

	setOnDeviceConnectedCallback(callback: (device: Device) => void): void {
		this.onDeviceConnectedCallback = callback;
	}

	async denyConnectionForPartner(): Promise<void> {
		await this.sendEncryptedMessage({
			type: 'DENY_TO_CONNECT',
			payload: {},
		});
		this.disconnectPartner();
	}

	sendUserAllowedToConnect(): void {
		this.sendEncryptedMessage({
			type: 'ALLOWED_TO_CONNECT',
			payload: {},
		});
	}

	async disconnectByHostMachineUser(deviceId: string): Promise<void> {
		if (this.partnerDeviceDetails.id !== deviceId) {
			return;
		}
		await this.sendEncryptedMessage({
			type: 'DISCONNECT_BY_HOST_MACHINE_USER',
			payload: {},
		});
		this.disconnectPartner();
		this.selfDestroy();
	}

	disconnectPartner(): void {
		this.socket.emit('DISCONNECT_SOCKET_BY_DEVICE_IP', {
			ip: this.partnerDeviceDetails.deviceIP,
		});

		this.partnerDeviceDetails = {} as Device;
	}

	selfDestroy(): void {
		handleSelfDestroy(this);
	}

	emitUserEnter(): void {
		this.socket.emit('USER_ENTER', {
			username: this.user.username,
		});
	}

	async sendEncryptedMessage(
		payload: SendEncryptedMessagePayload,
	): Promise<void> {
		if (!this.socket) return;
		if (!this.user) return;
		if (!this.partner) return;
		if (!this.partner.username) return;
		const msg = await prepareMessage(payload, this.user);
		this.socket.emit('MESSAGE', msg.toSend);
	}

	receiveEncryptedMessage(payload: ReceiveEncryptedMessagePayload): void {
		if (!this.user) return;
		handleRecieveEncryptedMessage(this, payload);
	}

	callPeer(): void {
		if (process.env.RUN_MODE === 'test') return;
		if (this.isCallStarted) return;
		this.isCallStarted = true;

		this.signalsDataToCallUser.forEach((data) => {
			this.sendEncryptedMessage({
				type: 'CALL_USER',
				payload: {
					signalData: data,
				},
			});
		});
	}

	createPeer(): Promise<void> {
		return handleCreatePeer(this);
	}

	toggleLockRoom(isConnected: boolean): void {
		this.socket.emit('TOGGLE_LOCK_ROOM');
		this.isSocketRoomLocked = isConnected;
	}

	/**
	 * Apply degradation preference to maintain resolution over frame rate.
	 * This should be called after the stream is attached to the peer.
	 */
	async applyDegradationPreference(): Promise<void> {
		// Access the underlying RTCPeerConnection via simple-peer's internal _pc
		const pc = (this.peer as unknown as SimplePeerWithRTCPeerConnection)?._pc;
		if (!pc || typeof pc.getSenders !== 'function') {
			console.log(
				'[PeerConnection] Leaving default degradation preference: sender is unavailable',
			);
			return;
		}

		try {
			const senders = pc.getSenders();
			const videoSender = senders.find(
				(sender: RTCRtpSender) => sender.track?.kind === 'video',
			);
			if (
				!videoSender ||
				typeof videoSender.getParameters !== 'function' ||
				typeof videoSender.setParameters !== 'function'
			) {
				console.log(
					'[PeerConnection] Leaving default degradation preference: API is unavailable',
				);
				return;
			}

			const parameters = videoSender.getParameters() as RTCRtpSendParameters & {
				degradationPreference?: string;
			};
			parameters.degradationPreference = 'maintain-resolution';
			await videoSender.setParameters(parameters);
			console.log(
				'[PeerConnection] Applied maintain-resolution to the outbound video sender',
			);
		} catch (e) {
			console.log(
				'[PeerConnection] Leaving default degradation preference after setParameters failed:',
				e,
			);
		}
	}

	async logIpadSenderDiagnostics(): Promise<void> {
		if (!this.sourceCaptureSize) return;
		const pc = (this.peer as unknown as SimplePeerWithRTCPeerConnection)?._pc;
		if (!pc?.getStats) return;

		const firstReport = await pc.getStats();
		const first = getVideoOutboundStats(firstReport);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const secondReport = await pc.getStats();
		const second = getVideoOutboundStats(secondReport);
		if (!second) {
			reportIpadDiagnostic('Sender', {
				status: 'No outbound video statistics are available',
			});
			return;
		}

		const elapsedSeconds =
			(numericStat(second, 'timestamp') ?? performance.now()) / 1000 -
			(numericStat(first, 'timestamp') ?? performance.now() - 2000) / 1000;
		const bytesDelta =
			(numericStat(second, 'bytesSent') ?? 0) -
			(numericStat(first, 'bytesSent') ?? 0);
		const framesEncodedDelta =
			(numericStat(second, 'framesEncoded') ?? 0) -
			(numericStat(first, 'framesEncoded') ?? 0);
		const encodeTimeDelta =
			(numericStat(second, 'totalEncodeTime') ?? 0) -
			(numericStat(first, 'totalEncodeTime') ?? 0);
		const codec = second.codecId
			? (secondReport.get(second.codecId as string) as WebRTCStats | undefined)
			: undefined;
		const sender = pc
			.getSenders()
			.find((candidate) => candidate.track?.kind === 'video');
		const parameters = sender?.getParameters();

		reportIpadDiagnostic('Sender', {
			frameWidth: second.frameWidth,
			frameHeight: second.frameHeight,
			framesPerSecond: second.framesPerSecond,
			framesEncoded: second.framesEncoded,
			framesSent: second.framesSent,
			bitrateKbps:
				elapsedSeconds > 0
					? Math.round((bytesDelta * 8) / elapsedSeconds / 1000)
					: undefined,
			averageEncodeTimeMs:
				framesEncodedDelta > 0
					? Math.round((encodeTimeDelta / framesEncodedDelta) * 1000 * 100) /
						100
					: undefined,
			qualityLimitationReason: second.qualityLimitationReason,
			qualityLimitationDurations: second.qualityLimitationDurations,
			qpSum: second.qpSum,
			codecMimeType: codec?.mimeType,
			codecFmtp: codec?.sdpFmtpLine,
			encoderImplementation: second.encoderImplementation,
			powerEfficientEncoder: second.powerEfficientEncoder,
			degradationPreference: parameters?.degradationPreference,
			encodings: parameters?.encodings?.map((encoding) => ({
				scaleResolutionDownBy: encoding.scaleResolutionDownBy,
				maxBitrate: encoding.maxBitrate,
				maxFramerate: encoding.maxFramerate,
			})),
		});
	}

	configureIpadVideoTrack(stream = this.localStream): void {
		if (!this.sourceCaptureSize) return;
		const track = stream?.getVideoTracks()[0];
		if (!track) return;

		try {
			track.contentHint = 'text';
			if (track.contentHint !== 'text') track.contentHint = 'detail';
		} catch {
			// The readback below records a runtime that does not accept either hint.
		}

		const settings = track.getSettings() as MediaTrackSettings & {
			resizeMode?: string;
		};
		const capabilities = track.getCapabilities?.();
		reportIpadDiagnostic('Capture', {
			requestedWidth: this.sourceCaptureSize.width,
			requestedHeight: this.sourceCaptureSize.height,
			width: settings.width,
			height: settings.height,
			frameRate: settings.frameRate,
			resizeMode: settings.resizeMode,
			contentHint: track.contentHint,
			widthCapabilities: capabilities?.width,
			heightCapabilities: capabilities?.height,
		});
	}
}
