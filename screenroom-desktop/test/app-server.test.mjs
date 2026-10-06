// Tests for the bundled web-server launcher.
//
// These spawn a real server process. That is deliberate: the whole point of
// app-server.js is to make `npm start` work without the user having to start
// anything else, so the thing worth testing is that a real child process comes
// up and serves the app.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";

import { startAppServer, waitForHealth } from "../app-server.js";

const PORT = 8488;
const quiet = () => {};

test("brings up the bundled server and serves the app", async () => {
	const server = startAppServer({ port: PORT, log: quiet });
	try {
		const healthy = await server.ready({ attempts: 80 });
		assert.equal(healthy, true, "server never became healthy");

		const page = await fetch(server.url);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /Screen Room/);

		const health = await fetch(new URL("/healthz", server.url));
		assert.equal(health.status, 200);
		assert.equal((await health.text()).trim(), "ok");
	} finally {
		server.stop();
	}
});

test("accepts a signaling websocket upgrade", async () => {
	const server = startAppServer({ port: PORT + 1, log: quiet });
	try {
		assert.equal(await server.ready({ attempts: 80 }), true);

		const socket = new WebSocket(`${server.url.replace("http://", "ws://")}ws`);
		await new Promise((resolve, reject) => {
			socket.on("open", resolve);
			socket.on("error", reject);
		});

		// Prove it is the signaling server and not merely a listener.
		socket.send(JSON.stringify({ t: "join", room: "probe", name: "Tester" }));
		const welcome = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no welcome message")), 4000);
			socket.on("message", (data) => {
				clearTimeout(timer);
				resolve(JSON.parse(data.toString()));
			});
		});

		assert.equal(welcome.t, "welcome");
		assert.deepEqual(welcome.peers, []);
		socket.close();
	} finally {
		server.stop();
	}
});

test("reuses an already-running Screen Room server on the same port", async () => {
	const first = startAppServer({ port: PORT + 2, log: quiet });
	try {
		assert.equal(await first.ready({ attempts: 80 }), true);

		// Something is already serving Screen Room here, so adopting it is right.
		const second = startAppServer({ port: PORT + 2, log: quiet });
		try {
			assert.equal(await second.ready({ attempts: 60 }), true);
		} finally {
			second.stop();
		}
	} finally {
		first.stop();
	}
});

test("reports failure when the port is held by something else entirely", async () => {
	const squatter = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("definitely not screen room");
	});
	await new Promise((resolve) => squatter.listen(PORT + 4, "127.0.0.1", resolve));

	try {
		const server = startAppServer({ port: PORT + 4, log: quiet });
		try {
			const healthy = await server.ready({ attempts: 40, delayMs: 100 });
			assert.equal(healthy, false, "a foreign server must not be mistaken for ours");
			assert.equal(server.exited, true);
			assert.ok(server.exitInfo, "expected exit information for the error page");
		} finally {
			server.stop();
		}
	} finally {
		await new Promise((resolve) => squatter.close(resolve));
	}
});

test("waitForHealth gives up when the process is already dead", async () => {
	let fetches = 0;
	const healthy = await waitForHealth({
		url: "http://127.0.0.1:1/",
		isDead: () => true,
		attempts: 50,
		delayMs: 5,
		fetchImpl: async () => {
			fetches += 1;
			throw new Error("nope");
		},
	});

	assert.equal(healthy, false);
	// It must notice the dead process instead of grinding through every attempt.
	assert.ok(fetches <= 2, `expected to bail out early, made ${fetches} attempts`);
});

test("a stopped server frees its port", async () => {
	const port = PORT + 3;
	const server = startAppServer({ port, log: quiet });
	assert.equal(await server.ready({ attempts: 80 }), true);

	server.stop();
	await new Promise((resolve) => setTimeout(resolve, 700));

	// If the port were still held, this would fail to come up.
	const replacement = startAppServer({ port, log: quiet });
	try {
		assert.equal(await replacement.ready({ attempts: 80 }), true);
	} finally {
		replacement.stop();
	}
});
