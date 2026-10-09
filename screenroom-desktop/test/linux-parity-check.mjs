#!/usr/bin/env node
//
// Does the Linux desktop client get the same player as everyone else?
//
//   npm run check:linux-parity
//
// The enhanced player -- volume, mute, full screen, click-to-focus and the
// per-participant manage button -- was gated on `!hasNative || isWindowsNative`.
// Browser viewers and the Windows shell had it; the Linux desktop app, which is
// `hasNative` and not Windows, silently did not. The code being withheld was
// platform-neutral, so the gate only ever excluded one client.
//
// This runs the real frontend against the real Node server, pretending to be the
// Linux desktop shell, and asserts the controls are actually rendered. A unit
// test cannot catch this: the bug was a missing branch, which only shows up in
// the DOM.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_DIR = path.join(ROOT, "..", "screenroom");

// Random ports, not fixed ones. A previous run's Chrome can outlive its
// kill signal for a moment, and a stale process holding the debug port means
// this script silently drives the *old* browser instead of the new one -- which
// looks exactly like a flaky feature.
const HTTP_PORT = 8600 + Math.floor(Math.random() * 300);
const CDP_PORT = 9500 + Math.floor(Math.random() * 300);
const ROOM = `parity-${Math.random().toString(36).slice(2, 8)}`;

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

try {
	console.log(`\nLinux desktop parity\n`);

	// The real signaling server, so /ws behaves exactly as in production.
	const server = spawn(process.execPath, ["server.js"], {
		cwd: SERVER_DIR,
		env: { ...process.env, PORT: String(HTTP_PORT), HOST: "127.0.0.1" },
		stdio: "ignore",
	});
	children.push(server);
	let up = false;
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`);
			if (res.ok) {
				up = true;
				break;
			}
		} catch {
			/* starting */
		}
		await sleep(150);
	}
	if (!up) throw new Error("the signaling server never came up");

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-parity-"));
	tempDirs.push(userDataDir);
	const chrome = spawn(
		CHROME_CANDIDATES[0],
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--use-fake-ui-for-media-stream",
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

	// Appear to be the Linux desktop shell. This is the whole point: with the old
	// gate, this exact combination is what lost the controls.
	await send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
			// Count AudioContext constructions. Amplification above 100% routes
			// playback through Web Audio, so one appearing proves the boost path is
			// live rather than merely offered by the UI.
			window.__audioContexts = 0;
			const NativeAudioContext = window.AudioContext;
			window.AudioContext = function (...args) {
				window.__audioContexts++;
				return new NativeAudioContext(...args);
			};
			window.AudioContext.prototype = NativeAudioContext.prototype;

			window.screenroomNative = {
				platform: "linux",
				listApps: async () => ({ ok: true, apps: [] }),
				probe: async () => ({ ok: true, environment: { backend: "pipewire" } }),
				startCapture: async () => ({ ok: true, mode: "system", app: null, deviceLabel: "MygleTV-System" }),
				stopCapture: async () => ({ ok: true }),
				getState: async () => ({ activeApp: null, activeMode: null }),
			};
		`,
	});

	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
		return result.result?.value;
	};
	const waitFor = async (expression, label, timeoutMs = 15_000) => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			try {
				if (await evaluate(expression)) return true;
			} catch {
				/* mid-navigation */
			}
			await sleep(200);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/?room=${ROOM}` });
	await waitFor("!!document.getElementById('gateForm')", "the gate");
	// The gate focuses its input once app.js has run. Submitting before that
	// fires the form's *native* submit and navigates the page away, which shows
	// up as a flaky "never joined" rather than anything resembling a form bug.
	await waitFor("document.activeElement && document.activeElement.id === 'nameInput'", "the app to initialise");
	check(await evaluate("Boolean(window.screenroomNative)"), "the page sees a native bridge");
	check(
		(await evaluate("window.screenroomNative.platform")) === "linux",
		"and it reports platform linux, so hasNative is true and isWindowsNative is false",
	);

	await evaluate(`
		document.getElementById('nameInput').value = "LinuxUser";
		document.getElementById('gateForm').requestSubmit();
		true;
	`);
	await waitFor("document.getElementById('app').hidden === false", "joining");

	// A second participant, so there is a remote entry to inspect. It has to
	// announce that it is sharing, because a tile is only rendered for someone
	// who is actually publishing; a quiet participant appears in the roster only.
	const peer = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws?room=${ROOM}`);
	await new Promise((resolve, reject) => {
		peer.on("open", resolve);
		peer.on("error", reject);
	});
	peer.send(JSON.stringify({ t: "join", room: ROOM, name: "Remote" }));
	await sleep(600);
	check(
		(await evaluate("document.querySelectorAll('#rosterList .roster-member').length")) >= 1,
		"remote participants have a manage button in the roster",
	);
	peer.send(JSON.stringify({ t: "sharing", on: true }));
	await sleep(1200);

	await waitFor("document.querySelectorAll('#stage .tile').length >= 1", "a remote tile");
	check(true, "a sharing remote participant renders as a tile");

	check(
		(await evaluate("document.querySelectorAll('#stage .tile .tile-volume').length")) >= 1,
		"the tile has a volume slider",
	);
	check(
		(await evaluate("document.querySelectorAll('#stage .tile .tile-fullscreen').length")) >= 1,
		"the tile has a full screen button",
	);
	check(
		(await evaluate("document.querySelectorAll('#stage .tile .tile-mute').length")) >= 1,
		"the tile has a mute button",
	);

	// The application list is built from what is *playing*, not what is open, so an
	// empty one is the normal case -- and it used to be indistinguishable from a
	// picker that had failed. The fake bridge here reports no applications, which
	// is exactly that state.
	const audioLabels = await evaluate(
		"[...document.getElementById('audioSource').options].map((o) => o.textContent)",
	);
	check(
		audioLabels.some((label) => /No app is playing audio yet/.test(label)),
		`an empty application list explains itself (${audioLabels.join(" | ")})`,
	);

	// Amplification above 100% is plain Web Audio, so the Linux client must offer
	// it too. It was gated to browsers and the Windows shell for a while, which
	// left this client -- the only one excluded -- with a slider stopping at 100%.
	const max = await evaluate("document.querySelector('#stage .tile .tile-volume').max");
	check(max === "300", `the volume slider reaches 300% (max is ${max})`);
	check(
		(await evaluate("document.querySelectorAll('#stage .tile .tile-volume-value').length")) >= 1,
		"and displays the current level",
	);

	await evaluate(`
		(() => {
			const slider = document.querySelector('#stage .tile .tile-volume');
			slider.value = "250";
			slider.dispatchEvent(new Event("input", { bubbles: true }));
		})();
		true;
	`);
	await sleep(500);
	const contexts = await evaluate("window.__audioContexts");
	const level = await evaluate("document.querySelector('#stage .tile .tile-volume-value').textContent");
	check(contexts > 0, `amplifying above 100% engages the Web Audio path (${contexts} context(s))`);
	check(level === "250%", `and the readout follows the slider (${level})`);

	// Stream quality: the remaining Windows-only feature. Linux has no native
	// bridge method for it, so the preference has to land in localStorage.
	await waitFor("!!document.getElementById('qualityBtn')", "the quality button");
	check(true, "the desktop client offers stream quality");

	await evaluate("document.getElementById('qualityBtn').click(); true");
	check(
		await evaluate("document.getElementById('qualityDialog').open === true"),
		"the quality dialog opens",
	);

	await evaluate(`
		document.getElementById('qualityBitrate').value = "12";
		document.getElementById('qualityFps').value = "60";
		document.getElementById('qualityResolution').value = "1080p";
		document.getElementById('qualityForm').requestSubmit();
		true;
	`);
	await sleep(800);

	const stored = await evaluate("localStorage.getItem('mygletv.quality')");
	let parsed = null;
	try {
		parsed = JSON.parse(stored);
	} catch {
		/* left null, reported below */
	}
	check(
		parsed && parsed.bitrate === 12 && parsed.fps === 60 && parsed.resolution === "1080p",
		`the chosen profile persists in localStorage (${stored})`,
	);

	// And it is actually in force, not merely written down.
	const applied = await evaluate("document.getElementById('qualityBitrate').value");
	check(applied === "12", `the dialog reopens on the saved profile (bitrate ${applied})`);

	peer.close();
} catch (err) {
	check(false, `unexpected failure: ${err.message}`);
} finally {
	cleanup();
}

const failed = results.filter((r) => !r).length;
if (failed === 0) {
	console.log(green("\nPASS -- the Linux desktop client renders the full player"));
	process.exit(0);
}
console.log(red(`\nFAIL -- ${failed} of ${results.length} checks failed`));
process.exit(1);
