// The room protocol, as pure functions.
//
// Deliberately free of Cloudflare and WebSocket dependencies so the behaviour
// can be tested directly, without the Workers runtime. room.js is the thin
// adapter that applies these effects to real sockets.
//
// Every function takes the current member list as plain data and returns the
// messages that should be sent. Nothing here performs I/O.

/** Matches the Node server: strip control characters, collapse space, cap length. */
export function cleanName(raw) {
	if (typeof raw !== "string") return "";
	return raw
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 32);
}

/** Cap on a single inbound message; SDP blobs run to a few KB. */
export const MAX_MESSAGE_BYTES = 128 * 1024;

export function toPeer(member) {
	return { id: member.id, name: member.name, sharing: member.sharing === true };
}

/**
 * A member has joined. The newcomer is told who is already here; everyone else
 * is told about the newcomer. Both sides then build their own peer connection.
 */
export function describeJoin(members, id, rawName) {
	const name = cleanName(rawName) || "Guest";
	const peers = members.filter((m) => m.joined && m.id !== id).map(toPeer);

	return {
		name,
		effects: [
			{ type: "reply", to: id, message: { t: "welcome", id, peers } },
			{ type: "broadcast", except: id, message: { t: "peer-join", id, name, sharing: false } },
		],
	};
}

/**
 * A message from an already-joined member.
 *
 * Returns `patch` when the sender's own state changed, so the caller can persist
 * it (on the socket attachment, because the object may hibernate).
 */
export function describeMessage(members, id, msg) {
	const self = members.find((m) => m.id === id);
	if (!self || !self.joined) return { effects: [] };

	if (msg.t === "kick") {
		if (typeof msg.to !== "string" || msg.to === id || !members.some((m) => m.id === msg.to && m.joined)) {
			return { effects: [{ type: "reply", to: id, message: { t: "error", message: "That participant is no longer available to kick." } }] };
		}
		return { effects: [{ type: "kick", to: msg.to, from: id }] };
	}

	if (msg.t === "signal") {
		// Relayed opaquely: the payload is never inspected.
		if (typeof msg.to !== "string") return { effects: [] };
		if (!members.some((m) => m.id === msg.to && m.joined)) return { effects: [] };
		return {
			effects: [{ type: "send", to: msg.to, message: { t: "signal", from: id, data: msg.data } }],
		};
	}

	if (msg.t === "name") {
		const name = cleanName(msg.name);
		if (!name || name === self.name) return { effects: [] };
		return {
			patch: { name },
			effects: [{ type: "broadcast", except: id, message: { t: "peer-name", id, name } }],
		};
	}

	if (msg.t === "sharing") {
		const on = msg.on === true;
		if (on === (self.sharing === true)) return { effects: [] };
		return {
			patch: { sharing: on },
			effects: [{ type: "broadcast", except: id, message: { t: "peer-sharing", id, on } }],
		};
	}

	return { effects: [] };
}

/** Takes the departing member's own record, since its socket may already be gone. */
export function describeLeave(member) {
	if (!member || !member.joined) return { effects: [] };
	return {
		effects: [
			{ type: "broadcast", except: member.id, message: { t: "peer-leave", id: member.id } },
		],
	};
}

/** Advisory limit; the free-tier Workers request cap is far higher. */
export const MAX_ROOM_SIZE = 12;
