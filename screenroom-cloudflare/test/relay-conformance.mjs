#!/usr/bin/env node
//
// Protocol conformance check, runnable against either relay.
//
//   node test/relay-conformance.mjs ws://127.0.0.1:8787/ws   # wrangler dev
//   node test/relay-conformance.mjs ws://127.0.0.1:8080/ws   # Node server
//
// The desktop shell and the browser are supposed to be indifferent to which one
// they are talking to, so the only way to know that is to hold both to the same
// expectations. Room isolation is included deliberately: on Cloudflare it is a
// Durable Object per room, on Node it is a Map per room, and a mistake in either
// would leak participants across rooms.

import WebSocket from "ws";

const base = process.argv[2] || "ws://127.0.0.1:8787/ws";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function connect(room) {
	const ws = new WebSocket(`${base}?room=${encodeURIComponent(room)}`);
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
		waitFor(predicate, label, timeoutMs = 6000) {
			const found = messages.find(predicate);
			if (found) return Promise.resolve(found);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
				waiters.push({ predicate, resolve, timer });
			});
		},
		close: () => ws.close(),
	};
}

const results = [];
function check(condition, label) {
	console.log(`  ${condition ? green("ok  ") : red("FAIL")} ${label}`);
	results.push({ condition, label });
}

const room = `conf-${Math.random().toString(36).slice(2, 8)}`;
const otherRoom = `${room}-other`;

let alice;
let bob;
let carol;
let observer;
let retry;
let fresh;
const session = `session-${room}`;

try {
	console.log(`\nProtocol conformance against ${base}\n`);

	alice = connect(room);
	await alice.opened;
	alice.send({ t: "join", room, name: "Alice" });
	const welcomeA = await alice.waitFor((m) => m.t === "welcome", "Alice's welcome");
	check(Array.isArray(welcomeA.peers) && welcomeA.peers.length === 0, "first member gets an empty peer list");
	check(typeof welcomeA.id === "string" && welcomeA.id.length > 0, "the relay assigns an id");

	bob = connect(room);
	await bob.opened;
	bob.send({ t: "join", room, name: "Bob", session });
	const welcomeB = await bob.waitFor((m) => m.t === "welcome", "Bob's welcome");
	check(
		welcomeB.peers.length === 1 && welcomeB.peers[0].name === "Alice",
		"the second member is told who is already there",
	);

	const announced = await alice.waitFor((m) => m.t === "peer-join", "peer-join");
	check(announced.name === "Bob" && announced.sharing === false, "the first member is told about the second");

	// Signal relay, payload untouched.
	const payload = { description: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" } };
	bob.send({ t: "signal", to: welcomeA.id, data: payload });
	const relayed = await alice.waitFor((m) => m.t === "signal", "the relayed signal");
	check(relayed.from === welcomeB.id, "the relay attributes the payload to its sender");
	check(JSON.stringify(relayed.data) === JSON.stringify(payload), "the payload survives untouched");

	// Sharing state, and no echo to the sender.
	bob.send({ t: "sharing", on: true });
	const sharing = await alice.waitFor((m) => m.t === "peer-sharing", "peer-sharing");
	check(sharing.on === true, "sharing state is broadcast");
	await sleep(250);
	check(
		!bob.messages.some((m) => m.t === "peer-sharing"),
		"a client is not told about its own state change",
	);

	// Rename.
	bob.send({ t: "name", name: "Bobby" });
	const renamed = await alice.waitFor((m) => m.t === "peer-name", "peer-name");
	check(renamed.name === "Bobby", "a rename is broadcast");

	// Room isolation.
	carol = connect(otherRoom);
	await carol.opened;
	carol.send({ t: "join", room: otherRoom, name: "Carol" });
	const welcomeC = await carol.waitFor((m) => m.t === "welcome", "Carol's welcome");
	check(welcomeC.peers.length === 0, "a different room starts empty");
	await sleep(400);
	check(!alice.messages.some((m) => m.name === "Carol"), "no participants leak between rooms");

	// A message before joining is ignored rather than relayed.
	const stranger = connect(room);
	await stranger.opened;
	stranger.send({ t: "signal", to: welcomeA.id, data: { candidate: "nope" } });
	await sleep(300);
	check(
		!alice.messages.some((m) => m.t === "signal" && m.data && m.data.candidate === "nope"),
		"a socket that never joined cannot relay",
	);
	stranger.close();
	observer = connect(room);
	await observer.opened;
	observer.send({ t: "join", room, name: "Observer" });
	await observer.waitFor((m) => m.t === "welcome", "third member welcome");

	// Kicking cannot reach a different room.
	alice.send({ t: "kick", to: welcomeC.id });
	await alice.waitFor((m) => m.t === "error", "cross-room kick rejection");
	check(carol.ws.readyState === WebSocket.OPEN, "kick cannot remove someone from another room");
	const kickedClose = new Promise((resolve) => bob.ws.once("close", (code) => resolve(code)));
	alice.send({ t: "kick", to: welcomeB.id });
	await bob.waitFor((m) => m.t === "kicked", "kicked notice");
	check(await kickedClose === 4003, "kicked session receives a removal notice and close code");
	const departed = await alice.waitFor((m) => m.t === "peer-leave", "peer-leave");
	check(departed.id === welcomeB.id, "a departure is announced to the room");
	await observer.waitFor((m) => m.t === "peer-leave" && m.id === welcomeB.id, "third member sees removal");
	const roster = await observer.waitFor((m) => m.t === "room-state", "authoritative room state");
	check(roster.peers.length === 2 && !roster.peers.some((p) => p.id === welcomeB.id), "third member receives the room state without the kicked participant");
	await alice.waitFor((m) => m.t === "kick-confirmed" && m.id === welcomeB.id, "server kick acknowledgement");
	await sleep(200);
	check(alice.messages.filter((m) => m.t === "peer-leave" && m.id === welcomeB.id).length === 1, "kick announces departure exactly once");
	retry = connect(room);
	await retry.opened;
	const retryClosed = new Promise((resolve) => retry.ws.once("close", (code) => resolve(code)));
	retry.send({ t: "join", room, name: "Bob", session });
	await retry.waitFor((m) => m.t === "kicked", "removed login cannot reconnect");
	check(await retryClosed === 4003, "automatic reconnection of a removed login is rejected by the server");
	fresh = connect(room);
	await fresh.opened;
	fresh.send({ t: "join", room, name: "Bob", session: `${session}-fresh` });
	const freshWelcome = await fresh.waitFor((m) => m.t === "welcome", "explicit fresh login");
	check(freshWelcome.peers.length === 2, "explicit new login can rejoin with the same display name");

	alice.close();
	carol.close();
} catch (err) {
	check(false, `unexpected failure: ${err.message}`);
} finally {
	for (const socket of [alice, bob, carol, observer, retry, fresh]) {
		try {
			socket?.close();
		} catch {
			/* already gone */
		}
	}
}

const failed = results.filter((r) => !r.condition);
if (failed.length === 0) {
	console.log(green(`\nPASS -- ${results.length}/${results.length} checks against ${base}`));
	process.exit(0);
}
console.log(red(`\nFAIL -- ${failed.length} of ${results.length} checks failed`));
process.exit(1);
