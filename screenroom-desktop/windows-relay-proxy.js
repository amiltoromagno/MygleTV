// Serve the shared, bundled frontend while forwarding signaling to a relay.
// This lets Windows use its PCM frontend without requiring a production deploy.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";

export function validateRelayUrl(relayUrl) {
	const relay = new URL(relayUrl);
	if (!["http:", "https:"].includes(relay.protocol) || relay.username || relay.password) throw new Error("Use an HTTP or HTTPS MygleTV relay URL without credentials.");
	if (relay.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname)) throw new Error("Remote MygleTV relays must use HTTPS.");
	return relay;
}

export async function startWindowsRelayProxy({ relayUrl, publicDir }) {
	const relay = validateRelayUrl(relayUrl);
	const root = path.resolve(publicDir);
	const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
	const server = http.createServer(async (req, res) => {
		if (!["GET", "HEAD"].includes(req.method)) return res.writeHead(405).end();
		try {
			let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
			if (pathname === "/healthz") return res.writeHead(200).end("ok");
			if (pathname === "/") pathname = "/index.html";
			const file = path.resolve(root, "." + pathname);
			if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
			const data = await fs.readFile(file);
			res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
			res.end(req.method === "HEAD" ? undefined : data);
		} catch (err) { res.writeHead(err.code === "ENOENT" || err.code === "EISDIR" ? 404 : 400).end(); }
	});
	const connections = new Set();
	const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
	server.on("upgrade", (req, socket, head) => {
		const incoming = new URL(req.url, "http://localhost");
		if (incoming.pathname !== "/ws") return socket.destroy();
		// A different local website must not use this proxy as its relay.
		if (req.headers.origin !== `http://127.0.0.1:${server.address().port}`) return socket.destroy();
		wss.handleUpgrade(req, socket, head, (client) => {
			const destination = new URL("/ws", relay);
			destination.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
			destination.search = incoming.search;
			const upstream = new WebSocket(destination, { maxPayload: 128 * 1024, handshakeTimeout: 10000 });
			connections.add(client); connections.add(upstream);
			let queued = [];
			let queueBytes = 0;
			const close = () => {
				connections.delete(client); connections.delete(upstream);
				queued = [];
				client.terminate(); upstream.terminate();
			};
			const forward = (to, data, binary) => {
				if (to.readyState !== WebSocket.OPEN || to.bufferedAmount > 1024 * 1024) return close();
				to.send(data, { binary }, (err) => { if (err) close(); });
			};
			client.on("message", (data, binary) => {
				if (upstream.readyState === WebSocket.CONNECTING) {
					queueBytes += data.length;
					if (queueBytes > 128 * 1024) return close();
					queued.push({ data, binary });
				} else forward(upstream, data, binary);
			});
			upstream.on("open", () => { for (const message of queued) forward(upstream, message.data, message.binary); queued = []; queueBytes = 0; });
			upstream.on("message", (data, binary) => forward(client, data, binary));
			client.on("close", close);
			upstream.on("close", (code) => {
				// Preserve intentional removal even if the kicked message was lost.
				if (code === 4003 && client.readyState === WebSocket.OPEN) client.close(4003, "Removed from room");
				else close();
			});
			for (const ws of [client, upstream]) ws.on("error", close);
		});
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const url = new URL(`http://127.0.0.1:${server.address().port}/`);
	url.search = relay.search;
	url.hash = relay.hash;
	return {
		url: url.toString(), inviteUrl: relay.toString(),
		stop() { for (const ws of connections) ws.terminate(); wss.close(); server.close(); server.closeAllConnections(); },
	};
}
