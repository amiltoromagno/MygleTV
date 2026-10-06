#!/usr/bin/env node
//
// Drives the real app against a running relay, in real browsers.
//
//   node test/browser-check.mjs http://127.0.0.1:8787
//
// Point it at `wrangler dev` for the Cloudflare path, or at the Node server.
// This is the check that matters most: the conformance suite talks the protocol
// directly, whereas this loads the actual frontend and lets it negotiate.
//
// localhost counts as a secure context, so mediaDevices exists without TLS.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const origin = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const CDP_PORT = Number(process.env.CDP_PORT || 9377);
const ROOM = `browse-${Math.random().toString(36).slice(2, 8)}`;

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

class Page {
	constructor(ws, label) {
		this.ws = ws;
		this.label = label;
		this.nextId = 0;
	}
	send(method, params = {}) {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const onMessage = (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.id !== id) return;
				this.ws.off("message", onMessage);
				if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
				else resolve(msg.result);
			};
			this.ws.on("message", onMessage);
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails) {
			throw new Error(
				`${this.label} threw: ` +
					(result.exceptionDetails.exception?.description || result.exceptionDetails.text),
			);
		}
		return result.result?.value;
	}
	async waitFor(expression, label, timeoutMs = 20_000) {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			try {
				if (await this.evaluate(expression)) return true;
			} catch {
				/* mid-navigation */
			}
			await sleep(200);
		}
		throw new Error(`${this.label}: timed out waiting for ${label}`);
	}
}

async function openPage(target, label) {
	const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const page = new Page(ws, label);
	await page.send("Page.enable");
	await page.send("Runtime.enable");
	return page;
}

const results = [];
function check(condition, label) {
	console.log(`  ${condition ? green("ok  ") : red("FAIL")} ${label}`);
	results.push({ condition, label });
}

try {
	const url = `${origin}/?room=${ROOM}`;
	console.log(`\nReal browsers against ${origin}\n`);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-cf-"));
	tempDirs.push(userDataDir);
	const chrome = spawn(
		CHROME_CANDIDATES[0],
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--use-fake-ui-for-media-stream",
			"--autoplay-policy=no-user-gesture-required",
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

	const second = await (
		await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })
	).json();
	const all = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
	const firstTarget = all.find((t) => t.type === "page" && t.id !== second.id);
	if (!firstTarget) throw new Error("could not find two distinct page targets");

	const one = await openPage(firstTarget, "Alice");
	const two = await openPage(second, "Bob");
	check(firstTarget.id !== second.id, "two independent browser tabs");

	for (const [page, name] of [
		[one, "Alice"],
		[two, "Bob"],
	]) {
		await page.send("Page.navigate", { url });
		await page.waitFor("!!document.getElementById('gateForm')", "the gate to render");
		await page.waitFor(
			`document.getElementById('gateRoom').textContent === ${JSON.stringify(ROOM)} && !!document.activeElement && document.activeElement.id === 'nameInput'`,
			"the app to initialise",
		);
		await page.evaluate(`
			document.getElementById('nameInput').value = ${JSON.stringify(name)};
			document.getElementById('gateForm').requestSubmit();
			true;
		`);
		await page.waitFor("document.getElementById('app').hidden === false", `${name} to join`);
	}

	check(await one.evaluate("window.isSecureContext"), "the origin is a secure context");
	check(
		(await one.evaluate("typeof navigator.mediaDevices")) === "object",
		"navigator.mediaDevices exists, so sharing is possible",
	);

	await one.waitFor(
		"document.getElementById('statusText').textContent === 'Connected'",
		"Alice's signaling to connect",
	);
	await two.waitFor(
		"document.getElementById('statusText').textContent === 'Connected'",
		"Bob's signaling to connect",
	);
	check(true, "both clients connected their signaling to the relay");

	await one.waitFor("document.querySelectorAll('#rosterList li').length === 2", "both to appear");
	await two.waitFor("document.querySelectorAll('#rosterList li').length === 2", "both to appear");
	check(true, "each client sees the other in the roster");

	const names = await one.evaluate(
		"[...document.querySelectorAll('#rosterList .roster-name')].map(n => n.textContent)",
	);
	check(
		names.some((n) => n.includes("Alice")) && names.some((n) => n.includes("Bob")),
		"the roster carries both names",
	);

	// A real share: the audio source is unavailable headlessly, so this exercises
	// the screen path and proves the peers negotiate through the relay.
	await one.evaluate(`
		navigator.mediaDevices.getDisplayMedia = async () => {
			const c = document.createElement("canvas");
			c.width = 320; c.height = 180;
			const g = c.getContext("2d");
			let f = 0;
			setInterval(() => { f++; g.fillStyle = "#123"; g.fillRect(0,0,320,180); g.fillStyle = "#4da3ff"; g.fillText("f"+f, 20, 90); }, 90);
			return c.captureStream(12);
		};
		true;
	`);
	await one.evaluate("document.getElementById('shareBtn').click(); true;");
	await one.waitFor(
		"document.getElementById('shareBtn').textContent.includes('Stop')",
		"sharing to start",
	);
	await two.waitFor("document.querySelectorAll('#stage .tile').length === 1", "a tile to arrive");
	check(true, "a share reaches the other browser through the relay");

	await two.waitFor(
		`(() => {
			const v = document.querySelector('#stage .tile video');
			return !!v && v.videoWidth > 0 && v.currentTime > 0.2;
		})()`,
		"video to be playing",
	);
	const video = await two.evaluate(`(() => {
		const v = document.querySelector('#stage .tile video');
		return { w: v.videoWidth, h: v.videoHeight, t: Math.round(v.currentTime * 10) / 10 };
	})()`);
	check(video.w > 0 && video.t > 0, `media is flowing (${video.w}x${video.h}, ${video.t}s)`);
} catch (err) {
	check(false, `unexpected failure: ${err.message}`);
} finally {
	cleanup();
}

const failed = results.filter((r) => !r.condition);
if (failed.length === 0) {
	console.log(green(`\nPASS -- the real app works against ${origin}`));
	process.exit(0);
}
console.log(red(`\nFAIL -- ${failed.length} of ${results.length} checks failed`));
process.exit(1);
