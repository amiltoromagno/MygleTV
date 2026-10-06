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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readUrlArg() {
	const fromFlag = process.argv.find((arg) => arg.startsWith("--url="));
	if (fromFlag) return fromFlag.slice("--url=".length);
	return process.env.SCREENROOM_URL || "";
}

const explicitUrl = readUrlArg();
const port = Number(process.env.SCREENROOM_PORT || 8080);

const audioLog = (message) => console.log("[audio]", message);

const router = new LinuxAudioRouter({ log: audioLog });
// Last line of defence: a hard exit must not leave audio routed to a sink that
// is about to vanish.
registerExitCleanup(router);

const captureSession = createCaptureSession({ router, log: audioLog });

let appServer = null;

/**
 * Work out what to load. Without an explicit deployment the shell brings up the
 * bundled web server, so `npm start` works on its own -- it does not, and cannot,
 * load anything useful from an origin nobody is serving.
 */
async function resolveOrigin() {
	if (explicitUrl) {
		console.log(`[mygletv] using SCREENROOM_URL=${explicitUrl}`);
		return { url: explicitUrl, startupError: null };
	}

	appServer = startAppServer({ port, log: (message) => console.log(message) });
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
	const { url, startupError } = await resolveOrigin();

	const shell = createShell({
		app,
		BrowserWindow,
		ipcMain,
		session,
		desktopCapturer,
		captureSession,
		router,
		url,
		preloadPath: path.join(__dirname, "preload.cjs"),
		startupError,
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
