#!/usr/bin/env node
//
// Presence check, including across a hibernation gap.
//
//   node test/presence-check.mjs ws://127.0.0.1:8787/ws
//   node test/presence-check.mjs wss://screenroom.example.workers.dev/ws --gap 35
//
// The `--gap` option is the point of this file. On Cloudflare the room's Durable
// Object is evicted once it goes idle, and a real session has exactly that shape:
// you open the desktop app, then a minute later someone opens a browser. If
// anything about membership failed to survive eviction, the second person would
// land in an apparently empty room -- and that is a bug no immediate-connect
// test would ever catch.

import WebSocket from "ws";

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--")) || "ws://127.0.0.1:8787/ws";
const gapIndex = args.indexOf("--gap");
const gapSeconds = gapIndex === -1 ? 0 : Number(args[gapIndex + 1]) || 0;

const room = `presence-${Math.random().toString(36).slice(2, 8)}`;
const url = `${base}?room=${encodeURIComponent(room)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function client() {
	const ws = new WebSocket(url);
	const messages = [];
	ws.on("message", (data) => {
		try {
			messages.push(JSON.parse(data.toString()));
		} catch {
			/* ignore */
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
		close: () => ws.close(),
	};
}

async function waitFor(socket, predicate, label, timeoutMs = 10_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const found = socket.messages.find(predicate);
		if (found) return found;
		await sleep(200);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const results = [];
function check(condition, label) {
	console.log(`  ${condition ? green("ok  ") : red("FAIL")} ${label}`);
	results.push(condition);
}

try {
	console.log(`\nPresence against ${base}`);
	console.log(dim(`  room ${room}${gapSeconds ? `, with a ${gapSeconds}s idle gap` : ""}\n`));

	const first = client();
	await first.opened;
	first.send({ t: "join", room, name: "Akiyama" });
	const welcomeA = await waitFor(first, (m) => m.t === "welcome", "the first welcome");
	check(welcomeA.peers.length === 0, "the first person is alone");

	if (gapSeconds > 0) {
		console.log(dim(`  idling for ${gapSeconds}s so the room can be evicted...`));
		await sleep(gapSeconds * 1000);
	}

	const second = client();
	await second.opened;
	second.send({ t: "join", room, name: "Akiyama 2" });

	const welcomeB = await waitFor(second, (m) => m.t === "welcome", "the second welcome");
	check(
		welcomeB.peers.length === 1 && welcomeB.peers[0].name === "Akiyama",
		`the second person sees the first (saw ${welcomeB.peers.length})`,
	);
	if (welcomeB.peers.length === 0) {
		console.log(dim("        the room looked empty to the newcomer"));
	}

	const announced = first.messages.some((m) => m.t === "peer-join" && m.name === "Akiyama 2");
	check(announced, "the first person is told about the second");

	// And the roster each side would render.
	const rosterFirst = [welcomeA.peers.length + 1, first.messages.filter((m) => m.t === "peer-join").length + 1];
	const rosterSecond = welcomeB.peers.length + 1;
	check(rosterFirst[1] === 2, `the first person's roster fills to 2 (got ${rosterFirst[1]})`);
	check(rosterSecond === 2, `the second person's roster fills to 2 (got ${rosterSecond})`);

	first.close();
	second.close();
} catch (err) {
	check(false, `unexpected failure: ${err.message}`);
}

const failed = results.filter((r) => !r).length;
if (failed === 0) {
	console.log(green("\nPASS"));
	process.exit(0);
}
console.log(red(`\nFAIL -- ${failed} of ${results.length} checks failed`));
process.exit(1);
