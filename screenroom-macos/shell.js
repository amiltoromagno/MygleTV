// Everything Electron-specific, behind an injectable seam.

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
		padding: 2px 6px; font-family: Menlo, Monaco, Consolas, monospace; font-size: 13px;
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
	iconPath = null,
	defaultUrl = null,
	startupError = null,
	log = () => {},
}) {
	let mainWindow = null;
	let showingError = false;

	let relayHost = url;
	try {
		relayHost = new URL(url).host;
	} catch {
		/* leave the raw string if it is not a URL */
	}

	const relayIsDefault = defaultUrl !== null && url === defaultUrl;

	function registerAudioIpc() {
		ipcMain.handle("audio:list", async () => {
			try {
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
				if (captureSession.isActive()) await captureSession.stop();
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

	async function fallbackSource() {
		const sources = await desktopCapturer.getSources({
			types: ["screen", "window"],
			thumbnailSize: { width: 0, height: 0 },
		});
		return sources || [];
	}

	function registerDisplayMedia() {
		session.defaultSession.setDisplayMediaRequestHandler(
			async (_request, callback) => {
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
			...(iconPath ? { icon: iconPath } : {}),
			webPreferences: {
				preload: preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		mainWindow.on("closed", () => {
			mainWindow = null;
		});

		mainWindow.on("page-title-updated", (event, title) => {
			event.preventDefault();
			mainWindow.setTitle(relayIsDefault ? title : `${title}  —  ${relayHost}`);
		});

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

