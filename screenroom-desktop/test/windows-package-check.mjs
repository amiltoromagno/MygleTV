// Smoke-check the built executable, not Electron's development launcher.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { WINDOWS_APP_URL } from "../windows-settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "dist/windows/win-unpacked/MygleTV.exe");
const cloudflare = process.argv.includes("--cloudflare");
const child = spawn(executable, ["--remote-debugging-port=9377", ...(cloudflare ? [] : ["--url="])], {
	env: { ...process.env, SCREENROOM_URL: "", SCREENROOM_PORT: "8520" }, windowsHide: true,
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
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
		pending.set(id, { resolve, reject, timer });
		socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
	if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
	return response.result.value;
}

try {
	await Promise.race([failure, (async () => {
		const deadline = Date.now() + 15000;
		let page;
		while (Date.now() < deadline) {
try { page = (await (await fetch("http://127.0.0.1:9377/json")).json()).find((p) => p.type === "page" && p.url.startsWith("http://127.0.0.1:")); if (page) break; } catch { /* launching */ }
			await sleep(100);
		}
		assert.ok(page, `Packaged frontend did not load. ${output}`);
		socket = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
		socket.on("message", (raw) => {
			const message = JSON.parse(raw); const waiter = pending.get(message.id); if (!waiter) return;
			pending.delete(message.id); clearTimeout(waiter.timer);
			if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
		});
		let loaded = false;
		for (let i = 0; i < 100; i++) {
			loaded = await evaluate("!!document.getElementById('nameInput') && !!window.screenroomNative");
			if (loaded) break; await sleep(100);
		}
		assert.ok(loaded, "Packaged frontend or Windows preload missing");
		console.log("PASS built executable serves its bundled frontend without system Node");
		assert.equal((await evaluate("screenroomNative.probe()")).ok, true);
		const result = await evaluate("screenroomNative.startCapture({mode:'system'})");
		assert.ok(result.ok, JSON.stringify(result));
		assert.equal(result.transport, "pcm");
		assert.equal((await evaluate("screenroomNative.stopCapture()")).ok, true);
		console.log("PASS native addon loads and captures from the packaged ASAR layout");
		assert.equal((await fetch(new URL("/pcm-worklet.js", page.url))).status, 200);
		assert.equal((await fetch(new URL("/windows-screen-picker.js", page.url))).status, 200);
		console.log("PASS Windows renderer modules are included in the package");
		assert.equal((await fetch(new URL("/stream-volume.js", page.url))).status, 200);
		assert.equal((await fetch(new URL("/windows-window.js", page.url))).status, 200);
		assert.equal(await evaluate("typeof screenroomNative.windowControl"), "function");
		assert.equal(await evaluate("!!document.querySelector('.windows-caption [data-window-action=close]')"), true);
		console.log("PASS borderless Windows caption and window control bridge are packaged");
		for (const module of ["quality-controls.js", "share-quality.js", "peers.js"]) assert.equal((await fetch(new URL(`/${module}`, page.url))).status, 200);
		assert.equal(await evaluate("typeof screenroomNative.getQuality"), "function");
		assert.equal(await evaluate("typeof screenroomNative.saveQuality"), "function");
		if (!cloudflare) {
			await evaluate("document.getElementById('nameInput').value='Package check'; document.getElementById('gateForm').requestSubmit(); true");
			let ready = false;
			for (let i = 0; i < 100; i++) {
				ready = await evaluate("!!document.getElementById('qualityBtn')");
				if (ready) break; await sleep(100);
			}
			assert.ok(ready, "Packaged quality UI did not initialize");
			await evaluate("document.getElementById('qualityBtn').click(); true");
			assert.equal(await evaluate("document.getElementById('qualityDialog').open"), true);
		}
		console.log("PASS quality controls and Windows preference bridge are packaged");
		assert.equal(await evaluate("typeof screenroomNative.setRelayUrl"), "undefined");
		if (cloudflare) {
			assert.equal(await evaluate("screenroomNative.getInviteUrl()"), WINDOWS_APP_URL);
			console.log("PASS installed app uses our Cloudflare address automatically");
			const room = `windows-package-check-${process.pid}-${Date.now()}`;
			const url = new URL(`/ws?room=${room}`, page.url); url.protocol = "ws:";
			const signaling = new WebSocket(url, { origin: new URL(page.url).origin });
			try {
				const welcome = await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("Cloudflare signaling timed out")), 15000);
					signaling.once("open", () => signaling.send(JSON.stringify({ t: "join", room, name: "Package check" })));
					signaling.on("message", (raw) => { const message = JSON.parse(raw); if (message.t === "welcome") { clearTimeout(timer); resolve(message); } });
					signaling.once("error", (err) => { clearTimeout(timer); reject(err); });
				});
				assert.deepEqual(welcome.peers, []);
				console.log("PASS packaged signaling reaches Cloudflare in an isolated test room");
			} finally { signaling.terminate(); }
		}
		// Chromium closes this connection before replying to Browser.close.
		await evaluate("setTimeout(() => window.close(), 100); true");
		for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
		assert.notEqual(child.exitCode, null, "Packaged app did not exit cleanly");
	})()]);
} finally {
	socket?.close();
	if (child.exitCode === null) child.kill();
}
