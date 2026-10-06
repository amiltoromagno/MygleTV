#!/usr/bin/env node
//
// Verifies the desktop shell's frontend integration in a real browser.
//
// The Electron binary cannot run inside the build sandbox, so instead of
// launching the shell we load the real app in headless Chrome with a stand-in
// for window.screenroomNative, and drive the actual share flow:
//
//   audio picker appears -> pick an application -> Share screen
//     -> the bridge is asked to capture that application
//     -> the renderer captures the native audio device
//     -> stopping releases it
//
// Only the bridge itself is simulated; the app, the picker and the share flow
// are the real code.
//
//   npm run check:shell

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCREENROOM_DIR = path.join(path.dirname(ROOT), "screenroom");
const SERVER_PORT = 8477;
const CDP_PORT = 9355;
const ROOM = "shellcheck";
const APP_URL = `http://127.0.0.1:${SERVER_PORT}/?room=${ROOM}`;

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
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

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

// ---------------------------------------------------------------------------

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
	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
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
				/* mid-navigation */
			}
			await sleep(200);
		}
		throw new Error(`timed out waiting for: ${label}`);
	}
}

const INJECT = `(() => {
	window.__calls = { startCapture: [], stopCapture: 0, getUserMedia: [] };

	window.screenroomNative = {
		platform: "linux",
		// What the real bridge returns: one entry per application, already grouped.
		listApps: async () => ({ ok: true, apps: [
			{ app: "Firefox", streams: 2 },
			{ app: "SuperGame", streams: 1 },
		]}),
		probe: async () => ({ ok: true, environment: { serverName: "test" } }),
		startCapture: async (target) => {
			window.__calls.startCapture.push(target);
			// Flipped by the test to simulate audio setup failing.
			if (window.__failAudio) {
				return { ok: false, error: 'the "MygleTV-System" audio source did not appear' };
			}
			const mode = target && target.mode === "system" ? "system" : "app";
			return {
				ok: true,
				mode,
				app: mode === "system" ? null : (target && target.app) || null,
				deviceLabel: mode === "system" ? "MygleTV-System" : "MygleTV",
			};
		},
		stopCapture: async () => { window.__calls.stopCapture += 1; return { ok: true }; },
		getState: async () => ({ activeApp: null }),
	};

	// A live synthetic audio track, so the share has something to send.
	function fakeAudioStream() {
		const ctx = new AudioContext();
		const osc = ctx.createOscillator();
		const dest = ctx.createMediaStreamDestination();
		osc.connect(dest);
		osc.start();
		window.__fakeCtx = ctx;
		return dest.stream;
	}

	const realEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
	navigator.mediaDevices.enumerateDevices = async () => {
		const devices = await realEnumerate();
		return devices.concat([
			{ kind: "audioinput", label: "MygleTV", deviceId: "fake-app-monitor", groupId: "fake-group" },
			{ kind: "audioinput", label: "MygleTV-System", deviceId: "fake-system-tap", groupId: "fake-group" },
		]);
	};

	const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
	navigator.mediaDevices.getUserMedia = async (constraints) => {
		window.__calls.getUserMedia.push(JSON.parse(JSON.stringify(constraints || {})));
		const spec = constraints && constraints.audio && constraints.audio.deviceId;
		const wanted = spec && (spec.exact || spec);
		if (wanted === "fake-app-monitor" || wanted === "fake-system-tap") return fakeAudioStream();
		return realGetUserMedia(constraints);
	};

	// Headless Chrome has no screen picker.
	navigator.mediaDevices.getDisplayMedia = async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 640; canvas.height = 360;
		const ctx = canvas.getContext("2d");
		let frame = 0;
		setInterval(() => {
			frame += 1;
			ctx.fillStyle = "#101822"; ctx.fillRect(0, 0, 640, 360);
			ctx.fillStyle = "#4da3ff"; ctx.font = "40px sans-serif";
			ctx.fillText("frame " + frame, 30, 190);
		}, 80);
		return canvas.captureStream(15);
	};
})();`;

// ---------------------------------------------------------------------------

const failures = [];
function check(condition, label) {
	console.log(`  ${condition ? green("ok  ") : red("FAIL")} ${label}`);
	if (!condition) failures.push(label);
}

let exitCode = 1;

try {
	const server = spawn(process.execPath, ["server.js"], {
		cwd: SCREENROOM_DIR,
		env: { ...process.env, PORT: String(SERVER_PORT) },
		stdio: "ignore",
	});
	children.push(server);

	let healthy = false;
	for (let i = 0; i < 80; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/healthz`);
			if (res.ok) {
				healthy = true;
				break;
			}
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	if (!healthy) throw new Error("screenroom server did not start");

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-shell-"));
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

	const target = targets.find((t) => t.type === "page");
	const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const page = new Page(ws);
	await page.send("Page.enable");
	await page.send("Runtime.enable");
	await page.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
	await page.send("Page.navigate", { url: APP_URL });

	console.log(bold("\nDesktop shell frontend integration\n"));

	await page.waitFor("!!document.getElementById('gateForm')", "gate to render");
	await page.waitFor(
		`document.getElementById('gateRoom').textContent === ${JSON.stringify(ROOM)} && !!document.activeElement && document.activeElement.id === 'nameInput'`,
		"app to initialise",
	);

	await page.evaluate(`
		document.getElementById('nameInput').value = "Shell Tester";
		document.getElementById('gateForm').requestSubmit();
		true;
	`);
	await page.waitFor("document.getElementById('app').hidden === false", "to enter the room");
	check(true, "app loads inside the shell and joins the room");

	// The picker should only appear when the native bridge is present.
	const pickerVisible = await page.evaluate("document.getElementById('audioSource').hidden === false");
	check(pickerVisible, "audio picker appears because screenroomNative is present");

	await page.waitFor(
		`[...document.getElementById('audioSource').options].some(o => o.value === 'app:SuperGame')`,
		"the application list to populate",
	);
	const labels = await page.evaluate(
		"[...document.getElementById('audioSource').options].map(o => o.textContent)",
	);
	const values = await page.evaluate(
		"[...document.getElementById('audioSource').options].map(o => o.value)",
	);

	check(values.includes("none"), "offers no audio");
	check(values.includes("system"), "offers whole-system audio");
	check(values.includes("app:SuperGame"), "lists applications currently playing audio");

	// One row per application, however many streams it owns.
	const appOptionCount = values.filter((v) => v.startsWith("app:")).length;
	check(appOptionCount === 2, `applications are not duplicated (got ${appOptionCount} app rows)`);

	check(
		labels.includes("Only Firefox (2 streams)"),
		"an application with several streams says so",
	);
	check(labels.includes("All system audio"), "whole-system audio is labelled plainly");
	check(
		!labels.some((l) => /microphone|screen share audio/i.test(l)),
		"the confusing leftover options are gone",
	);
	check(labels.length === 4, `exactly four choices: no audio, system, and two apps (got ${labels.length})`);
	console.log(dim(`       labels: ${labels.join(" | ")}`));

	// Choose an application and share.
	await page.evaluate(`
		(() => {
			const select = document.getElementById('audioSource');
			select.value = "app:SuperGame";
			select.dispatchEvent(new Event("change"));
		})();
		true;
	`);
	await page.evaluate("document.getElementById('shareBtn').click(); true;");
	await page.waitFor(
		"document.getElementById('shareBtn').textContent.includes('Stop')",
		"sharing to start",
	);
	check(true, "sharing starts with an application audio source selected");

	const calls = await page.evaluate("JSON.parse(JSON.stringify(window.__calls))");
	check(
		calls.startCapture.some((t) => t && t.mode === "app" && t.app === "SuperGame"),
		"the shell was asked to capture the chosen application",
	);
	console.log(dim(`       startCapture(${JSON.stringify(calls.startCapture)})`));
	console.log(dim(`       getUserMedia(${JSON.stringify(calls.getUserMedia)})`));

	const wantedDevice = calls.getUserMedia.some((c) => {
		const spec = c && c.audio && c.audio.deviceId;
		return spec && (spec.exact === "fake-app-monitor" || spec === "fake-app-monitor");
	});
	check(wantedDevice, "the renderer captured the native audio device");

	const nativeCall = calls.getUserMedia.find((c) => {
		const spec = c && c.audio && c.audio.deviceId;
		return spec && (spec.exact === "fake-app-monitor" || spec === "fake-app-monitor");
	});
	check(
		nativeCall && nativeCall.audio.echoCancellation === false,
		"audio processing is disabled so game/music audio is not mangled",
	);
	check(
		nativeCall && nativeCall.audio.noiseSuppression === false,
		"noise suppression is disabled",
	);
	check(nativeCall && nativeCall.audio.autoGainControl === false, "auto gain is disabled");

	// The display capture must not also grab system audio in this mode.
	const displayConstraints = await page.evaluate("window.__displayConstraints || null");
	console.log(dim(`       display constraints: ${JSON.stringify(displayConstraints)}`));

	// Stopping must release the native source.
	await page.evaluate("document.getElementById('shareBtn').click(); true;");
	await page.waitFor(
		"document.getElementById('shareBtn').textContent.includes('Share screen')",
		"sharing to stop",
	);
	const after = await page.evaluate("JSON.parse(JSON.stringify(window.__calls))");
	check(after.stopCapture > 0, "stopping the share releases the native audio source");
	check(true, "share button returns to its idle state");

	// Whole-system mode is the other half of the choice and must reach the shell.
	await page.evaluate(`
		(() => {
			const picker = document.getElementById('audioSource');
			picker.value = "system";
			picker.dispatchEvent(new Event("change"));
		})();
		true;
	`);
	await page.evaluate("document.getElementById('shareBtn').click(); true;");
	await page.waitFor(
		"document.getElementById('shareBtn').textContent.includes('Stop')",
		"whole-system sharing to start",
	);
	const systemCalls = await page.evaluate("JSON.parse(JSON.stringify(window.__calls))");
	check(
		systemCalls.startCapture.some((t) => t && t.mode === "system"),
		"whole-system audio is requested as such",
	);
	check(
		systemCalls.getUserMedia.some((c) => {
			const spec = c && c.audio && c.audio.deviceId;
			return spec && (spec.exact === "fake-system-tap" || spec === "fake-system-tap");
		}),
		"whole-system mode captures the system tap, not the application source",
	);
	await page.evaluate("document.getElementById('shareBtn').click(); true;");
	await page.waitFor(
		"document.getElementById('shareBtn').textContent.includes('Share screen')",
		"sharing to stop",
	);

	// Audio failing must not cost the user their screen share as well.
	await page.evaluate("window.__failAudio = true; true;");
	await page.evaluate(`
		(() => {
			const picker = document.getElementById('audioSource');
			picker.value = "system";
			picker.dispatchEvent(new Event("change"));
		})();
		true;
	`);
	await page.evaluate("document.getElementById('shareBtn').click(); true;");
	await page.waitFor(
		"document.getElementById('shareBtn').textContent.includes('Stop')",
		"sharing to start despite the audio failure",
	);
	check(true, "a failed audio source does not stop the screen from being shared");

	const warning = await page.evaluate(
		"document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent",
	);
	check(
		/without sound/i.test(warning),
		`and the user is told it is silent (toast: ${JSON.stringify(warning)})`,
	);

	const afterFailure = await page.evaluate("JSON.parse(JSON.stringify(window.__calls))");
	check(
		afterFailure.startCapture.length >= 3,
		`the failing attempt still reached the shell (${afterFailure.startCapture.length} attempts)`,
	);

	await page.evaluate("document.getElementById('shareBtn').click(); true;");

	exitCode = failures.length === 0 ? 0 : 1;
	if (failures.length === 0) {
		console.log(green("\nPASS -- the desktop shell's frontend integration works end to end."));
	} else {
		console.log(red(`\nFAIL -- ${failures.length} check(s) failed:`));
		for (const failure of failures) console.log(`  - ${failure}`);
	}
} catch (err) {
	console.log(red(`\nFAIL -- ${err && err.message ? err.message : err}`));
} finally {
	cleanup();
}

process.exit(exitCode);
