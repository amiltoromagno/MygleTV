// MygleTV desktop shell -- composition root.
//
// The frontend is the same web app Firefox viewers load; this process only adds
// what a browser cannot do: per-application audio capture. It loads a Screen
// Room *origin* rather than bundling the frontend, because signaling.js derives
// its WebSocket URL from location.host -- so rooms work with no protocol
// changes.
//
//   npm start                              brings up a local server and uses it
//   SCREENROOM_URL=https://host/ npm start  uses a deployment instead
//   SCREENROOM_PORT=8090 npm start          local server on another port
//
// Nearly all the interesting wiring lives in shell.js, which is unit-tested
// with fake Electron modules. What is left here is dependency assembly.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";

import { LinuxAudioRouter, registerExitCleanup } from "./audio/linux.js";
import { createCaptureSession } from "./audio/session.js";
import { startAppServer } from "./app-server.js";
import { createShell } from "./shell.js";
import { createWindowsCaptureSession } from "./audio/windows.js";
import { createWindowsShell } from "./windows-shell.js";
import { startWindowsRelayProxy } from "./windows-relay-proxy.js";
import { resolveAppUrl, DEFAULT_APP_URL } from "./app-url.js";
import { configureWindowsData } from "./windows-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const windows = process.platform === "win32";
// Both shells resolve the same way: `--url=` wins (an empty one forces local
// mode), then SCREENROOM_URL, then the deployed relay. A desktop launcher has
// nowhere to put an environment variable, so the default lives in the app --
// otherwise a click-to-run install would silently start a local-only server.
const explicitUrl = resolveAppUrl();
const port = Number(process.env.SCREENROOM_PORT || 8080);

const audioLog = (message) => console.log("[audio]", message);

if (windows) {
	configureWindowsData(app);
} else {
	// The application name is what Electron reports as the window class, which is
	// how a desktop matches a window to its launcher entry and icon. Without it
	// the dock shows a generic placeholder instead.
	//
	// The profile directory is pinned to the old name first, so the rename does
	// not discard the cached display name and quality profile.
	app.setPath("userData", path.join(app.getPath("appData"), "screenroom-desktop"));
	app.setName("MygleTV");
}
const router = windows ? createWindowsCaptureSession() : new LinuxAudioRouter({ log: audioLog });
// Last line of defence: a hard exit must not leave audio routed to a sink that
// is about to vanish.
if (!windows) registerExitCleanup(router);
else process.on("exit", () => router.restoreSync());

const captureSession = windows ? router : createCaptureSession({ router, log: audioLog });

let appServer = null;

/**
 * Work out what to load. Without an explicit deployment the shell brings up the
 * bundled web server, so `npm start` works on its own -- it does not, and cannot,
 * load anything useful from an origin nobody is serving.
 */
async function resolveOrigin() {
	if (explicitUrl) {
		console.log(`[mygletv] using SCREENROOM_URL=${explicitUrl}`);
		if (windows) {
			appServer = await startWindowsRelayProxy({
				relayUrl: explicitUrl,
				publicDir: app.isPackaged ? path.join(process.resourcesPath, "screenroom", "public") : path.join(__dirname, "..", "screenroom", "public"),
			});
			return { url: appServer.url, startupError: null };
		}
		return { url: explicitUrl, startupError: null };
	}

	appServer = startAppServer({
		port,
		...(windows && app.isPackaged ? { serverDir: path.join(process.resourcesPath, "screenroom") } : {}),
		log: (message) => console.log(message),
	});
	console.log(`[mygletv] no SCREENROOM_URL set, so starting a LOCAL server on port ${port}`);
	console.log(
		"[mygletv] NOTE: a local server only reaches other clients on this machine. " +
			"To use your deployed relay, set SCREENROOM_URL.",
	);
	console.log(
		"[mygletv]       e.g. SCREENROOM_URL=https://your-worker.workers.dev/ npm start",
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
	if (windows) {
		await app.whenReady();
	}
	const { url, startupError } = await resolveOrigin();

	const shell = (windows ? createWindowsShell : createShell)({
		app,
		BrowserWindow,
		ipcMain,
		session,
		desktopCapturer,
		captureSession,
		router,
		url,
		preloadPath: path.join(__dirname, windows ? "windows-preload.cjs" : "preload.cjs"),
		iconPath: path.join(__dirname, "packaging", "mygletv-512.png"),
		defaultUrl: DEFAULT_APP_URL,
		startupError,
		...(windows ? { inviteUrl: explicitUrl || url } : {}),
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

// Take the child down with us, however we go.
app.on("will-quit", () => {
	if (appServer) appServer.stop();
});
process.on("exit", () => {
	if (appServer) appServer.stop();
});
