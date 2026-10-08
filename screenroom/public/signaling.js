// Thin wrapper around the signaling WebSocket.
//
// It has no opinion about WebRTC. It reports room membership and delivers the
// opaque payloads that peers.js needs to open a direct connection. If the
// socket drops, it reconnects with backoff; the caller is told so it can
// rebuild the mesh, because peer IDs do not survive a reconnect.

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export function connectSignaling({ room, name, handlers }) {
	let socket = null;
	let closedByUs = false;
	let attempt = 0;
	let retryTimer = null;
	let joinedId = null;
	// Reconnects belong to this login; an explicit Join creates a fresh session.
	const session = crypto.randomUUID();

	function kicked() {
		if (closedByUs) return;
		closedByUs = true;
		clearTimeout(retryTimer);
		joinedId = null;
		handlers.onStatus("kicked");
		handlers.onKicked?.();
		socket?.close();
	}

	function url() {
		const scheme = location.protocol === "https:" ? "wss:" : "ws:";
		// The room travels in the URL, not only in the join message: on Cloudflare
		// the Durable Object is chosen before a single message is read, so routing
		// on the first message would be too late. The Node server ignores the
		// query and reads the room from the join, so both work.
		return `${scheme}//${location.host}/ws?room=${encodeURIComponent(room)}`;
	}

	function send(message) {
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		try {
			socket.send(JSON.stringify(message));
			return true;
		} catch {
			return false;
		}
	}

	function open() {
		if (closedByUs) return;
		handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");

		socket = new WebSocket(url());

		socket.onopen = () => {
			attempt = 0;
			send({ t: "join", room, name, session });
		};

		socket.onmessage = (event) => {
			if (closedByUs) return;
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!msg || typeof msg !== "object") return;

			switch (msg.t) {
				case "kicked":
					kicked();
					break;
				case "welcome":
					joinedId = msg.id;
					handlers.onStatus("connected");
					handlers.onWelcome({ id: msg.id, peers: msg.peers || [] });
					break;
				case "peer-join":
					handlers.onPeerJoin({ id: msg.id, name: msg.name, sharing: msg.sharing });
					break;
				case "peer-leave":
					handlers.onPeerLeave(msg.id);
					break;
				case "room-state":
					handlers.onRoomState?.(msg.peers || []);
					break;
				case "kick-confirmed":
					handlers.onKickConfirmed?.(msg.id);
					break;
				case "peer-name":
					handlers.onPeerName(msg.id, msg.name);
					break;
				case "peer-sharing":
					handlers.onPeerSharing(msg.id, msg.on === true);
					break;
				case "signal":
					handlers.onSignal(msg.from, msg.data);
					break;
				case "error":
					handlers.onError(msg.message || "Signaling error");
					break;
			}
		};

		socket.onclose = (event) => {
			if (event.code === 4003) kicked();
			if (closedByUs) return;
			// The other peers can no longer reach us, so the mesh is rebuilt on
			// the next welcome rather than left half-dead.
			handlers.onStatus("reconnecting");
			handlers.onDropped();
			joinedId = null;
			scheduleRetry();
		};

		socket.onerror = () => {
			// onclose always follows, which is where recovery actually happens.
		};
	}

	function scheduleRetry() {
		clearTimeout(retryTimer);
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
		attempt += 1;
		retryTimer = setTimeout(open, delay);
	}

	open();

	return {
		get id() {
			return joinedId;
		},
		sendSignal(to, data) {
			return send({ t: "signal", to, data });
		},
		setSharing(on) {
			return send({ t: "sharing", on: on === true });
		},
		kick(to) {
			return !closedByUs && joinedId !== null && send({ t: "kick", to });
		},
		setName(next) {
			return send({ t: "name", name: next });
		},
		close() {
			closedByUs = true;
			clearTimeout(retryTimer);
			if (socket) {
				try {
					socket.close();
				} catch {
					/* already gone */
				}
			}
		},
	};
}
