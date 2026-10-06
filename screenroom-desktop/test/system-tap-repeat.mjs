#!/usr/bin/env node
//
// Reproduces the system-tap repeat failure.
//
//   npm run check:taploop
//
// The symptom: "All system audio" works once, then reports
//   the "ScreenRoom System" audio source did not appear
// on every later attempt.
//
// So the question is narrow: after creating the tap, tearing it down and
// creating it again, does the source come back -- and does Chromium notice?
// Those are two different failures with two different fixes, and only a real
// sound server plus a real browser can tell them apart.
//
// The system tap is non-destructive (nothing is moved), so this is safe to run
// while the machine is in use.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { LinuxAudioRouter, registerExitCleanup } from "../audio/linux.js";
import { SYSTEM_TAP_LABEL, SYSTEM_TAP_NAME } from "../audio/session.js";

const HTTP_PORT = 8511;
const CDP_PORT = 9411;
const CYCLES = 2;

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

const results = [];
function check(condition, label) {
	console.log(`  ${condition ? green("ok  ") : red("FAIL")} ${label}`);
	results.push(condition);
}

try {
	const router = new LinuxAudioRouter({ log: (m) => console.log(dim(`  . ${m}`)) });
	const detach = registerExitCleanup(router);

	const env = await router.probe();
	console.log(bold(`\nSystem tap repeat test`));
	console.log(`  server: ${env.serverName}`);
	console.log(`  default sink: ${env.defaultSink}\n`);

	// A browser to ask whether it can see the source.
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end("<!DOCTYPE html><html><body>probe</body></html>");
	});
	await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));
	children.push({ kill: () => server.close() });

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-taploop-"));
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
	await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
	await sleep(700);

	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
		return result.result?.value;
	};

	// Grant device access once so labels are visible.
	await evaluate(
		"navigator.mediaDevices.getUserMedia({audio:true}).then(s => { s.getTracks().forEach(t => t.stop()); return true; }).catch(e => String(e.message))",
	);

	const browserSees = async () => {
		const labels = await evaluate(
			"navigator.mediaDevices.enumerateDevices().then(ds => ds.filter(d => d.kind === 'audioinput').map(d => d.label))",
		);
		return { labels, found: labels.includes(SYSTEM_TAP_LABEL) };
	};

	const pactlHasSource = async (name) => {
		const res = await router.pactl(["list", "sources", "short"]);
		return res.stdout.split("\n").some((line) => line.split("\t")[1] === name);
	};

	for (let cycle = 1; cycle <= CYCLES; cycle++) {
		console.log(bold(`\n── cycle ${cycle} ──`));

		let created = false;
		let createError = null;
		try {
			await router.createSystemTap(SYSTEM_TAP_NAME, SYSTEM_TAP_LABEL);
			created = true;
		} catch (err) {
			createError = err.message;
		}

		check(created, `createSystemTap succeeded${createError ? ` (${createError})` : ""}`);

		// Does the node exist in PipeWire at all?
		const inPactl = await pactlHasSource(SYSTEM_TAP_NAME);
		check(inPactl, `pactl lists a source named "${SYSTEM_TAP_NAME}"`);

		// And can Chromium see it?
		let seen = { labels: [], found: false };
		for (let attempt = 0; attempt < 12; attempt++) {
			seen = await browserSees();
			if (seen.found) break;
			await sleep(250);
		}
		check(
			seen.found,
			`Chromium lists "${SYSTEM_TAP_LABEL}"${seen.found ? "" : ` (saw: ${JSON.stringify(seen.labels)})`}`,
		);

		// Tear down, exactly as stopping a share does.
		await router.restore();
		await sleep(600);

		const goneFromPactl = !(await pactlHasSource(SYSTEM_TAP_NAME));
		check(goneFromPactl, "the source is gone from pactl after restore");

		let goneFromBrowser = false;
		for (let attempt = 0; attempt < 12; attempt++) {
			const after = await browserSees();
			if (!after.found) {
				goneFromBrowser = true;
				break;
			}
			await sleep(250);
		}
		check(goneFromBrowser, "and gone from Chromium's device list");
	}

	detach();
} catch (err) {
	check(false, `unexpected failure: ${err.message}`);
} finally {
	cleanup();
}

const failed = results.filter((r) => !r).length;
if (failed === 0) {
	console.log(green("\nPASS -- the tap survives repeated create/destroy"));
	process.exit(0);
}
console.log(red(`\nFAIL -- ${failed} of ${results.length} checks failed`));
console.log(dim("The failing line above says which side loses the source."));
process.exit(1);
