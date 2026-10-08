import { createShell } from "./shell.js";
import { createQualityStore } from "./windows-settings.js";
import { resolveWindowAudio } from "./audio/windows.js";
import { DEFAULT_APP_URL } from "./app-url.js";

/** Windows-only wiring; the Linux shell and preload are unchanged. */
export function createWindowsShell(options) {
	const { ipcMain, session, desktopCapturer, captureSession, url } = options;
	// Windows uses an HTML caption so it can disappear without resizing the window.
	class WindowsWindow extends options.BrowserWindow {
		constructor(settings) { super({ ...settings, frame: false, thickFrame: false, roundedCorners: false }); }
	}
	const shell = createShell({ ...options, BrowserWindow: WindowsWindow });
	let selected = null;
	let offered = new Set();
	let sequence = 0;
	let pending = new Set();
	let pendingCapture = null;
	let operations = Promise.resolve();
	const origin = new URL(url).origin;
	const trusted = (event) => {
		try { return event.sender === shell.window?.webContents && event.senderFrame === event.sender.mainFrame && new URL(event.senderFrame.url).origin === origin; }
		catch { return false; }
	};
	const serial = (fn) => {
		const result = operations.then(fn);
		operations = result.catch(() => {});
		return result;
	};

	async function start() {
		await shell.start();
		const qualityStore = createQualityStore(options.app.getPath("userData"));
		ipcMain.handle("window:control", (event, action) => {
			if (!trusted(event)) throw new Error("Untrusted window request.");
			const win = shell.window;
			if (action === "minimize") win.minimize();
			else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
			else if (action === "close") win.close();
			else throw new Error("Unknown window action.");
		});
		ipcMain.handle("quality:read", (event) => trusted(event) ? qualityStore.read() : null);
		ipcMain.handle("quality:write", (event, value) => {
			if (!trusted(event)) throw new Error("Untrusted settings request.");
			qualityStore.write(value);
		});
		ipcMain.handle("app:invite", (event) => trusted(event) ? options.inviteUrl || url : null);
		// Name the relay only when it is not the usual one, matching the Linux
		// shell: an unexpected address is worth flagging, the normal one is noise.
		if (options.inviteUrl && options.inviteUrl !== DEFAULT_APP_URL) {
			shell.window.on("page-title-updated", (_event, title) =>
				shell.window.setTitle(`${title}  —  ${new URL(options.inviteUrl).host}`),
			);
		}
		// Replace only this Windows instance's handlers, keeping the existing
		// response contract while validating senders and serializing lifecycle.
		for (const channel of ["audio:list", "audio:probe", "audio:start", "audio:stop", "audio:state"]) ipcMain.removeHandler(channel);
		for (const [channel, operation] of Object.entries({
			"audio:list": async () => ({ apps: await captureSession.listApplications() }),
			"audio:probe": async () => ({ environment: await captureSession.probe() }),
			"audio:start": (target) => captureSession.start(target),
			"audio:stop": async () => { pending.clear(); pendingCapture = null; await captureSession.stop(); return {}; },
			"audio:state": () => ({ activeApp: captureSession.activeApp, activeMode: captureSession.activeMode }),
		})) {
			ipcMain.handle(channel, (event, target) => {
				if (!trusted(event)) return { ok: false, error: "Untrusted capture request." };
				return serial(async () => {
					try { return { ok: true, ...await operation(target) }; }
					catch (err) { return { ok: false, error: err.message }; }
				});
			});
		}
		captureSession.setPcmHandler(({ captureId, pcm }) => {
			if (!shell.window || shell.window.webContents.isDestroyed()) return;
			if (pendingCapture !== captureId) { pending.clear(); pendingCapture = captureId; }
			// Bound unacknowledged deliveries so a stalled renderer cannot grow
			// the IPC queue indefinitely. Stale sessions are also discarded.
			if (pending.size >= 8 || pcm.length > 48000 * 4) return;
			const next = ++sequence;
			pending.add(next);
			try { shell.window.webContents.send("audio:pcm", { captureId, sequence: next, pcm }); }
			catch { pending.delete(next); /* renderer disappeared between check and send */ }
		});
		ipcMain.on("audio:ack", (event, captureId, seq) => {
			if (trusted(event) && captureId === pendingCapture) pending.delete(seq);
		});
		ipcMain.handle("display:list", async (event) => {
			if (!trusted(event)) return { ok: false, error: "Untrusted display request." };
			try {
				selected = null;
				const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
				let audioOwners = new Map();
				try { audioOwners = await (options.resolveWindowAudio || resolveWindowAudio)(sources); }
				catch (err) { options.log?.(`[audio] window owner lookup failed: ${err.message}`); }
				offered = new Set(sources.map((source) => source.id));
				return { ok: true, sources: sources.map(({ id, name, thumbnail }) => ({ id, name, thumbnail: thumbnail.toDataURL(), audioApp: audioOwners.get(id) || null })) };
			} catch (err) { return { ok: false, error: err.message }; }
		});
		ipcMain.handle("display:select", (event, id) => {
			if (!trusted(event) || (id !== null && !offered.has(id))) return { ok: false, error: "That display is no longer available." };
			selected = id;
			offered.clear();
			return { ok: true };
		});
		session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
			const id = selected;
			selected = null;
			try {
				if (!id || request.frame !== shell.window?.webContents.mainFrame || new URL(request.securityOrigin).origin !== origin) return callback({});
				const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
				const source = sources.find((s) => s.id === id);
				callback(source ? { video: source } : {});
			} catch { callback({}); }
		}, { useSystemPicker: false });
		const contents = shell.window.webContents;
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		contents.on("will-navigate", (event, nextUrl) => {
			if (new URL(nextUrl).origin !== origin) event.preventDefault();
		});
		const reset = () => {
			selected = null; offered.clear(); pending.clear(); pendingCapture = null;
			void serial(() => captureSession.stop()).catch((err) => options.log?.(`[audio] cleanup failed: ${err.message}`));
		};
		contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) reset(); });
		contents.on("render-process-gone", reset);
		shell.window.on("closed", reset);
	}
	return { start, get window() { return shell.window; } };
}
