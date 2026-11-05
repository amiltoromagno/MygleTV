// Real Electron + ScreenCaptureKit + IPC + AudioWorklet + WebRTC check on macOS.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import { createMacosCaptureSession, listWindowProcesses } from "../audio/macos.js";
import { createMacosShell } from "../macos-shell.js";
import { startAppServer } from "../app-server.js";
import { startMacosRelayProxy } from "../macos-relay-proxy.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mygletv-macos-check-")));

let server;
let proxy;
let capture;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (value, message) => {
	assert.ok(value, message);
	console.log(`PASS ${message}`);
};

async function evaluate(win, expression) {
	let timer;
	try {
		return await Promise.race([
			win.webContents.executeJavaScript(expression, true),
			new Promise((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Renderer evaluation timed out: " + expression.slice(0, 120))),
					15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function waitFor(win, expression, label, timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			const result = await evaluate(win, expression);
			if (result) return result;
		} catch {
			/* page loading */
		}
		await sleep(100);
	}
	throw new Error(`Timed out: ${label}`);
}

async function runCheck() {
	let code = 1;
	try {
		assert.equal(process.platform, "darwin", "This check requires macOS.");
		await app.whenReady();

		const apps = await listWindowProcesses();
		check(apps.every((entry) => /^\d+$/.test(entry.id)), "real macOS process discovery returns PID identities");

		capture = createMacosCaptureSession();
		server = startAppServer({ port: 8498 });
		assert.equal(await server.ready(), true);
		proxy = await startMacosRelayProxy({
			relayUrl: `${server.url}?room=macos-check`,
			publicDir: path.resolve(root, "../screenroom/public"),
		});

		class HiddenWindow extends BrowserWindow {
			constructor(options) {
				super({ ...options, show: false });
			}
		}

		const shell = createMacosShell({
			app,
			BrowserWindow: HiddenWindow,
			desktopCapturer,
			ipcMain,
			session,
			captureSession: capture,
			router: capture,
			url: proxy.url,
			inviteUrl: proxy.inviteUrl,
			preloadPath: path.join(root, "macos-preload.cjs"),
			log: console.log,
		});
		await shell.start();
		const host = shell.window;

		await waitFor(host, "!!document.getElementById('nameInput') && !!window.screenroomNative", "frontend and preload load");
		check(true, "Electron loads shared frontend and macOS preload via relay proxy");

		const probe = await evaluate(host, "window.screenroomNative.probe()");
		check(probe.ok && probe.environment.backend === "ScreenCaptureKit", "IPC audio:probe reports ScreenCaptureKit");

		const listed = await evaluate(host, "window.screenroomNative.listApps()");
		check(listed.ok && Array.isArray(listed.apps), "IPC audio:list returns running macOS applications");

		await evaluate(host, "window.screenroomNative.saveQuality({ bitrate: 10, fps: 60, resolution: '1080p' })");
		const savedQuality = await evaluate(host, "window.screenroomNative.getQuality()");
		check(
			savedQuality.bitrate === 10 && savedQuality.fps === 60 && savedQuality.resolution === "1080p",
			"quality store persists stream profile across IPC",
		);

		code = 0;
	} finally {
		await capture?.stop();
		proxy?.stop();
		server?.stop();
		app.exit(code);
	}
}

runCheck().catch((err) => {
	console.error(err);
	app.exit(1);
});

