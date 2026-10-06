// Full end-to-end check: two real browsers, the real server, the real UI.
//
// Everything is exercised as a user would: the name gate, joining a room from
// the link, the roster, pressing "Share screen", and the other browser seeing
// that share appear and start playing.
//
// The one thing a headless browser cannot provide is a screen-picker dialog, so
// navigator.mediaDevices.getDisplayMedia is replaced with a canvas capture
// before the app loads. Everything downstream of it is the real code path.
//
//   npm run test:e2e

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_PORT = 8455;
const ROOM = "e2e-room";
const APP_URL = `http://127.0.0.1:${SERVER_PORT}/?room=${ROOM}`;
const DEADLINE_MS = 60_000;

const CHROME_CANDIDATES = [
	process.env.CHROME,
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const children = [];
const tempDirs = [];

function cleanup() {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
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
	constructor(ws) {
		this.ws = ws;
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

	async evaluate(expression, awaitPromise = false) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise,
		});
		if (result.exceptionDetails) {
			throw new Error(
				"page threw: " +
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
				/* page may be mid-navigation */
			}
			await sleep(200);
		}
		throw new Error(`timed out waiting for: ${label}`);
	}
}

async function launchBrowser(debugPort) {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenroom-e2e-"));
	tempDirs.push(userDataDir);

	for (const bin of CHROME_CANDIDATES) {
		const child = spawn(
			bin,
			[
				"--headless=new",
				"--no-sandbox",
				"--disable-dev-shm-usage",
				"--autoplay-policy=no-user-gesture-required",
				"--no-first-run",
				"--no-default-browser-check",
				`--user-data-dir=${userDataDir}`,
				`--remote-debugging-port=${debugPort}`,
				"about:blank",
			],
			{ stdio: ["ignore", "ignore", "ignore"] },
		);
		child.on("error", () => {});
		children.push(child);

		for (let i = 0; i < 120; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
				if (res.ok) return { bin, child, debugPort };
			} catch {
				/* not up yet */
			}
			await sleep(100);
		}
		try {
			child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}
	throw new Error("No Chrome/Chromium binary found. Set CHROME=/path/to/chrome.");
}

async function openPage(debugPort) {
	const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
	const target = targets.find((t) => t.type === "page");
	if (!target) throw new Error("no page target");

	const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});

	const page = new Page(ws);
	await page.send("Page.enable");
	await page.send("Runtime.enable");

	// Stand in for the screen picker, before any app code runs.
	await page.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `(() => {
			const md = navigator.mediaDevices;
			md.getDisplayMedia = async function () {
				const canvas = document.createElement("canvas");
				canvas.width = 640;
				canvas.height = 360;
				const ctx = canvas.getContext("2d");
				let frame = 0;
				setInterval(() => {
					frame += 1;
					ctx.fillStyle = "#101822";
					ctx.fillRect(0, 0, 640, 360);
					ctx.fillStyle = "#4da3ff";
					ctx.font = "40px sans-serif";
					ctx.fillText("stub " + frame, 30, 190);
				}, 80);
				return canvas.captureStream(15);
			};
		})();`,
	});

	return page;
}

// init() populates the room label and, as its final statement, focuses the name
// field. Waiting for both proves the submit handler is attached before we poke
// the form -- otherwise requestSubmit() falls through to a native navigation.
const READY_EXPR = `document.getElementById('gateRoom').textContent === ${JSON.stringify(ROOM)} && !!document.activeElement && document.activeElement.id === 'nameInput'`;

async function waitForApp(page) {
	await page.waitFor("!!document.getElementById('gateForm')", "the gate to render");
	await page.waitFor(READY_EXPR, "the app to finish initialising");
}

async function join(page, name) {
	await waitForApp(page);
	await page.evaluate(`
		document.getElementById('nameInput').value = ${JSON.stringify(name)};
		document.getElementById('gateForm').requestSubmit();
		true;
	`);
	await page.waitFor("document.getElementById('app').hidden === false", `${name} to enter the room`);
}

const failures = [];
function check(condition, label) {
	if (condition) {
		console.log("  ok   " + label);
	} else {
		console.log("  FAIL " + label);
		failures.push(label);
	}
}

// ---------------------------------------------------------------------------

const server = spawn(process.execPath, ["server.js"], {
	cwd: ROOT,
	env: { ...process.env, PORT: String(SERVER_PORT) },
	stdio: ["ignore", "ignore", "ignore"],
});
children.push(server);

try {
	let ready = false;
	for (let i = 0; i < 80; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/healthz`);
			if (res.ok) {
				ready = true;
				break;
			}
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	if (!ready) throw new Error("server never became healthy");

	console.log("screen room end-to-end\n");

	const alice = await launchBrowser(9333);
	const bob = await launchBrowser(9334);
	console.log(`browsers: ${alice.bin} x2\n`);

	const pageA = await openPage(9333);
	const pageB = await openPage(9334);

	const overall = setTimeout(() => {
		console.error("\nFAIL — overall timeout");
		cleanup();
		process.exit(1);
	}, DEADLINE_MS);

	// The gate is the first thing a visitor sees.
	await pageA.send("Page.navigate", { url: APP_URL });
	await waitForApp(pageA);

	const gateText = await pageA.evaluate("document.querySelector('.gate-card h1').textContent");
	check(gateText === "MygleTV", "name gate is shown before entering");
	check(
		(await pageA.evaluate("document.getElementById('gateRoom').textContent")) === ROOM,
		"the room in the link is what the gate reports",
	);

	await join(pageA, "Alice");
	check(true, "Alice submits her name and enters the room");

	await pageB.send("Page.navigate", { url: APP_URL });
	await join(pageB, "Bob");
	check(true, "Bob submits his name and enters the room (no auth, same link)");

	// Both sides should now see each other.
	await pageA.waitFor("document.querySelectorAll('#rosterList li').length === 2", "Alice to see 2 people");
	await pageB.waitFor("document.querySelectorAll('#rosterList li').length === 2", "Bob to see 2 people");
	check(true, "both browsers show two people in the roster");

	const namesOnA = await pageA.evaluate(
		"[...document.querySelectorAll('#rosterList .roster-name')].map(n => n.textContent)",
	);
	check(
		namesOnA.some((n) => n.includes("Alice")) && namesOnA.some((n) => n.includes("Bob")),
		"roster lists both display names",
	);

	// Nobody is sharing yet.
	check(
		(await pageA.evaluate("document.getElementById('empty').hidden === false")) === true,
		"the empty state explains that nobody is sharing",
	);

	// Alice shares. The stub stands in for the picker.
	await pageA.evaluate("document.getElementById('shareBtn').click(); true;");
	await pageA.waitFor(
		"document.getElementById('shareBtn').textContent.includes('Stop')",
		"Alice's button to flip to Stop sharing",
	);
	check(true, "pressing Share screen starts a share");

	await pageA.waitFor("document.querySelectorAll('#stage .tile').length === 1", "Alice's own tile");
	check(true, "the sharer sees her own screen as a tile");

	// Bob should receive it.
	await pageB.waitFor("document.querySelectorAll('#stage .tile').length === 1", "Bob to get a tile");
	const tileName = await pageB.evaluate("document.querySelector('#stage .tile .tile-name').textContent");
	check(tileName === "Alice", "Bob's tile is labelled with the sharer's name");

	const tileBadge = await pageB.evaluate(
		"document.querySelector('#stage .tile .tile-badge').textContent",
	);
	check(
		tileBadge !== "You",
		"Bob's tile is not marked as his own screen",
	);

	// And it should actually be playing video, not just a black box.
	await pageB.waitFor(
		`(() => {
			const v = document.querySelector('#stage .tile video');
			return !!v && v.videoWidth > 0 && v.currentTime > 0.2;
		})()`,
		"video to be playing on Bob's side",
	);
	const videoState = await pageB.evaluate(`(() => {
		const v = document.querySelector('#stage .tile video');
		return { w: v.videoWidth, h: v.videoHeight, t: Math.round(v.currentTime * 10) / 10, muted: v.muted };
	})()`);
	check(videoState.w > 0 && videoState.h > 0, `receiving video at ${videoState.w}x${videoState.h}`);
	check(videoState.t > 0, `playback is advancing (${videoState.t}s)`);

	// The overlay that covers an unstarted tile must be gone.
	check(
		(await pageB.evaluate("document.querySelector('#stage .tile .tile-overlay').hidden")) === true,
		"the 'Connecting…' overlay is cleared once media arrives",
	);

	// Bob shares too: two simultaneous shares, which is the point of the app.
	await pageB.evaluate("document.getElementById('shareBtn').click(); true;");
	await pageA.waitFor("document.querySelectorAll('#stage .tile').length === 2", "two tiles on Alice");
	await pageB.waitFor("document.querySelectorAll('#stage .tile').length === 2", "two tiles on Bob");
	check(true, "two people sharing at once shows two tiles side by side");
	await pageB.evaluate(`(() => {
		window.focusVideo = [...document.querySelectorAll('#stage .tile')].find(tile => tile.querySelector('.tile-name').textContent === 'Alice').querySelector('video');
		window.focusVideo.closest('.tile').click();
	})()`);
	const focusLayout = await pageB.evaluate(`(() => {
		const focused = document.querySelector('#stage .focused');
		const preview = document.querySelector('#stage .tile:not(.focused)');
		const main = focused.getBoundingClientRect(), small = preview.getBoundingClientRect();
		return { below: small.top >= main.bottom, smaller: small.width < main.width,
			visible: getComputedStyle(preview).display !== 'none', sameVideo: focused.querySelector('video') === window.focusVideo };
	})()`);
	check(focusLayout.below && focusLayout.smaller && focusLayout.visible && focusLayout.sameVideo, "selected stream stays large with the other live stream below as a thumbnail");
	await pageB.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
	check(await pageB.evaluate("!document.getElementById('stage').classList.contains('focus-preview')"), "Escape restores the normal stream grid");
	await pageB.evaluate("window.focusVideo.closest('.tile').click()");

	const sharingCount = await pageA.evaluate("document.querySelectorAll('#rosterList .sharing').length");
	check(sharingCount === 2, "the roster marks both participants as sharing");

	// Stopping removes the tile for everyone.
	await pageA.evaluate("document.getElementById('shareBtn').click(); true;");
	await pageB.waitFor("document.querySelectorAll('#stage .tile').length === 1", "Bob's view to drop to one");
	check(true, "stopping a share removes that tile for everyone");
	check(await pageB.evaluate("!document.getElementById('stage').classList.contains('focus-preview')"), "stopping the selected stream clears the focused layout");

	check(
		(await pageA.evaluate("document.getElementById('shareBtn').textContent")) === "Share screen",
		"the button returns to Share screen after stopping",
	);

	clearTimeout(overall);

	if (failures.length) {
		console.error(`\nFAIL — ${failures.length} check(s) failed:`);
		for (const f of failures) console.error("  - " + f);
		cleanup();
		process.exit(1);
	}

	console.log("\nPASS — the full user flow works in two real browsers.");
	cleanup();
	process.exit(0);
} catch (err) {
	console.error("\nFAIL — " + (err && err.message ? err.message : err));
	cleanup();
	process.exit(1);
}
