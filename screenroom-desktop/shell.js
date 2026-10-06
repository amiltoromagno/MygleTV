// Everything Electron-specific, behind an injectable seam.
//
// This exists because Electron cannot run in the build sandbox: there is no
// /dev/dri and no display socket, so Chromium's graphics stack never
// initialises and the process dies with SIGTRAP before app.whenReady()
// resolves. Rather than ship wiring that has never been exercised, the wiring
// lives here and is driven with fake Electron modules in test/shell.test.mjs.
//
// main.js is then a composition root with almost nothing in it to get wrong.

/**
 * The page shown when the MygleTV origin cannot be reached.
 *
 * A blank window is the worst possible failure mode: the user cannot tell a
 * missing server from a broken app. Exported so the wording can be tested.
 */
export function errorPageHtml({ title, message, hint, url }) {
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
	:root { color-scheme: dark; }
	body {
		margin: 0; height: 100vh; display: grid; place-items: center;
		background: #0d1017; color: #e7ecf3;
		font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	}
	.card {
		max-width: 34rem; padding: 28px 30px; background: #151a22;
		border: 1px solid #262d3a; border-radius: 12px;
	}
	h1 { margin: 0 0 12px; font-size: 18px; color: #ffb454; }
	p { margin: 0 0 12px; }
	code {
		background: #1b212b; border: 1px solid #262d3a; border-radius: 6px;
		padding: 2px 6px; font-family: Consolas, monospace; font-size: 13px;
	}
	.hint { color: #8b96a8; font-size: 14px; margin-bottom: 0; }
	.url { color: #4da3ff; word-break: break-all; }
</style></head>
<body><div class="card">
	<h1>${title}</h1>
	<p>${message}</p>
	<p class="url">${url}</p>
	<p class="hint">${hint}</p>
</div></body></html>`;
}

/**
 * @param {object} deps
 * @param {object} deps.app              Electron app
 * @param {Function} deps.BrowserWindow  Electron BrowserWindow
 * @param {object} deps.ipcMain          Electron ipcMain
 * @param {object} deps.session          Electron session
 * @param {object} deps.desktopCapturer  Electron desktopCapturer
 * @param {object} deps.captureSession   from audio/session.js
 * @param {object} deps.router           from audio/linux.js
 * @param {string} deps.url              MygleTV origin to load
 * @param {string} deps.preloadPath      absolute path to preload.cjs
 * @param {object} [deps.startupError]   shown instead of the app when set
 * @param {Function} [deps.log]
 */
export function createShell({
	app,
	BrowserWindow,
	ipcMain,
	session,
	desktopCapturer,
	captureSession,
	router,
	url,
	preloadPath,
	startupError = null,
	log = () => {},
}) {
	let mainWindow = null;
	let showingError = false;

	/** The relay this window talks to, for the title bar. */
	let relayHost = url;
	try {
		relayHost = new URL(url).host;
	} catch {
		/* leave the raw string if it is not a URL */
	}

	// -----------------------------------------------------------------------
	// Audio IPC. Every handler answers with { ok }, never a thrown rejection,
	// so the renderer can surface a message instead of an unhandled error.
	// -----------------------------------------------------------------------

	function registerAudioIpc() {
		ipcMain.handle("audio:list", async () => {
			try {
				// Grouped by application: one application may own several streams, and
				// the renderer should offer the application, not each stream.
				return { ok: true, apps: await captureSession.listApplications() };
			} catch (err) {
				return { ok: false, error: err.message };
			}
		});

		ipcMain.handle("audio:probe", async () => {
			try {
				if (!router.environment) await router.probe();
				return { ok: true, environment: router.environment };
			} catch (err) {
				return { ok: false, error: err.message };
			}
		});

		ipcMain.handle("audio:start", async (_event, target) => {
			try {
				// Replacing a capture without stopping the first would leak modules
				// and leave the previous application routed to a dead sink.
				if (captureSession.isActive()) await captureSession.stop();
				// `target` is { mode: "app", app } or { mode: "system" }.
				return { ok: true, ...(await captureSession.start(target)) };
			} catch (err) {
				return { ok: false, error: err.message };
			}
		});

		ipcMain.handle("audio:stop", async () => {
			try {
				await captureSession.stop();
				return { ok: true };
			} catch (err) {
				return { ok: false, error: err.message };
			}
		});

		ipcMain.handle("audio:state", () => ({
			activeApp: captureSession.activeApp,
			activeMode: captureSession.activeMode || null,
		}));
	}

	// -----------------------------------------------------------------------
	// Screen capture
	// -----------------------------------------------------------------------

	/**
	 * The system picker is preferred because on Wayland it is the only way to get
	 * a real choice: `desktopCapturer.getSources()` returns a single placeholder
	 * source there, because the compositor will not let an app enumerate other
	 * windows.
	 *
	 * This handler therefore only runs when no system picker was offered. It is
	 * logged loudly either way, because "the picker did not appear" and "the
	 * picker appeared and you missed it" are otherwise indistinguishable.
	 */
	async function fallbackSource() {
		const sources = await desktopCapturer.getSources({
			types: ["screen", "window"],
			thumbnailSize: { width: 0, height: 0 },
		});
		return sources || [];
	}

	function registerDisplayMedia() {
		session.defaultSession.setDisplayMediaRequestHandler(
			async (request, callback) => {
				try {
					const sources = await fallbackSource();
					log(
						`[capture] system picker did not run; handler invoked with ${sources.length} source(s)`,
					);

					if (sources.length === 0) {
						log("[capture] nothing available to capture; declining");
						callback({});
						return;
					}

					// Only unambiguous when there is a single source. With several,
					// this is a guess, so it is worth saying so in the log.
					if (sources.length > 1) {
						log(
							`[capture] WARNING: choosing "${sources[0].name}" without asking (${sources.length} available)`,
						);
					}
					log(`[capture] granting "${sources[0].name}"`);
					callback({ video: sources[0] });
				} catch (err) {
					log(`[capture] source selection failed: ${err.message}`);
					callback({});
				}
			},
			{ useSystemPicker: true },
		);
	}

	// -----------------------------------------------------------------------
	// Window and lifecycle
	// -----------------------------------------------------------------------

	function showErrorPage({ title, message, hint }) {
		if (!mainWindow) return;
		const html = errorPageHtml({ title, message, hint, url });
		mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
	}

	function createWindow() {
		mainWindow = new BrowserWindow({
			width: 1280,
			height: 820,
			backgroundColor: "#0d1017",
			autoHideMenuBar: true,
			title: "MygleTV",
			webPreferences: {
				preload: preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		mainWindow.on("closed", () => {
			mainWindow = null;
		});

		// Show which relay this window is on. Two MygleTV servers can both
		// hold a room called "main" -- one local, one remote -- and identical
		// room names on different relays look exactly like a broken app. Without
		// this in the title there is nothing on screen to tell them apart.
		mainWindow.on("page-title-updated", (event, title) => {
			event.preventDefault();
			mainWindow.setTitle(`${title}  —  ${relayHost}`);
		});

		// Without this, an unreachable origin leaves a blank window and no clue.
		mainWindow.webContents.on(
			"did-fail-load",
			(_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
				if (!isMainFrame || showingError) return;
				showingError = true;
				log(`[shell] failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
				showErrorPage({
					title: "Could not reach MygleTV",
					message: `Nothing answered at the address below, so there is nothing to show.`,
					hint:
						"Either start the web server yourself (run <code>npm start</code> in the " +
						"<code>screenroom</code> folder), or point the shell at your deployment: " +
						"<code>SCREENROOM_URL=https://your-host/ npm start</code>",
				});
			},
		);

		if (startupError) {
			showingError = true;
			showErrorPage(startupError);
			return mainWindow;
		}

		mainWindow.loadURL(url);
		return mainWindow;
	}

	async function start() {
		await app.whenReady();

		registerAudioIpc();
		registerDisplayMedia();
		createWindow();

		app.on("activate", () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow();
		});

		app.on("window-all-closed", () => {
			app.quit();
		});

		// Audio must go back to the real output even if the renderer never asked.
		app.on("before-quit", () => {
			router.restoreSync();
		});
	}

	return {
		start,
		createWindow,
		registerAudioIpc,
		registerDisplayMedia,
		get window() {
			return mainWindow;
		},
	};
}
