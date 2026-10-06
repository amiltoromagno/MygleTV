// Tests for the Electron wiring.
//
// Electron cannot run in the build sandbox -- no /dev/dri, no display socket --
// so shell.js takes every Electron module as a parameter and these tests pass
// fakes. That verifies the parts that would otherwise be pure guesswork: which
// IPC channels exist, what they return on failure, how the display-media
// handler behaves, and that quitting restores audio.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createShell, errorPageHtml } from "../shell.js";

const PRELOAD = "/app/preload.cjs";
const URL = "http://127.0.0.1:8080/";

function makeFakes({ sources = [{ id: "screen:0", name: "DP-1" }], getSourcesError = null } = {}) {
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
		environment: { defaultSink: "alsa_output.speakers" },
		loadedModules: [],
		movedStreams: [],
		async probe() {
			return router.environment;
		},
		restoreSync() {
			state.restoreSyncCalls += 1;
		},
	};

	// Mutable so tests can flip it, as the real session does.
	const captureSession = {
		activeApp: null,
		activeMode: null,
		isActive: () => false,
		listApps: async () => [{ index: 2737, app: "Firefox" }],
		listApplications: async () => [{ app: "Firefox", streams: 2 }],
		async start(target) {
			const mode = target && target.mode === "system" ? "system" : "app";
			const app = mode === "system" ? null : typeof target === "string" ? target : target.app;
			captureSession.activeApp = app;
			captureSession.activeMode = mode;
			return {
				mode,
				app,
				deviceLabel: mode === "system" ? "MygleTV-System" : "MygleTV",
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
		startupError: overrides.startupError || null,
		log: (message) => fakes.state.logs.push(message),
	});
	return { ...fakes, shell };
}

/** Pull the HTML back out of a data: URL the window was pointed at. */
function decodedPage(win) {
	return decodeURIComponent(win.loadedUrl.split(",").slice(1).join(","));
}

const call = (state, channel, ...args) => state.ipcHandlers.get(channel)({}, ...args);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

test("start registers the IPC surface, the capture handler and the window", async () => {
	const { state, shell } = build();
	await shell.start();

	for (const channel of ["audio:list", "audio:probe", "audio:start", "audio:stop", "audio:state"]) {
		assert.ok(state.ipcHandlers.has(channel), `missing IPC channel ${channel}`);
	}
	assert.ok(state.displayHandler, "display media handler not registered");
	assert.equal(state.windows.length, 1, "expected exactly one window");
});

test("the window is created locked down and loads the configured origin", async () => {
	const { state, shell } = build();
	await shell.start();

	const win = state.windows[0];
	assert.ok(win, "no window was created");
	assert.equal(win.options.webPreferences.preload, PRELOAD);
	assert.equal(win.options.webPreferences.contextIsolation, true);
	assert.equal(win.options.webPreferences.nodeIntegration, false);
	assert.equal(win.loadedUrl, URL);
});

test("the window title names the relay, so two servers are distinguishable", async () => {
	// Two MygleTV servers can both hold a room called "main". Identical room
	// names on different relays look exactly like a broken app, so the title has
	// to say which one this window is on.
	const { state, shell } = build();
	await shell.start();
	const win = state.windows[0];

	// Electron reports the page's own title (which carries the room).
	win.handlers.get("page-title-updated")({ preventDefault() {} }, "#main — MygleTV");

	const title = state.windowTitles[state.windowTitles.length - 1];
	assert.match(title, /#main/, "keeps the room from the page");
	assert.match(title, /127\.0\.0\.1:8080/, "and adds the relay host");
});

test("the system picker is preferred for screen capture", async () => {
	const { state, shell } = build();
	await shell.start();
	assert.deepEqual(state.displayOptions, { useSystemPicker: true });
});

// ---------------------------------------------------------------------------
// Audio IPC
// ---------------------------------------------------------------------------

test("audio:list returns applications, not raw streams", async () => {
	const { state, shell } = build();
	await shell.start();

	const result = await call(state, "audio:list");
	assert.equal(result.ok, true);
	assert.deepEqual(result.apps, [{ app: "Firefox", streams: 2 }]);
});

test("audio:list reports failure instead of rejecting", async () => {
	const { state, shell, captureSession } = build();
	captureSession.listApplications = async () => {
		throw new Error("cannot list");
	};
	await shell.start();

	const result = await call(state, "audio:list");
	assert.equal(result.ok, false);
	assert.equal(result.error, "cannot list");
});

test("audio:probe returns the environment", async () => {
	const { state, shell } = build();
	await shell.start();

	const result = await call(state, "audio:probe");
	assert.equal(result.ok, true);
	assert.equal(result.environment.defaultSink, "alsa_output.speakers");
});

test("audio:start returns the device label the renderer should capture", async () => {
	const { state, shell } = build();
	await shell.start();

	const result = await call(state, "audio:start", { mode: "app", app: "Firefox" });
	assert.deepEqual(result, {
		ok: true,
		mode: "app",
		app: "Firefox",
		deviceLabel: "MygleTV",
	});
});

test("audio:start forwards whole-system mode and reports its own device", async () => {
	const { state, shell, captureSession } = build();
	await shell.start();

	const result = await call(state, "audio:start", { mode: "system" });

	assert.equal(result.ok, true);
	assert.equal(result.mode, "system");
	assert.equal(result.app, null);
	assert.equal(result.deviceLabel, "MygleTV-System");
	assert.equal(captureSession.activeMode, "system");
});

test("audio:start replaces an existing capture rather than leaking it", async () => {
	const { state, shell, captureSession } = build();
	captureSession.isActive = () => true;

	const order = [];
	const realStop = captureSession.stop.bind(captureSession);
	captureSession.stop = async () => {
		order.push("stop");
		await realStop();
	};
	const realStart = captureSession.start.bind(captureSession);
	captureSession.start = async (target) => {
		order.push("start");
		return realStart(target);
	};

	await shell.start();
	await call(state, "audio:start", { mode: "app", app: "SuperGame" });

	assert.deepEqual(order, ["stop", "start"], "must stop the old capture before starting");
});

test("audio:start skips the stop when nothing is running", async () => {
	const { state, shell, captureSession } = build();
	let stops = 0;
	captureSession.stop = async () => {
		stops += 1;
	};

	await shell.start();
	await call(state, "audio:start", { mode: "app", app: "Firefox" });
	assert.equal(stops, 0);
});

test("audio:start surfaces a failure as ok:false", async () => {
	const { state, shell, captureSession } = build();
	captureSession.isActive = () => true;
	captureSession.stop = async () => {};
	captureSession.start = async () => {
		throw new Error('"Discord" is not playing audio right now');
	};

	await shell.start();
	const result = await call(state, "audio:start", "Discord");

	assert.equal(result.ok, false);
	assert.match(result.error, /not playing audio/);
});

test("audio:stop and audio:state round-trip", async () => {
	const { state, shell, captureSession } = build();
	await shell.start();

	await call(state, "audio:start", { mode: "app", app: "Firefox" });
	assert.deepEqual(await call(state, "audio:state"), { activeApp: "Firefox", activeMode: "app" });

	const stopped = await call(state, "audio:stop");
	assert.equal(stopped.ok, true);
	assert.deepEqual(await call(state, "audio:state"), { activeApp: null, activeMode: null });
});

// ---------------------------------------------------------------------------
// Screen capture fallback
// ---------------------------------------------------------------------------

test("the capture handler hands back the first available source", async () => {
	const { state, shell } = build({ sources: [{ id: "screen:1", name: "HDMI-1" }] });
	await shell.start();

	let received = null;
	await state.displayHandler({}, (value) => {
		received = value;
	});

	assert.deepEqual(received, { video: { id: "screen:1", name: "HDMI-1" } });
	assert.ok(state.logs.some((line) => /granting "HDMI-1"/.test(line)));
});

test("the capture handler says when it is guessing between sources", async () => {
	// On Wayland this handler should not run at all: the system picker is the
	// only way to offer a real choice. When it does run, the log has to make it
	// obvious, because "no picker appeared" is otherwise indistinguishable from
	// "a picker appeared and was missed".
	const { state, shell } = build({
		sources: [
			{ id: "screen:1", name: "HDMI-1" },
			{ id: "window:9", name: "Some Window" },
		],
	});
	await shell.start();

	await state.displayHandler({}, () => {});

	assert.ok(
		state.logs.some((line) => /WARNING: choosing "HDMI-1" without asking/.test(line)),
		"a guess between several sources must be logged as one",
	);
	assert.ok(
		state.logs.some((line) => /system picker did not run/.test(line)),
		"and the handler must say that the picker did not run",
	);
});

test("the capture handler declines cleanly when there is nothing to share", async () => {
	const { state, shell } = build({ sources: [] });
	await shell.start();

	let received = null;
	await state.displayHandler({}, (value) => {
		received = value;
	});

	assert.deepEqual(received, {});
	assert.ok(state.logs.some((line) => /nothing available to capture/.test(line)));
});

test("the capture handler declines cleanly when enumeration throws", async () => {
	const { state, shell } = build({ getSourcesError: "portal exploded" });
	await shell.start();

	let received = null;
	await state.displayHandler({}, (value) => {
		received = value;
	});

	assert.deepEqual(received, {});
	assert.ok(state.logs.some((line) => /source selection failed: portal exploded/.test(line)));
});

test("zero-sized thumbnails are requested, since the picker does not need them", async () => {
	const { state, shell } = build();
	await shell.start();
	await state.displayHandler({}, () => {});

	assert.deepEqual(state.sourcesOptions.thumbnailSize, { width: 0, height: 0 });
});

// ---------------------------------------------------------------------------
// Failure must never look like a blank window
// ---------------------------------------------------------------------------

test("a startup failure is explained rather than left blank", async () => {
	const { state, shell } = build({
		startupError: {
			title: "The MygleTV server did not start",
			message: "port 8080 is busy",
			hint: "try another port",
		},
	});
	await shell.start();

	const win = state.windows[0];
	assert.match(win.loadedUrl, /^data:text\/html/, "should render an explanation, not the app");

	const page = decodedPage(win);
	assert.match(page, /The MygleTV server did not start/);
	assert.match(page, /port 8080 is busy/);
	assert.match(page, /try another port/);
});

test("an unreachable origin is explained rather than left blank", async () => {
	const { state, shell } = build();
	await shell.start();
	const win = state.windows[0];
	assert.equal(win.loadedUrl, URL, "the app should be attempted first");

	// Chromium reports that nothing answered at the origin.
	win.webContents.handlers.get("did-fail-load")({}, -102, "CONNECTION_REFUSED", URL, true);

	assert.match(win.loadedUrl, /^data:text\/html/);
	const page = decodedPage(win);
	assert.match(page, /Could not reach MygleTV/);
	assert.match(page, /SCREENROOM_URL/, "the explanation should say how to fix it");
	assert.ok(
		state.logs.some((line) => /failed to load/.test(line)),
		"the failure should be logged",
	);
});

test("a failed subframe does not replace the whole app", async () => {
	const { state, shell } = build();
	await shell.start();
	const win = state.windows[0];

	win.webContents.handlers.get("did-fail-load")({}, -102, "nope", "http://ads.example/", false);

	assert.equal(win.loadedUrl, URL, "only main-frame failures matter");
});

test("the error page cannot loop on its own failure", async () => {
	const { state, shell } = build();
	await shell.start();
	const win = state.windows[0];
	const failed = win.webContents.handlers.get("did-fail-load");

	failed({}, -102, "first", URL, true);
	const first = win.loadedUrl;
	failed({}, -102, "second", URL, true);

	assert.equal(win.loadedUrl, first, "a second failure must not re-render the page");
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("quitting restores audio even if the renderer never asked", async () => {
	const { state, shell } = build();
	await shell.start();

	state.appHandlers.get("before-quit")();
	assert.equal(state.restoreSyncCalls, 1);
});

test("closing every window quits the app", async () => {
	const { state, shell } = build();
	await shell.start();

	state.appHandlers.get("window-all-closed")();
	assert.equal(state.quitCalls, 1);
});

test("activating with no windows reopens one", async () => {
	const { state, shell } = build();
	await shell.start();
	assert.equal(state.windows.length, 1);

	// The window reported itself closed.
	state.windows[0].handlers.get("closed")();
	state.windows.length = 0;

	state.appHandlers.get("activate")();
	assert.equal(state.windows.length, 1, "expected a new window on activate");
});
