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
				window.testCapture = canvas.captureStream(15);
				return window.testCapture;
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
	const audioControls = await pageB.evaluate(`(() => {
		const tile = window.focusVideo.closest('.tile'), slider = tile.querySelector('.tile-volume');
		slider.value = '35'; slider.dispatchEvent(new Event('input'));
		const reduced = window.focusVideo.volume === 0.35 && !window.focusVideo.muted;
		tile.querySelector('.tile-mute').click();
		const muted = window.focusVideo.muted;
		tile.querySelector('.tile-mute').click();
		const restored = !window.focusVideo.muted && window.focusVideo.volume === 0.35;
		slider.value = '0'; slider.dispatchEvent(new Event('input'));
		tile.querySelector('.tile-mute').click();
		const zeroRestored = !window.focusVideo.muted && window.focusVideo.volume === 0.35;
		slider.dispatchEvent(new KeyboardEvent('keydown', {key:' ', bubbles:true}));
		return reduced && muted && restored && zeroRestored && tile.classList.contains('focused');
	})()`);
	check(audioControls, "volume, mute restoration and slider keyboard use preserve stream focus");
	await pageB.send("Runtime.evaluate", { expression: "window.focusVideo.closest('.tile').querySelector('.tile-fullscreen').click()", userGesture: true });
	await pageB.waitFor("document.fullscreenElement === window.focusVideo.closest('.tile')", "stream fullscreen");
	check(await pageB.evaluate("getComputedStyle(document.fullscreenElement.querySelector('.tile-fullscreen-exit')).display !== 'none'"), "full screen exposes the exit X");
	await pageB.evaluate("document.fullscreenElement.querySelector('.tile-fullscreen-exit').click()");
	await pageB.waitFor("!document.fullscreenElement", "exit fullscreen");
	check(await pageB.evaluate("window.focusVideo.closest('.tile').classList.contains('focused') && window.focusVideo.volume === 0.35"), "exiting full screen preserves the selected stream and volume");
	await pageB.send("Runtime.evaluate", { expression: "document.querySelector('#stage .tile:not(.focused) .tile-fullscreen').click()", userGesture: true });
	await pageB.waitFor("!!document.fullscreenElement", "thumbnail fullscreen");
	check(await pageB.evaluate("document.fullscreenElement.getBoundingClientRect().width === innerWidth && document.fullscreenElement.querySelector('.tile-volume').disabled"), "a thumbnail can fill the screen while the local preview stays muted");
	await pageB.evaluate("document.fullscreenElement.querySelector('.tile-fullscreen-exit').click()");
	await pageB.waitFor("!document.fullscreenElement", "exit thumbnail fullscreen");
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

	check(await pageA.evaluate("!document.querySelector('#rosterList li:first-child button')"), "your own roster entry cannot kick yourself");
	await launchBrowser(9335);
	const pageC = await openPage(9335);
	await pageC.send("Page.navigate", { url: APP_URL });
	await join(pageC, "Observer");
	await pageC.waitFor("document.querySelector('#stage video')?.videoWidth > 0", "third participant receives Bob's stream");
	await pageA.waitFor("document.querySelectorAll('#rosterList li').length === 3", "three participants join");
	await pageA.evaluate("document.querySelector('#rosterList .roster-member').click(); true");
	check(await pageA.evaluate("!!document.getElementById('memberMenu') && !document.getElementById('kickDialog')"), "clicking a participant opens an action menu without kick confirmation");
	await pageA.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true");
	check(await pageA.evaluate("!document.getElementById('memberMenu') && document.activeElement.classList.contains('roster-member')"), "Escape dismisses the action menu and restores focus");
	await pageA.evaluate("document.querySelector('#rosterList .roster-member').click(); document.getElementById('kickMemberOption').click(); true");
	check(await pageA.evaluate("document.getElementById('kickDialog').open && document.getElementById('kickTitle').textContent.includes('Bob')"), "choosing Kick from session opens confirmation for the selected participant");
	await pageA.evaluate("document.querySelector('#kickDialog .btn').click(); true");
	check(await pageB.evaluate("document.getElementById('statusText').textContent === 'Connected'"), "cancel leaves the participant connected");
	await pageA.evaluate("document.querySelector('#rosterList .roster-member').click(); document.getElementById('kickMemberOption').click(); document.getElementById('confirmKick').click(); true");
	await pageB.waitFor("document.getElementById('statusText').textContent === 'Removed from room' && window.testCapture.getTracks().every(t=>t.readyState==='ended')", "kick stops the sharer's session and tracks");
	for (const page of [pageA, pageC]) await page.waitFor("document.querySelectorAll('#stage .tile').length === 0 && document.querySelectorAll('#rosterList li').length === 2", "kick removes the member and stream for every observer");
	await sleep(1500);
	check(await pageB.evaluate("document.getElementById('gate').hidden === false && document.getElementById('app').hidden && document.getElementById('nameInput').value === '' && !localStorage.getItem('screenroom.name') && !document.querySelector('#gateForm button').disabled"), "kicked participant logs out to the name gate and must explicitly join again");
	check(await pageA.evaluate("document.querySelectorAll('#rosterList li').length === 2"), "kick suppresses automatic rejoining");
	await join(pageB, "Bob");
	for (const page of [pageA, pageB, pageC]) await page.waitFor("document.querySelectorAll('#rosterList li').length === 3", "explicit join restores membership for everyone");
	await pageB.evaluate("document.getElementById('shareBtn').click(); true");
	await pageC.waitFor("document.querySelector('#stage video')?.videoWidth > 0", "rejoined user can share again");
	await pageB.evaluate("document.getElementById('shareBtn').click(); true");
	await pageC.waitFor("document.querySelectorAll('#stage .tile').length === 0", "rejoined user stops sharing without duplicate handlers");
	check(true, "explicit rejoin supports a fresh sharing session without reloading");
	await pageB.evaluate("navigator.mediaDevices.getDisplayMedia=()=>new Promise(resolve=>window.resolvePendingCapture=resolve); document.getElementById('shareBtn').click(); true");
	await pageB.waitFor("!!window.resolvePendingCapture", "pending screen picker");
	await pageA.evaluate("[...document.querySelectorAll('.roster-member')].find(b=>b.textContent.includes('Bob')).click(); document.getElementById('kickMemberOption').click(); document.getElementById('confirmKick').click(); true");
	await pageB.waitFor("document.getElementById('app').hidden", "logout while capture picker is pending");
	await pageB.evaluate("window.testCapture=document.createElement('canvas').captureStream(10); resolvePendingCapture(testCapture); true");
	await pageB.waitFor("testCapture.getTracks().every(t=>t.readyState==='ended') && !document.querySelector('#gateForm button').disabled", "late capture is disposed before rejoin is enabled");
	check(true, "a capture resolving after kick cannot restart the removed stream");
	clearTimeout(overall);

	if (failures.length) {
		console.error(`\nFAIL — ${failures.length} check(s) failed:`);
		for (const f of failures) console.error("  - " + f);
		cleanup();
		process.exit(1);
	}

	console.log("\nPASS — sharing, room-wide removal and explicit rejoin work in three real browsers.");
	cleanup();
	process.exit(0);
} catch (err) {
	console.error("\nFAIL — " + (err && err.message ? err.message : err));
	cleanup();
	process.exit(1);
}
