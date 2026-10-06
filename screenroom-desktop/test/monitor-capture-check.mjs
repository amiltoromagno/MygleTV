#!/usr/bin/env node
//
// Does Chromium expose a PipeWire monitor source to getUserMedia?
//
// The spike proved the *routing* works, but it recorded with parecord. The real
// implementation records in the renderer with getUserMedia, and browsers are
// known to hide monitor sources to avoid feedback loops. If Chromium filters
// them out, the whole renderer design has to change.
//
// So: create the capture sink, play a tone straight into it, then ask Chrome to
// list and capture it.
//
//   npm run check:monitor

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { DEFAULT_CAPTURE_SINK, LinuxAudioRouter, registerExitCleanup } from "../audio/linux.js";
import { VIRTUAL_MIC_LABEL, VIRTUAL_MIC_NAME } from "../audio/session.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HTTP_PORT = 8466;
const CDP_PORT = 9344;
const RATE = 48_000;
const CHANNELS = 2;

const CHROME_CANDIDATES = [
	process.env.CHROME,
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const tempDirs = [];
const children = [];

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

// ---------------------------------------------------------------------------
// a tone, played directly into the capture sink
// ---------------------------------------------------------------------------

function writeTone(filePath, { seconds = 20, freq = 440 } = {}) {
	const frames = seconds * RATE;
	const data = Buffer.alloc(frames * CHANNELS * 2);
	for (let i = 0; i < frames; i++) {
		const value = Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.5 * 32767);
		data.writeInt16LE(value, i * 4);
		data.writeInt16LE(value, i * 4 + 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(RATE, 24);
	header.writeUInt32LE(RATE * CHANNELS * 2, 28);
	header.writeUInt16LE(CHANNELS * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	fs.writeFileSync(filePath, Buffer.concat([header, data]));
	return filePath;
}

// ---------------------------------------------------------------------------
// CDP plumbing
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
}

// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end("<!DOCTYPE html><html><body><pre id=r>running</pre></body></html>");
});
await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));
children.push({ kill: () => server.close() });

const router = new LinuxAudioRouter({ log: (m) => console.log(dim(`  . ${m}`)) });
const detach = registerExitCleanup(router);

let tone = null;
let chrome = null;
let exitCode = 1;

try {
	const env = await router.probe();
	console.log(bold("\nAudio server"));
	console.log(`  ${env.serverName}`);

	const sink = await router.createCaptureSink(DEFAULT_CAPTURE_SINK);
	const monitorName = router.monitorSourceName(sink.name);
	console.log(bold(`\nCapture sink ready: ${monitorName}`));

	// A raw monitor is invisible to Chromium, so also expose it as a normal
	// source and see which (if either) the renderer can actually capture.
	const mic = await router.createVirtualMic(sink.name, VIRTUAL_MIC_NAME, VIRTUAL_MIC_LABEL);
	console.log(`  virtual mic: ${mic.name} (via module-remap-source)`);

	// Play the tone directly into the sink, bypassing the routing step -- this
	// test is only about whether Chromium can see and capture the monitor.
	const tonePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sr-mon-")), "tone.wav");
	tempDirs.push(path.dirname(tonePath));
	writeTone(tonePath);
	tone = spawn("pw-play", [`--target=${sink.name}`, tonePath], { stdio: "ignore" });
	await sleep(800);
	if (tone.exitCode !== null) throw new Error("pw-play exited immediately");

	// Launch Chrome auto-granting mic permission (but using real devices).
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-mon-chrome-"));
	tempDirs.push(userDataDir);
	const bin = CHROME_CANDIDATES.find((candidate) => {
		try {
			spawn(candidate, ["--version"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	});
	chrome = spawn(
		bin || CHROME_CANDIDATES[0],
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--use-fake-ui-for-media-stream", // auto-grant, still real devices
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
	await page.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
	await sleep(600);

	console.log(bold("\nAsking Chrome to enumerate and capture"));
	const result = await page.evaluate(`(async () => {
		const out = { devices: [], monitor: null, gotStream: false, level: 0, error: null, settings: null };

		// Labels stay hidden until the page has been granted access at least once.
		let priming = null;
		try {
			priming = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			out.primeError = String(err && err.message || err);
		}
		const all = await navigator.mediaDevices.enumerateDevices();
		out.devices = all.filter(d => d.kind === "audioinput")
			.map(d => ({ id: d.deviceId, label: d.label || "(unlabelled)" }));
		if (priming) priming.getTracks().forEach(t => t.stop());

		out.monitor = out.devices.find(d => /monitor/i.test(d.label)) || null;
		out.remapped = out.devices.find(d => d.label === ${JSON.stringify(VIRTUAL_MIC_LABEL)}) || null;
		if (!out.remapped) return out;

		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { deviceId: { exact: out.remapped.id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
			});
			out.gotStream = stream.getAudioTracks().length > 0;
			const track = stream.getAudioTracks()[0];
			out.settings = track.getSettings();

			const ctx = new AudioContext();
			await ctx.resume();
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 2048;
			ctx.createMediaStreamSource(stream).connect(analyser);
			const buf = new Float32Array(analyser.fftSize);
			const deadline = performance.now() + 1500;
			while (performance.now() < deadline) {
				analyser.getFloatTimeDomainData(buf);
				for (let i = 0; i < buf.length; i++) out.level = Math.max(out.level, Math.abs(buf[i]));
				await new Promise(r => setTimeout(r, 60));
			}
			stream.getTracks().forEach(t => t.stop());
			await ctx.close();
		} catch (err) {
			out.error = String(err && err.message || err);
		}
		return out;
	})()`);

	console.log(`  audio inputs Chrome can see: ${result.devices.length}`);
	for (const device of result.devices) {
		const remapped = device.label === VIRTUAL_MIC_LABEL;
		const monitor = /monitor/i.test(device.label);
		const mark = remapped ? green("-> virtual mic") : monitor ? green("-> raw monitor") : "";
		console.log(`    ${device.label} ${mark}`);
	}

	console.log(bold("\nResult"));
	console.log(`  raw monitor visible         ${result.monitor ? green("yes") : red("no (expected -- Chromium hides monitors)")}`);
	console.log(`  virtual mic visible         ${result.remapped ? green("yes") : red("no")}`);
	if (result.remapped) console.log(`  getUserMedia on it          ${result.gotStream ? green("yes") : red("no")}`);
	if (result.settings) console.log(`  track settings              ${JSON.stringify(result.settings)}`);
	if (result.error) console.log(`  error                       ${red(result.error)}`);
	if (result.primeError) console.log(dim(`  (permission priming note: ${result.primeError})`));
	console.log(`  captured level              ${result.level.toFixed(4)}  (peak amplitude, 0-1)`);

	const pass = result.remapped && result.gotStream && result.level > 0.05;
	if (pass) {
		console.log(green("\nPASS -- Chromium captures the remapped sink through getUserMedia."));
		console.log(dim("The renderer captures the virtual mic directly; no PCM plumbing needed on Linux."));
		exitCode = 0;
	} else if (result.remapped && result.gotStream) {
		console.log(red("\nFAIL -- the virtual mic is capturable but the audio was silent."));
	} else if (result.remapped) {
		console.log(red("\nFAIL -- the virtual mic is visible but getUserMedia refused it."));
	} else {
		console.log(red("\nFAIL -- neither the monitor nor the virtual mic is usable by Chromium."));
		console.log(dim("Fall back to capturing PCM in the main process, as planned for Windows."));
	}
} catch (err) {
	console.log(red(`\nFAIL -- ${err && err.message ? err.message : err}`));
} finally {
	if (tone) {
		try {
			tone.kill("SIGTERM");
		} catch {
			/* gone */
		}
	}
	try {
		await router.restore();
	} catch {
		/* best effort */
	}
	detach();
	cleanup();
}

process.exit(exitCode);
