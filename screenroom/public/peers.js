import { ICE_SERVERS } from "./config.js";
import { normalizeQuality } from "./share-quality.js";

// A candidate can only be applied once a remote description exists. Anything
// arriving before that is queued; this bounds the queue so a misbehaving peer
// cannot grow it without limit.
const MAX_PENDING_CANDIDATES = 200;

// One RTCPeerConnection per other participant -- a full mesh.
//
// We create the video and audio transceivers up front, before anyone shares
// anything, so the m-lines are negotiated exactly once when the connection
// opens. Starting or stopping a screen share is then just replaceTrack() on an
// existing sender -- no renegotiation, no glare, no flicker.
//
// Because both ends add transceivers at the same moment, only one side is
// allowed to open the negotiation; see `initiator` below. Perfect negotiation
// stays in place as the safety net for later renegotiation.

export class Peer {
	constructor({ id, polite, send, onStream, onStateChange, quality }) {
		this.id = id;
		this.polite = polite;
		this.send = send;
		this.onStream = onStream;
		this.onStateChange = onStateChange;

		this.makingOffer = false;
		this.ignoreOffer = false;
		this.isSettingRemoteAnswerPending = false;
		this.closed = false;
		this.hasRemoteDescription = false;
		// Exactly one side opens the initial negotiation. Both sides add their
		// transceivers at the same moment, so without this they both offer, and
		// resolving that collision with a rollback can leave the answering side's
		// ICE agent wedged -- it gathers no candidates and the connection sits at
		// "new" forever. The answering side still contributes its transceivers
		// through the answer, so this costs nothing.
		//
		// Derived rather than passed in: polite and initiator are complements, so
		// both ends agree without any extra negotiation.
		this.initiator = !polite;
		/** @type {RTCIceCandidateInit[]} */
		this.pendingCandidates = [];
		this.remoteStream = new MediaStream();

		const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
		this.pc = pc;

		this.videoSender = pc.addTransceiver("video", {
			direction: "sendrecv",
			sendEncodings: [{ priority: "high" }],
		}).sender;

		this.audioSender = pc.addTransceiver("audio", {
			direction: "sendrecv",
		}).sender;

		// Encoder ceilings are per peer, because each viewer gets their own
		// stream. Serialised through parameterUpdates: setParameters() is async
		// and overlapping calls can interleave and lose the last write.
		this.quality = normalizeQuality(quality);
		this.parameterUpdates = Promise.resolve();
		pc.addEventListener("connectionstatechange", () => {
			// Parameters only take effect once the connection is negotiated.
			if (pc.connectionState === "connected") this.applyScreenParameters().catch(() => {});
		});

		pc.onnegotiationneeded = async () => {
			// Wait for the offer instead of racing it. Once a remote description
			// exists this guard no longer applies, so later renegotiation (an ICE
			// restart, say) still works normally.
			if (!this.initiator && !this.hasRemoteDescription) return;
			try {
				this.makingOffer = true;
				await pc.setLocalDescription();
				this.send({ description: pc.localDescription });
			} catch (err) {
				console.error("negotiation failed", err);
			} finally {
				this.makingOffer = false;
			}
		};

		pc.onicecandidate = ({ candidate }) => {
			if (candidate) this.send({ candidate });
		};

		pc.ontrack = (event) => {
			// Both tracks (video + audio) are folded into one MediaStream so the
			// UI can attach it to a <video> once and never touch it again.
			if (!this.remoteStream.getTracks().includes(event.track)) {
				this.remoteStream.addTrack(event.track);
			}
			this.onStream(this.id, this.remoteStream);
		};

		pc.onconnectionstatechange = () => {
			if (this.closed) return;
			this.onStateChange(this.id, pc.connectionState);
			if (pc.connectionState === "failed") this.restartIce();
		};

		// "disconnected" is frequently transient (a blip, a Wi-Fi roam), so we
		// only act on "failed" and otherwise let ICE recover on its own.
		pc.oniceconnectionstatechange = () => {
			if (this.closed) return;
			if (pc.iceConnectionState === "failed") this.restartIce();
		};
	}

	restartIce() {
		if (this.closed || !this.pc.restartIce) return;
		try {
			this.pc.restartIce();
		} catch (err) {
			console.warn("ICE restart failed", err);
		}
	}

	async accept(data) {
		const pc = this.pc;
		try {
			if (data.description) {
				const description = data.description;

				const readyForOffer =
					!this.makingOffer &&
					(pc.signalingState === "stable" || this.isSettingRemoteAnswerPending);
				const offerCollision = description.type === "offer" && !readyForOffer;

				this.ignoreOffer = !this.polite && offerCollision;
				if (this.ignoreOffer) return;

				this.isSettingRemoteAnswerPending = description.type === "answer";
				// A polite peer rolls back implicitly here, which is the point of
				// the pattern: the impolite side's offer wins, cleanly.
				await pc.setRemoteDescription(description);
				this.isSettingRemoteAnswerPending = false;
				this.hasRemoteDescription = true;

				if (description.type === "offer") {
					await pc.setLocalDescription();
					this.send({ description: pc.localDescription });
				}

				await this.drainPendingCandidates();
				// Sender parameters cannot be set before the connection is
				// negotiated, so this is the first point they will stick.
				await this.applyScreenParameters().catch(() => {});
			} else if (data.candidate) {
				// Candidates routinely win the race against the description that
				// gives them meaning. addIceCandidate() throws in that window and a
				// dropped candidate can leave the connection stuck at "new", so hold
				// them until there is something to apply them to. Whether this race
				// is lost depends on timing, which is why it only shows up under load.
				if (!this.hasRemoteDescription) {
					this.pendingCandidates.push(data.candidate);
					if (this.pendingCandidates.length > MAX_PENDING_CANDIDATES) {
						this.pendingCandidates.shift();
					}
					return;
				}
				await this.addCandidate(data.candidate);
			}
		} catch (err) {
			console.error("failed to apply signal", err);
		}
	}

	async addCandidate(candidate) {
		try {
			await this.pc.addIceCandidate(candidate);
		} catch (err) {
			// Candidates belonging to an offer we deliberately ignored, or to a
			// negotiation that has since been replaced, are expected noise.
			if (!this.ignoreOffer) console.warn("ICE candidate rejected", err);
		}
	}

	async drainPendingCandidates() {
		if (this.pendingCandidates.length === 0) return;
		const queued = this.pendingCandidates;
		this.pendingCandidates = [];
		for (const candidate of queued) {
			await this.addCandidate(candidate);
		}
	}

	// Called with the display tracks when sharing starts, and with nulls when it
	// stops. Because the m-line already exists as sendrecv, no renegotiation
	// happens and viewers switch over instantly.
	async setScreen(videoTrack, audioTrack) {
		if (this.closed) return;
		try {
			await this.videoSender.replaceTrack(videoTrack || null);
			await this.audioSender.replaceTrack(audioTrack || null);
			if (videoTrack) await this.applyScreenParameters();
		} catch (err) {
			console.error("replaceTrack failed", err);
		}
	}

	// Screen content is text, not motion: at 30 FPS ask the encoder to protect
	// resolution instead of frame rate. Above that the source is high-motion
	// (a game or a film), where holding frames matters more, so the preference
	// is balanced instead.
	//
	// These are ceilings, not guarantees: capture, CPU and the network can all
	// land below them, and every viewer gets an independent stream.
	applyScreenParameters() {
		const update = this.parameterUpdates.then(async () => {
			if (this.closed) return;
			const params = this.videoSender.getParameters();
			// No encodings until the m-line is negotiated; retried on connect.
			if (!params.encodings || params.encodings.length === 0) return;
			for (const encoding of params.encodings) {
				encoding.maxBitrate = this.quality.bitrate * 1_000_000;
				encoding.maxFramerate = this.quality.fps;
				encoding.priority = "high";
			}
			params.degradationPreference =
				this.quality.fps === 30 ? "maintain-resolution" : "balanced";
			await this.videoSender.setParameters(params);
		});
		this.parameterUpdates = update.catch(() => {});
		return update;
	}

	/** Change the ceiling for this view. Safe to call during a share. */
	async setQuality(quality) {
		this.quality = normalizeQuality(quality);
		await this.applyScreenParameters();
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.pendingCandidates = [];
		try {
			this.pc.close();
		} catch {
			/* already closed */
		}
		for (const track of this.remoteStream.getTracks()) {
			try {
				this.remoteStream.removeTrack(track);
			} catch {
				/* ignore */
			}
		}
	}
}
