#!/usr/bin/env node
//
// How the app decides which room you are in.
//
//   node test/room-resolution.mjs https://screenroom.example.workers.dev
//
// The question this answers: the desktop client is launched against an origin,
// so where does its room come from? And does the other person need to type
// ?room=main to meet you there?

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const origin = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const CDP_PORT = Number(process.env.CDP_PORT || 9388);

const CHROME_CANDIDATES = [
	process.env.CHROME,
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const children = [];
const tempDirs = [];
function cleanup() {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* gone */
		}
	}
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}
process.on("exit", cleanup);

function cdp(ws) {
	let nextId = 0;
	return (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			const onMessage = (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.id !== id) return;
				ws.off("message", onMessage);
				if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
				else resolve(msg.result);
			};
			ws.on("message", onMessage);
			ws.send(JSON.stringify({ id, method, params }));
		});
}

const results = [];
function check(condition, label) {
	console.log(`  ${condition ? green("ok  ") : red("FAIL")} ${label}`);
	results.push(condition);
}

try {
	console.log(`\nRoom resolution against ${origin}\n`);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-room-"));
	tempDirs.push(userDataDir);
	const chrome = spawn(
		CHROME_CANDIDATES[0],
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--no-first-run",
			"--no-default-browser-check",
			`--user-data-dir=${userDataDir}`,
			`--remote-debugging-port=${CDP_PORT}`,
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	children.push(chrome);

	let targets = null;
	for (let i = 0; i < 120; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
			if (res.ok) {
				targets = await res.json();
				break;
			}
		} catch {
			/* not up */
		}
		await sleep(100);
	}
	if (!targets) throw new Error("Chrome DevTools endpoint never came up");

	const target = targets.find((t) => t.type === "page");
	const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const send = cdp(ws);
	await send("Page.enable");
	await send("Runtime.enable");

	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
		return result.result?.value;
	};

	// 1. Bare origin, which is exactly what `SCREENROOM_URL=<origin> npm start`
	//    loads: the desktop client never appends a query of its own.
	await send("Page.navigate", { url: `${origin}/` });
	for (let i = 0; i < 50; i++) {
		try {
			if (await evaluate("!!document.getElementById('gateRoom')")) break;
		} catch {
			/* navigating */
		}
		await sleep(150);
	}
	await sleep(400);
	const bare = await evaluate("document.getElementById('gateRoom').textContent");
	check(bare === "main", `a bare origin lands in "main" (got "${bare}")`);

	// 2. An explicit room wins.
	await send("Page.navigate", { url: `${origin}/?room=game-night` });
	await sleep(900);
	const explicit = await evaluate("document.getElementById('gateRoom').textContent");
	check(explicit === "game-night", `?room=game-night is honoured (got "${explicit}")`);

	// 3. The invite link the sharer copies matches the room they are in.
	await evaluate(`
		document.getElementById('nameInput').value = "Tester";
		document.getElementById('gateForm').requestSubmit();
		true;
	`);
	await sleep(500);
	const invite = await evaluate(`
		(() => {
			const url = new URL(location.href);
			url.searchParams.set("room", document.getElementById("roomLabel").textContent);
			return url.toString();
		})()
	`);
	check(invite.includes("room=game-night"), `the invite link carries the room (${invite})`);

	// 4. Both routes reach the same relay room, which is the thing that actually
	//    determines whether two people meet.
	const wsToMain = new WebSocket(`${origin.replace("https", "wss").replace("http", "ws")}/ws?room=main`);
	await new Promise((resolve, reject) => {
		wsToMain.on("open", resolve);
		wsToMain.on("error", reject);
	});
	wsToMain.send(JSON.stringify({ t: "join", room: "main", name: "Bare" }));
	const welcome = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no welcome from /ws?room=main")), 6000);
		wsToMain.on("message", (d) => {
			clearTimeout(timer);
			resolve(JSON.parse(d.toString()));
		});
	});
	check(welcome.t === "welcome", "the relay accepts the defaulted room name");
	wsToMain.close();
} catch (err) {
	check(false, `unexpected failure: ${err.message}`);
} finally {
	cleanup();
}

const failed = results.filter((r) => !r).length;
if (failed === 0) {
	console.log(green("\nPASS"));
	process.exit(0);
}
console.log(red(`\nFAIL -- ${failed} check(s) failed`));
process.exit(1);
