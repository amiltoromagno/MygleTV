// End-to-end checks for the signaling relay.
//
// Spawns a real server on a throwaway port and drives it with real WebSocket
// clients, so this exercises the actual protocol rather than a mock.
//
//   npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8399;
const URL = `ws://127.0.0.1:${PORT}/ws`;

let server;

function connect() {
	const ws = new WebSocket(URL);
	const messages = [];
	const waiters = [];

	ws.on("message", (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		messages.push(msg);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].predicate(msg)) {
				const [waiter] = waiters.splice(i, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(msg);
			}
		}
	});

	const opened = new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});

	return {
		ws,
		messages,
		opened,
		send: (msg) => ws.send(JSON.stringify(msg)),
		waitFor(predicate, label, timeout = 4000) {
			const existing = messages.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`timed out waiting for ${label}`)),
					timeout,
				);
				waiters.push({ predicate, resolve, timer });
			});
		},
		close: () => ws.close(),
	};
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(url, attempts = 60) {
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await settle(100);
	}
	throw new Error("server did not start");
}

before(async () => {
	server = spawn(process.execPath, ["server.js"], {
		cwd: ROOT,
		env: { ...process.env, PORT: String(PORT) },
		stdio: "ignore",
	});
	await waitForServer(`http://127.0.0.1:${PORT}/healthz`);
});

after(() => {
	if (server) server.kill("SIGKILL");
});

test("kick removes only the chosen session, not names or other rooms", async () => {
	const alice = connect(), bob = connect(), observer = connect(), otherRoom = connect(), stranger = connect();
	const clients = [alice, bob, observer, otherRoom, stranger];
	try {
		await Promise.all(clients.map((client) => client.opened));
		const ids = [];
		for (const [index, client] of [alice, bob, observer, otherRoom].entries()) {
			client.send({ t: "join", room: index === 3 ? "kick-other" : "kick-room", name: "Duplicate" });
			ids.push((await client.waitFor((m) => m.t === "welcome", "welcome")).id);
		}
		stranger.send({ t: "kick", to: ids[1] });
		alice.send({ t: "kick", to: ids[3] });
		await alice.waitFor((m) => m.t === "error", "cross-room kick rejected");
		await settle(100);
		assert.equal(bob.ws.readyState, WebSocket.OPEN);
		assert.equal(otherRoom.ws.readyState, WebSocket.OPEN);
		const closed = new Promise((resolve) => bob.ws.once("close", (code) => resolve(code)));
		alice.send({ t: "kick", to: ids[1] });
		await bob.waitFor((m) => m.t === "kicked", "removal notice");
		assert.equal(await closed, 4003);
		await Promise.all([alice, observer].map((client) => client.waitFor((m) => m.t === "peer-leave" && m.id === ids[1], "departure")));
		await settle(100);
		for (const client of [alice, observer]) assert.equal(client.messages.filter((m) => m.t === "peer-leave" && m.id === ids[1]).length, 1);
		assert.equal(observer.ws.readyState, WebSocket.OPEN);
		assert.equal(otherRoom.messages.some((m) => m.t === "peer-leave"), false);
	} finally { clients.forEach((client) => client.close()); }
});

test("removed login cannot reconnect, but an explicit new login can join", async () => {
	const moderator = connect(), target = connect();
	const clients = [moderator, target];
	try {
		await Promise.all(clients.map((client) => client.opened));
		moderator.send({ t: "join", room: "session-removal", name: "Moderator" });
		await moderator.waitFor((m) => m.t === "welcome", "moderator welcome");
		target.send({ t: "join", room: "session-removal", name: "Target", session: "removed-login-123456" });
		const { id } = await target.waitFor((m) => m.t === "welcome", "target welcome");
		moderator.send({ t: "kick", to: id });
		await moderator.waitFor((m) => m.t === "kick-confirmed", "kick confirmed");
		const retry = connect(); clients.push(retry); await retry.opened;
		const closed = new Promise((resolve) => retry.ws.once("close", (code) => resolve(code)));
		retry.send({ t: "join", room: "session-removal", name: "Target", session: "removed-login-123456" });
		await retry.waitFor((m) => m.t === "kicked", "retry rejected");
		assert.equal(await closed, 4003);
		const fresh = connect(); clients.push(fresh); await fresh.opened;
		fresh.send({ t: "join", room: "session-removal", name: "Target", session: "new-login-123456789" });
		assert.equal((await fresh.waitFor((m) => m.t === "welcome", "fresh login")).peers.length, 1);
	} finally { clients.forEach((client) => client.close()); }
});

test("a joining client is welcomed with an empty peer list", async () => {
	const alice = connect();
	await alice.opened;
	alice.send({ t: "join", room: "alpha", name: "Alice" });

	const welcome = await alice.waitFor((m) => m.t === "welcome", "welcome");
	assert.ok(welcome.id, "should be assigned an id");
	assert.deepEqual(welcome.peers, []);

	alice.close();
});

test("existing members learn about a newcomer, and vice versa", async () => {
	const alice = connect();
	const bob = connect();
	await Promise.all([alice.opened, bob.opened]);

	alice.send({ t: "join", room: "alpha", name: "Alice" });
	await alice.waitFor((m) => m.t === "welcome", "alice welcome");

	bob.send({ t: "join", room: "alpha", name: "Bob" });

	const bobWelcome = await bob.waitFor((m) => m.t === "welcome", "bob welcome");
	assert.equal(bobWelcome.peers.length, 1);
	assert.equal(bobWelcome.peers[0].name, "Alice");

	const joined = await alice.waitFor((m) => m.t === "peer-join", "peer-join");
	assert.equal(joined.name, "Bob");
	assert.equal(joined.sharing, false);

	alice.close();
	bob.close();
});

test("offer/answer payloads are relayed intact and addressed to the sender", async () => {
	const alice = connect();
	const bob = connect();
	await Promise.all([alice.opened, bob.opened]);

	alice.send({ t: "join", room: "alpha", name: "Alice" });
	const aliceWelcome = await alice.waitFor((m) => m.t === "welcome", "alice welcome");

	bob.send({ t: "join", room: "alpha", name: "Bob" });
	const bobWelcome = await bob.waitFor((m) => m.t === "welcome", "bob welcome");

	// Bob sends a fake SDP offer to Alice.
	const payload = { description: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" } };
	bob.send({ t: "signal", to: aliceWelcome.id, data: payload });

	const relayed = await alice.waitFor((m) => m.t === "signal", "relayed signal");
	assert.equal(relayed.from, bobWelcome.id, "from must identify the sender");
	assert.deepEqual(relayed.data, payload, "payload must survive untouched");

	alice.close();
	bob.close();
});

test("rooms are isolated from one another", async () => {
	const alice = connect();
	const mallory = connect();
	await Promise.all([alice.opened, mallory.opened]);

	alice.send({ t: "join", room: "alpha", name: "Alice" });
	await alice.waitFor((m) => m.t === "welcome", "alice welcome");

	mallory.send({ t: "join", room: "beta", name: "Mallory" });
	const malloryWelcome = await mallory.waitFor((m) => m.t === "welcome", "mallory welcome");

	assert.deepEqual(malloryWelcome.peers, [], "must not see the other room's occupants");

	await settle();
	assert.equal(
		alice.messages.some((m) => m.t === "peer-join"),
		false,
		"alpha must not hear about a beta join",
	);

	alice.close();
	mallory.close();
});

test("sharing state is broadcast to the room but not echoed to the sender", async () => {
	const alice = connect();
	const bob = connect();
	await Promise.all([alice.opened, bob.opened]);

	alice.send({ t: "join", room: "alpha", name: "Alice" });
	await alice.waitFor((m) => m.t === "welcome", "alice welcome");
	bob.send({ t: "join", room: "alpha", name: "Bob" });
	await bob.waitFor((m) => m.t === "welcome", "bob welcome");
	await alice.waitFor((m) => m.t === "peer-join", "peer-join");

	bob.send({ t: "sharing", on: true });

	const note = await alice.waitFor((m) => m.t === "peer-sharing", "peer-sharing");
	assert.equal(note.on, true);

	await settle();
	assert.equal(
		bob.messages.some((m) => m.t === "peer-sharing"),
		false,
		"a client should not be told about its own state change",
	);

	alice.close();
	bob.close();
});

test("a departure is announced to the remaining members", async () => {
	const alice = connect();
	const bob = connect();
	await Promise.all([alice.opened, bob.opened]);

	alice.send({ t: "join", room: "alpha", name: "Alice" });
	await alice.waitFor((m) => m.t === "welcome", "alice welcome");
	bob.send({ t: "join", room: "alpha", name: "Bob" });
	const bobWelcome = await bob.waitFor((m) => m.t === "welcome", "bob welcome");
	await alice.waitFor((m) => m.t === "peer-join", "peer-join");

	bob.close();

	const left = await alice.waitFor((m) => m.t === "peer-leave", "peer-leave");
	assert.equal(left.id, bobWelcome.id);

	alice.close();
});

test("invalid room names are rejected", async () => {
	const client = connect();
	await client.opened;
	client.send({ t: "join", room: "has spaces/bad!", name: "Nobody" });

	const error = await client.waitFor((m) => m.t === "error", "error");
	assert.match(error.message, /not valid/i);
	assert.equal(client.messages.some((m) => m.t === "welcome"), false);

	client.close();
});

test("messages sent before joining are ignored", async () => {
	const alice = connect();
	await alice.opened;

	// No join first: this must not reach anyone or crash the server.
	alice.send({ t: "signal", to: "whoever", data: { candidate: null } });
	alice.send({ t: "sharing", on: true });

	await settle();
	assert.equal(alice.messages.some((m) => m.t === "welcome"), false);

	// The server is still healthy afterwards.
	const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
	assert.equal(res.status, 200);

	alice.close();
});
