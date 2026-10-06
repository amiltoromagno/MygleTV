// Screen Room server.
//
// This process does exactly two things:
//   1. serves the static frontend from ./public
//   2. relays a few kilobytes of signaling text between browsers in the same room
//
// It never touches audio or video. It cannot: media travels directly between
// peers over WebRTC. There is no database and nothing is written to disk --
// rooms live in memory and vanish when the last person leaves.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE || 12);
const HEARTBEAT_MS = 30_000;

// An SDP blob runs to a few KB; this ceiling just stops a client from pushing
// something absurd through the relay.
const MAX_MESSAGE_BYTES = 128 * 1024;

const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
};

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function serveStatic(req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { allow: "GET, HEAD" });
		res.end();
		return;
	}

	let pathname;
	try {
		pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
	} catch {
		res.writeHead(400).end("Bad request");
		return;
	}

	if (pathname === "/healthz") {
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end("ok");
		return;
	}

	if (pathname === "/") pathname = "/index.html";

	// Resolve, then confirm we never escaped PUBLIC_DIR (e.g. via "..").
	const filePath = path.resolve(PUBLIC_DIR, "." + pathname);
	if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
		res.writeHead(403).end("Forbidden");
		return;
	}

	fs.stat(filePath, (err, stat) => {
		if (err || !stat.isFile()) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
			"content-length": stat.size,
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff",
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		fs.createReadStream(filePath).pipe(res);
	});
}

// ---------------------------------------------------------------------------
// Room registry
// ---------------------------------------------------------------------------

/** @type {Map<string, Map<string, object>>} room name -> (client id -> client) */
const rooms = new Map();

let idCounter = 0;
function nextId() {
	idCounter += 1;
	return "p" + idCounter.toString(36) + Math.random().toString(36).slice(2, 8);
}

const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function cleanName(raw) {
	if (typeof raw !== "string") return "";
	return raw
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 32);
}

function send(client, message) {
	if (client.ws.readyState !== client.ws.OPEN) return;
	try {
		client.ws.send(JSON.stringify(message));
	} catch {
		/* socket died between the check and the send */
	}
}

function broadcast(room, message, exceptId) {
	for (const other of room.values()) {
		if (other.id === exceptId) continue;
		send(other, message);
	}
}

// ---------------------------------------------------------------------------
// Signaling
// ---------------------------------------------------------------------------

function joinRoom(client, msg) {
	if (client.room) return; // already joined

	const roomName = typeof msg.room === "string" ? msg.room : "";
	if (!ROOM_PATTERN.test(roomName)) {
		send(client, { t: "error", message: "That room name is not valid." });
		return;
	}

	const name = cleanName(msg.name) || "Guest";

	let room = rooms.get(roomName);
	if (!room) {
		room = new Map();
		rooms.set(roomName, room);
	}
	if (room.size >= MAX_ROOM_SIZE) {
		send(client, { t: "error", message: "This room is full." });
		return;
	}

	client.room = roomName;
	client.name = name;
	client.sharing = false;

	// The newcomer is told who is already here; existing members are told about
	// the newcomer. Both sides then build their own end of each peer connection.
	const peers = [];
	for (const other of room.values()) {
		peers.push({ id: other.id, name: other.name, sharing: other.sharing });
	}

	room.set(client.id, client);
	send(client, { t: "welcome", id: client.id, peers });
	broadcast(room, { t: "peer-join", id: client.id, name: client.name, sharing: false }, client.id);

	log(`join  "${roomName}" ${client.id} (${client.name}) -> ${room.size} present`);
}

function leaveRoom(client) {
	const roomName = client.room;
	if (!roomName) return;
	client.room = null;

	const room = rooms.get(roomName);
	if (!room) return;
	room.delete(client.id);
	broadcast(room, { t: "peer-leave", id: client.id });
	if (room.size === 0) rooms.delete(roomName);

	log(`leave "${roomName}" ${client.id} (${client.name}) -> ${room.size} present`);
}

function route(client, msg) {
	if (msg.t === "join") {
		joinRoom(client, msg);
		return;
	}

	if (!client.room) return; // every other message requires a room

	const room = rooms.get(client.room);
	if (!room) return;

	switch (msg.t) {
		case "signal": {
			// Deliberately opaque: we forward the payload without reading it.
			const target = room.get(msg.to);
			if (target) send(target, { t: "signal", from: client.id, data: msg.data });
			break;
		}
		case "name": {
			const name = cleanName(msg.name);
			if (!name || name === client.name) break;
			client.name = name;
			broadcast(room, { t: "peer-name", id: client.id, name }, client.id);
			break;
		}
		case "sharing": {
			const on = msg.on === true;
			if (on === client.sharing) break;
			client.sharing = on;
			broadcast(room, { t: "peer-sharing", id: client.id, on }, client.id);
			break;
		}
		default:
			break;
	}
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// TLS is optional: in the recommended deployment nginx terminates HTTPS and
// proxies here over plain HTTP on localhost. Set TLS_CERT/TLS_KEY to run
// TLS directly instead.
function createHttpServer(handler) {
	const certPath = process.env.TLS_CERT;
	const keyPath = process.env.TLS_KEY;
	if (certPath && keyPath) {
		return https.createServer(
			{ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
			handler,
		);
	}
	return http.createServer(handler);
}

const server = createHttpServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });

wss.on("connection", (ws) => {
	const client = {
		id: nextId(),
		name: "",
		room: null,
		sharing: false,
		ws,
	};

	ws.isAlive = true;
	ws.on("pong", () => {
		ws.isAlive = true;
	});

	ws.on("message", (data, isBinary) => {
		if (isBinary) return;
		const raw = data.toString();
		if (raw.length > MAX_MESSAGE_BYTES) {
			ws.close(1009, "message too large");
			return;
		}
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
		route(client, msg);
	});

	ws.on("close", () => leaveRoom(client));
	ws.on("error", () => {
		/* close follows */
	});
});

const heartbeat = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.isAlive === false) {
			ws.terminate();
			continue;
		}
		ws.isAlive = false;
		try {
			ws.ping();
		} catch {
			/* ignore */
		}
	}
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
	const scheme = process.env.TLS_CERT ? "https" : "http";
	log(`Screen Room listening on ${scheme}://${HOST}:${PORT}`);
	log(`rooms cap ${MAX_ROOM_SIZE}; signaling at /ws`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		log("shutting down");
		clearInterval(heartbeat);
		wss.close();
		server.close(() => process.exit(0));
		// Do not hang forever on lingering sockets.
		setTimeout(() => process.exit(0), 2000).unref();
	});
}
