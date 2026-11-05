import { test } from "node:test";
import assert from "node:assert/strict";

import { createShell, errorPageHtml } from "../shell.js";

const PRELOAD = "/app/macos-preload.cjs";
const URL = "http://127.0.0.1:8080/";

function makeFakes({ sources = [{ id: "screen:0", name: "Built-in Retina Display" }], getSourcesError = null } = {}) {
	const state = {
		ipcHandlers: new Map(),
		appHandlers: new Map(),
		displayHandler: null,
		displayOptions: null,
		sourcesOptions: null,
		restoreSyncCalls: 0,
		quitCalls: 0,
		windows: [],
		windowTitles: [],
		logs: [],
	};

	function BrowserWindow(options) {
		const win = {
			options,
			loadedUrl: null,
			handlers: new Map(),
			webContents: {
				handlers: new Map(),
				on(event, fn) {
					this.handlers.set(event, fn);
				},
			},
			on(event, fn) {
				win.handlers.set(event, fn);
			},
			loadURL(url) {
				win.loadedUrl = url;
			},
			setTitle(title) {
				state.windowTitles.push(title);
			},
		};
		state.windows.push(win);
		return win;
	}
	BrowserWindow.getAllWindows = () => state.windows;

	const app = {
		whenReady: async () => {},
		on(event, fn) {
			state.appHandlers.set(event, fn);
		},
		quit() {
			state.quitCalls += 1;
		},
	};

	const ipcMain = {
		handle(channel, fn) {
			state.ipcHandlers.set(channel, fn);
		},
	};

	const session = {
		defaultSession: {
			setDisplayMediaRequestHandler(fn, options) {
				state.displayHandler = fn;
				state.displayOptions = options;
			},
		},
	};

	const desktopCapturer = {
		async getSources(options) {
			state.sourcesOptions = options;
			if (getSourcesError) throw new Error(getSourcesError);
			return sources;
		},
	};

	const router = {
		environment: { backend: "ScreenCaptureKit" },
		async probe() {
			return router.environment;
		},
		restoreSync() {
			state.restoreSyncCalls += 1;
		},
	};

	const captureSession = {
		activeApp: null,
		activeMode: null,
		isActive: () => false,
		listApplications: async () => [{ id: "100", app: "Safari", streams: 1 }],
		async start(target) {
			const mode = target && target.mode === "system" ? "system" : "app";
			const app = mode === "system" ? null : typeof target === "string" ? target : target.app;
			captureSession.activeApp = app;
			captureSession.activeMode = mode;
			return {
				mode,
				app,
				transport: "pcm",
			};
		},
		async stop() {
			captureSession.activeApp = null;
			captureSession.activeMode = null;
		},
	};

	return { state, app, BrowserWindow, ipcMain, session, desktopCapturer, router, captureSession };
}

function build(overrides = {}) {
	const fakes = makeFakes(overrides);
	const shell = createShell({
		...fakes,
		url: overrides.url || URL,
		preloadPath: PRELOAD,
		iconPath: overrides.iconPath || null,
		defaultUrl: overrides.defaultUrl || null,
		startupError: overrides.startupError || null,
		log: (message) => fakes.state.logs.push(message),
	});
	return { ...fakes, shell };
}

const call = (state, channel, ...args) => state.ipcHandlers.get(channel)({}, ...args);

test("start registers the IPC surface, the capture handler and the window", async () => {
	const { state, shell } = build();
	await shell.start();

	for (const channel of ["audio:list", "audio:probe", "audio:start", "audio:stop", "audio:state"]) {
		assert.ok(state.ipcHandlers.has(channel), `missing IPC channel ${channel}`);
	}
	assert.ok(state.displayHandler, "display media handler not registered");
	assert.equal(state.windows.length, 1, "expected exactly one window");
});

test("audio:list and audio:probe work through IPC", async () => {
	const { state, shell } = build();
	await shell.start();

	const listResult = await call(state, "audio:list");
	assert.equal(listResult.ok, true);
	assert.deepEqual(listResult.apps, [{ id: "100", app: "Safari", streams: 1 }]);

	const probeResult = await call(state, "audio:probe");
	assert.equal(probeResult.ok, true);
	assert.equal(probeResult.environment.backend, "ScreenCaptureKit");
});

test("errorPageHtml carries the title, hint and address", () => {
	const html = errorPageHtml({
		title: "T",
		message: "M",
		hint: "H",
		url: "http://127.0.0.1:8080/",
	});

	assert.match(html, /<title>T<\/title>/);
	assert.match(html, /http:\/\/127\.0\.0\.1:8080\//);
	assert.match(html, /color-scheme: dark/);
	assert.match(html, /H/);
});

