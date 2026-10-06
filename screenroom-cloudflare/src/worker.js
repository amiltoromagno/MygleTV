// Screen Room on Cloudflare Workers.
//
// Two jobs only:
//   /ws       -> the room's Durable Object (the signaling relay)
//   /healthz  -> a plain "ok", matching the Node server's contract
//   anything else -> the static frontend
//
// The frontend is the same files the Node server serves, referenced directly
// rather than copied, so there is one copy of the app.

export { Room } from "./room.js";

/** Same rule the Node server applies, so a room means the same thing either way. */
const ROOM_PATTERN = /[^A-Za-z0-9_-]/g;

function sanitiseRoom(raw) {
	const cleaned = String(raw || "").replace(ROOM_PATTERN, "").slice(0, 64);
	return cleaned || "main";
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/healthz") {
			return new Response("ok", {
				headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
			});
		}

		if (url.pathname === "/ws") {
			// The room has to be in the URL: the Durable Object is chosen before a
			// single message is read, so the first message is too late to route on.
			const room = sanitiseRoom(url.searchParams.get("room"));
			const id = env.ROOMS.idFromName(room);
			return env.ROOMS.get(id).fetch(request);
		}

		return env.ASSETS.fetch(request);
	},
};
