// Smoke-check the built macOS .app bundle executable, not Electron's development launcher.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { MACOS_APP_URL } from "../macos-settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findBuiltAppExecutable() {
	const candidates = [
		path.join(root, "dist/macos/mac-arm64/MygleTV.app/Contents/MacOS/MygleTV"),
		path.join(root, "dist/macos/mac/MygleTV.app/Contents/MacOS/MygleTV"),
		path.join(root, "dist/macos/mac-x64/MygleTV.app/Contents/MacOS/MygleTV"),
		path.join(root, "dist/macos/mac-universal/MygleTV.app/Contents/MacOS/MygleTV"),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	throw new Error("Could not find built MygleTV.app in dist/macos/. Run npm run pack:macos first.");
}

const executable = findBuiltAppExecutable();
const cloudflare = process.argv.includes("--cloudflare");
const env = { ...process.env, SCREENROOM_URL: "", SCREENROOM_PORT: "8521" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ["--remote-debugging-port=9378", ...(cloudflare ? [] : ["--url="])], {
	env,
});
let output = "";
let socket;
let sequence = 0;
const pending = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });
const failure = new Promise((_resolve, reject) => child.once("error", reject));

async function send(method, params = {}) {
	const id = ++sequence;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`CDP timed out: ${method}`));
		}, 10000);
		pending.set(id, { resolve, reject, timer });
		socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const response = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
		userGesture: true,
	});
	if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
	return response.result.value;
}

try {
	await Promise.race([
		failure,
		(async () => {
			const deadline = Date.now() + 15000;
			let page;
			while (Date.now() < deadline) {
				try {
					page = (await (await fetch("http://127.0.0.1:9378/json")).json()).find(
						(p) => p.type === "page" && p.url.startsWith("http://127.0.0.1:"),
					);
					if (page) break;
				} catch {
					/* launching */
				}
				await sleep(100);
			}
			assert.ok(page, `Packaged frontend did not load. ${output}`);
			socket = new WebSocket(page.webSocketDebuggerUrl);
			await new Promise((resolve, reject) => {
				socket.once("open", resolve);
				socket.once("error", reject);
			});
			socket.on("message", (raw) => {
				const message = JSON.parse(raw);
				const waiter = pending.get(message.id);
				if (!waiter) return;
				pending.delete(message.id);
				clearTimeout(waiter.timer);
				if (message.error) waiter.reject(new Error(message.error.message));
				else waiter.resolve(message.result);
			});
			let loaded = false;
			for (let i = 0; i < 100; i++) {
				loaded = await evaluate("!!document.getElementById('nameInput') && !!window.screenroomNative");
				if (loaded) break;
				await sleep(100);
			}
			assert.ok(loaded, "Packaged frontend or macOS preload missing");
			console.log("PASS built MygleTV.app serves its bundled frontend without system Node");
			const probe = await evaluate("screenroomNative.probe()");
			assert.equal(probe.ok, true);
			assert.equal(probe.environment.backend, "ScreenCaptureKit");
			console.log("PASS ScreenCaptureKit probe succeeds in packaged app");
			assert.equal((await fetch(new URL("/pcm-worklet.js", page.url))).status, 200);
			assert.equal((await fetch(new URL("/windows-screen-picker.js", page.url))).status, 200);
			for (const module of ["quality-controls.js", "share-quality.js", "share-setup.js", "peers.js", "stream-pip.js", "pip.html", "pip.js", "pip.css"]) {
				assert.equal((await fetch(new URL(`/${module}`, page.url))).status, 200);
			}
			assert.equal(await evaluate("typeof screenroomNative.getQuality"), "function");
			assert.equal(await evaluate("typeof screenroomNative.saveQuality"), "function");
			assert.equal(await evaluate("screenroomNative.multiPip"), true);
			if (!cloudflare) {
				await evaluate("document.getElementById('nameInput').value='Package check'; document.getElementById('gateForm').requestSubmit(); true");
				let ready = false;
				for (let i = 0; i < 100; i++) {
					ready = await evaluate("document.getElementById('statusText').textContent==='Connected' && !document.getElementById('shareBtn').disabled");
					if (ready) break;
					await sleep(100);
				}
				assert.ok(ready, "Packaged room did not initialize");
				const screens = await evaluate("screenroomNative.listScreens()");
				console.log("listScreens result:", JSON.stringify({ ok: screens.ok, count: screens.sources?.length, error: screens.error }));
			}
			console.log("PASS renderer modules, quality store bridge and multi-PiP are packaged");
			if (cloudflare) {
				assert.equal(await evaluate("screenroomNative.getInviteUrl()"), MACOS_APP_URL);
				console.log("PASS installed macOS app uses our Cloudflare address automatically");
			}
			await evaluate("setTimeout(() => window.close(), 100); true");
			for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
			assert.notEqual(child.exitCode, null, "Packaged app did not exit cleanly");
		})(),
	]);
} finally {
	socket?.close();
	if (child.exitCode === null) child.kill();
}

