// MygleTV macOS desktop shell -- composition root.
//
// Uses the shared frontend in ../screenroom/public without modifying any existing
// files, adding per-application and system audio capture on macOS via ScreenCaptureKit.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";

import { createMacosCaptureSession } from "./audio/macos.js";
import { startAppServer } from "./app-server.js";
import { createMacosShell } from "./macos-shell.js";
import { startMacosRelayProxy } from "./macos-relay-proxy.js";
import { resolveAppUrl, DEFAULT_APP_URL } from "./app-url.js";
import { configureMacosData } from "./macos-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const explicitUrl = resolveAppUrl();
const port = Number(process.env.SCREENROOM_PORT || 8080);

configureMacosData(app);

const captureSession = createMacosCaptureSession();
process.on("exit", () => captureSession.restoreSync());

let appServer = null;

async function resolveOrigin() {
	if (explicitUrl) {
		console.log(`[mygletv] using SCREENROOM_URL=${explicitUrl}`);
		appServer = await startMacosRelayProxy({
			relayUrl: explicitUrl,
			publicDir: app.isPackaged
				? path.join(process.resourcesPath, "screenroom", "public")
				: path.join(__dirname, "..", "screenroom", "public"),
		});
		return { url: appServer.url, startupError: null };
	}

	appServer = startAppServer({
		port,
		...(app.isPackaged ? { serverDir: path.join(process.resourcesPath, "screenroom") } : {}),
		log: (message) => console.log(message),
	});
	console.log(`[mygletv] no SCREENROOM_URL set, so starting a LOCAL server on port ${port}`);
	console.log(
		"[mygletv] NOTE: a local server only reaches other clients on this machine. " +
			"To use your deployed relay, set SCREENROOM_URL.",
	);

	const healthy = await appServer.ready();
	if (healthy) {
		console.log(`[mygletv] server ready at ${appServer.url}`);
		return { url: appServer.url, startupError: null };
	}

	const info = appServer.exitInfo;
	const detail = info
		? info.error
			? info.error
			: `it exited with code ${info.code}`
		: "it did not respond in time";
	console.error(`[mygletv] the web server did not start: ${detail}`);

	return {
		url: appServer.url,
		startupError: {
			title: "The MygleTV server did not start",
			message: `The bundled web server could not come up on port ${port} (${detail}).`,
			hint:
				"Another program may already be using that port &mdash; try " +
				`<code>SCREENROOM_PORT=8090 npm start</code>. If the port is free, run ` +
				"<code>npm install</code> inside the <code>screenroom</code> folder, or point " +
				"the shell at a deployment with <code>SCREENROOM_URL=...</code>",
		},
	};
}

async function boot() {
	await app.whenReady();
	const { url, startupError } = await resolveOrigin();

	const shell = createMacosShell({
		app,
		BrowserWindow,
		ipcMain,
		session,
		desktopCapturer,
		captureSession,
		router: captureSession,
		url,
		preloadPath: path.join(__dirname, "macos-preload.cjs"),
		iconPath: path.join(__dirname, "packaging", "mygletv-512.png"),
		defaultUrl: DEFAULT_APP_URL,
		startupError,
		inviteUrl: explicitUrl || url,
		log: (message) => console.log(message),
	});

	await shell.start();
	console.log(`[mygletv] this window is on ${url}`);
	console.log(
		"[mygletv] two rooms with the same name on different relays cannot see each other.",
	);
}

boot().catch((err) => {
	console.error("[mygletv] failed to start:", err);
	app.exit(1);
});

app.on("will-quit", () => {
	if (appServer) appServer.stop();
});
process.on("exit", () => {
	if (appServer) appServer.stop();
});

