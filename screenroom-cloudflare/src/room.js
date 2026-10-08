// One Durable Object per room: the signaling relay.
//
// This is the Workers counterpart of screenroom/server.js's in-memory room
// registry. It never sees audio or video -- it forwards a few kilobytes of
// signaling text and then goes quiet.
//
// The object accepts sockets with the WebSocket Hibernation API, which matters
// for cost and correctness: an idle room is evicted from memory, so *nothing*
// may live in instance fields. Every member's identity and state is kept on its
// own socket attachment and rebuilt on demand.

import { DurableObject } from "cloudflare:workers";

import { describeJoin, describeLeave, describeMessage, MAX_MESSAGE_BYTES } from "./protocol.js";

export class Room extends DurableObject {
	async fetch(request) {
		if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
			// A plain GET is not a server fault; it just is not a websocket.
			return new Response("This endpoint expects a WebSocket upgrade.", {
				status: 426,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		server.serializeAttachment({
			id: newId(),
			name: "",
			sharing: false,
			joined: false,
		});
		this.ctx.acceptWebSocket(server);

		return new Response(null, { status: 101, webSocket: client });
	}

	/** Rebuild the member list from the live sockets. Hibernation-safe. */
	members() {
		return this.ctx.getWebSockets().map((ws) => {
			const attachment = ws.deserializeAttachment() || {};
			return {
				id: attachment.id,
				name: attachment.name || "",
				sharing: attachment.sharing === true,
				joined: attachment.joined === true,
				ws,
			};
		});
	}

	async webSocketMessage(ws, raw) {
		let text;
		if (typeof raw === "string") {
			text = raw;
		} else {
			try {
				text = new TextDecoder().decode(raw);
			} catch {
				return;
			}
		}
		if (text.length > MAX_MESSAGE_BYTES) return;

		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;

		const attachment = ws.deserializeAttachment() || {};
		if (attachment.expelled) return;
		const members = this.members().map(stripSocket);

		if (msg.t === "join") {
			// Joining twice would duplicate the member in everyone's roster.
			if (attachment.joined) return;

			const { name, effects } = describeJoin(members, attachment.id, msg.name);
			ws.serializeAttachment({ ...attachment, name, joined: true });
			this.apply(effects);
			return;
		}

		const { patch, effects } = describeMessage(members, attachment.id, msg);
		if (patch) ws.serializeAttachment({ ...attachment, ...patch });
		this.apply(effects);
	}

	async webSocketClose(ws) {
		this.leave(ws);
	}

	async webSocketError(ws) {
		this.leave(ws);
	}

	leave(ws) {
		const attachment = ws.deserializeAttachment() || {};
		// describeLeave takes the member's own record, because by the time a close
		// is handled the socket may already be gone from getWebSockets().
		const { effects } = describeLeave(attachment);
		ws.serializeAttachment({ ...attachment, joined: false });
		this.apply(effects);
	}

	apply(effects) {
		if (!effects || effects.length === 0) return;

		const byId = new Map(this.members().map((member) => [member.id, member.ws]));

		for (const effect of effects) {
			if (effect.type === "kick") {
				const target = byId.get(effect.to);
				if (!target) continue;
				const attachment = target.deserializeAttachment() || {};
				if (!attachment.joined) continue;
				// Persist removal before closing: a closing socket can still be listed
				// by the hibernation API and must not rejoin or relay more messages.
				target.serializeAttachment({ ...attachment, joined: false, expelled: true });
				this.send(target, { t: "kicked" });
				this.apply(describeLeave(attachment).effects);
				try { target.close(4003, "Removed from room"); } catch { /* already closed */ }
			} else if (effect.type === "reply" || effect.type === "send") {
				const target = byId.get(effect.to);
				if (target) this.send(target, effect.message);
			} else if (effect.type === "broadcast") {
				for (const [id, target] of byId) {
					if (id === effect.except) continue;
					this.send(target, effect.message);
				}
			}
		}
	}

	send(ws, message) {
		try {
			ws.send(JSON.stringify(message));
		} catch {
			// The socket died between the lookup and the send, which is routine.
		}
	}
}

function stripSocket(member) {
	return {
		id: member.id,
		name: member.name,
		sharing: member.sharing,
		joined: member.joined,
	};
}

function newId() {
	return "p" + Math.random().toString(36).slice(2, 10);
}
