#!/usr/bin/env node
//
// Does the app join the room it says it is in?
//
//   node test/room-join-check.mjs https://screenroom.example.workers.dev
//
// The room-resolution test checks what the gate *displays*. This checks what the
// client actually connects to -- loaded at a bare origin, with no query string,
// which is exactly what `SCREENROOM_URL=<origin> npm start` loads.
//
// A page that shows "main" but joins something else would be invisible until two
// people failed to find each other, so it is worth asserting directly.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const origin = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const CDP_PORT = Number(process.env.CDP_PORT || 9399);

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

const results = [];
function check(condition, label) {
	console.log(`  ${condition ? green("ok  ") : red("FAIL")} ${label}`);
	results.push(condition);
}

/** A raw client that stands in for the other person. */
function watcher(room, name) {
	const wsUrl = `${origin.replace(/^http/, "ws")}/ws?room=${encodeURIComponent(room)}`;
	const ws = new WebSocket(wsUrl);
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

try {
	console.log(`\nDoes the app join the room it claims, at a bare origin?\n`);
	console.log(`  ${origin}/   (no query string)\n`);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-join-"));
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

	let nextId = 0;
	const send = (method, params = {}) =>
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

	await send("Page.enable");
	await send("Runtime.enable");

	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
		return result.result?.value;
	};

	// Record what URL the client actually opens for signaling.
	//
	// The wrapper has to carry over the static constants: signaling.js compares
	// against WebSocket.OPEN, and an undefined constant would make every send()
	// quietly return false -- breaking the app we are trying to observe.
	await send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
			window.__sockets = [];
			const Original = window.WebSocket;
			const Wrapper = function (url, protocols) {
				window.__sockets.push(String(url));
				return protocols ? new Original(url, protocols) : new Original(url);
			};
			Wrapper.prototype = Original.prototype;
			for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
				Wrapper[key] = Original[key];
			}
			window.WebSocket = Wrapper;
		`,
	});

	await send("Page.navigate", { url: `${origin}/` });
	await sleep(1200);
	await evaluate(`
		document.getElementById('nameInput').value = "Akiyama";
		document.getElementById('gateForm').requestSubmit();
		true;
	`);
	await sleep(2500);

	const shownRoom = await evaluate("document.getElementById('roomLabel').textContent");
	check(shownRoom === "main", `the app reports the room as "main" (got "${shownRoom}")`);

	const sockets = await evaluate("JSON.parse(JSON.stringify(window.__sockets || []))");
	const socketUrl = sockets[0] || "";
	check(socketUrl.includes("/ws"), `it opened a signaling socket (${socketUrl || "none"})`);
	check(
		socketUrl.includes("room=main"),
		`and named the room in it (${socketUrl.split("?")[1] || "no query"})`,
	);

	// The decisive bit: a second person in "main" must find them.
	const other = watcher("main", "Akiyama 2");
	await other.opened;
	other.send({ t: "join", room: "main", name: "Akiyama 2" });

	let peers = null;
	for (let i = 0; i < 40; i++) {
		const welcome = other.messages.find((m) => m.t === "welcome");
		if (welcome) {
			peers = welcome.peers;
			break;
		}
		await sleep(250);
	}
	check(peers !== null, "the second person got a welcome");
	if (peers) {
		check(
			peers.some((p) => p.name === "Akiyama"),
			`the second person sees the app's user (saw ${JSON.stringify(peers.map((p) => p.name))})`,
		);
	}

	const appSawOther = await evaluate(
		"[...document.querySelectorAll('#rosterList .roster-name')].map(n => n.textContent)",
	);
	check(
		appSawOther.some((n) => n.includes("Akiyama 2")),
		`the app sees the second person (roster: ${JSON.stringify(appSawOther)})`,
	);

	other.close();
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
console.log(red(`\nFAIL -- ${failed} of ${results.length} checks failed`));
process.exit(1);
