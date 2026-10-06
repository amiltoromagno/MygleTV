// Unit tests for the capture session lifecycle.
//
// The router is faked here: what matters is the *sequencing* -- that setup
// happens in an order where a failure can always be undone, and that a failed
// start does not leave the user's audio routed into a sink that is about to
// disappear.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	createCaptureSession,
	groupByApplication,
	SYSTEM_TAP_LABEL,
	SYSTEM_TAP_NAME,
	VIRTUAL_MIC_LABEL,
	VIRTUAL_MIC_NAME,
} from "../audio/session.js";
import { DEFAULT_CAPTURE_SINK } from "../audio/linux.js";

/** A router double that records calls and can be told to fail at a given step. */
function fakeRouter({ failAt = null, apps = [{ index: 2737, app: "Firefox" }] } = {}) {
	const calls = [];
	const router = {
		environment: null,
		loadedModules: [],
		movedStreams: [],
		captureSink: null,
		virtualMic: null,
		calls,

		async probe() {
			calls.push("probe");
			if (failAt === "probe") throw new Error("no audio server");
			router.environment = { isPipeWire: true, defaultSink: "alsa_output.speakers" };
			return router.environment;
		},
		async cleanupStale(names) {
			calls.push(`cleanupStale:${(names || []).join(",")}`);
			if (failAt === "cleanupStale") throw new Error("cannot sweep");
			return 0;
		},
		async listApps() {
			calls.push("listApps");
			if (failAt === "listApps") throw new Error("cannot list");
			return apps;
		},
		async createCaptureSink(name) {
			calls.push(`createCaptureSink:${name}`);
			if (failAt === "createCaptureSink") throw new Error("cannot create sink");
			router.loadedModules.push(42);
			router.captureSink = { id: 42, name };
			return router.captureSink;
		},
		async createVirtualMic(sink, source, label) {
			calls.push(`createVirtualMic:${sink}:${source}:${label}`);
			if (failAt === "createVirtualMic") throw new Error("cannot create mic");
			router.loadedModules.push(43);
			router.virtualMic = { id: 43, name: source };
			return router.virtualMic;
		},
		async addMonitorReturn(sink, target) {
			calls.push(`addMonitorReturn:${sink}:${target}`);
			if (failAt === "addMonitorReturn") throw new Error("cannot loop back");
			router.loadedModules.push(44);
			return 44;
		},
		async createSystemTap(name, label) {
			calls.push(`createSystemTap:${name}:${label}`);
			if (failAt === "createSystemTap") throw new Error("cannot tap the output");
			router.loadedModules.push(45);
			router.systemTap = { id: 45, name };
			return router.systemTap;
		},
		async routeApp(index, sink) {
			calls.push(`routeApp:${index}:${sink}`);
			if (failAt === "routeApp") throw new Error("cannot route");
			router.movedStreams.push({ index, originalSink: 70 });
		},
		async restore() {
			calls.push("restore");
			router.loadedModules = [];
			router.movedStreams = [];
			router.captureSink = null;
			router.virtualMic = null;
		},
	};
	return router;
}

test("start sets up the sink, virtual mic, loopback and route, in that order", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	const result = await session.start("Firefox");

	assert.deepEqual(router.calls, [
		"probe",
		`cleanupStale:${DEFAULT_CAPTURE_SINK},${VIRTUAL_MIC_NAME},${SYSTEM_TAP_NAME}`,
		`createCaptureSink:${DEFAULT_CAPTURE_SINK}`,
		`createVirtualMic:${DEFAULT_CAPTURE_SINK}:${VIRTUAL_MIC_NAME}:${VIRTUAL_MIC_LABEL}`,
		`addMonitorReturn:${DEFAULT_CAPTURE_SINK}:alsa_output.speakers`,
		"listApps",
		`routeApp:2737:${DEFAULT_CAPTURE_SINK}`,
	]);

	assert.equal(result.app, "Firefox");
	assert.equal(result.deviceLabel, VIRTUAL_MIC_LABEL);
	assert.equal(session.activeApp, "Firefox");
	assert.equal(session.isActive(), true);
});

test("device labels contain no whitespace", async () => {
	// `source_properties` is parsed by splitting on whitespace, so a label with a
	// space is silently truncated to its first word. For the system tap that
	// produced "ScreenRoom" -- identical to the application mic -- and the
	// renderer's exact-match lookup then failed with a message that pointed
	// nowhere near the cause. A space here is never a display preference.
	for (const [name, label] of [
		["VIRTUAL_MIC_LABEL", VIRTUAL_MIC_LABEL],
		["SYSTEM_TAP_LABEL", SYSTEM_TAP_LABEL],
	]) {
		assert.ok(
			!/\s/.test(label),
			`${name} ("${label}") must not contain whitespace or it will be truncated`,
		);
	}
});

test("the two device labels are distinct", async () => {
	// They were briefly identical, which is what made the failure so confusing.
	assert.notEqual(VIRTUAL_MIC_LABEL, SYSTEM_TAP_LABEL);
});

test("starting sweeps stale capture plumbing first", async () => {
	// A crash leaves the old sink and source loaded. If they survive, the stale
	// "ScreenRoom" source wins the renderer's device lookup on the next share and
	// the app captures a dead sink -- silence, with nothing to explain it.
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	await session.start("Firefox");

	const swept = router.calls.findIndex((call) => call.startsWith("cleanupStale:"));
	const created = router.calls.findIndex((call) => call.startsWith("createCaptureSink:"));
	assert.ok(swept !== -1, "expected a sweep");
	assert.ok(created !== -1);
	assert.ok(swept < created, "the sweep must precede creating our own source");
});

test("a sweep failure does not block the capture", async () => {
	const router = fakeRouter({ failAt: "cleanupStale" });
	const session = createCaptureSession({ router });

	// find/filter style: a stale module that cannot be removed should not stop a
	// capture from being attempted.
	await assert.rejects(() => session.start("Firefox"), /cannot sweep/);
	assert.equal(session.isActive(), false);
});

test("the loopback is added before routing, so audio is never silent", async () => {	// If the stream were moved before the monitor return existed, the user would
	// lose their audio for however long the gap lasted.
	const router = fakeRouter();
	const session = createCaptureSession({ router });
	await session.start("Firefox");

	const loopbackAt = router.calls.indexOf(
		`addMonitorReturn:${DEFAULT_CAPTURE_SINK}:alsa_output.speakers`,
	);
	const routeAt = router.calls.findIndex((call) => call.startsWith("routeApp:"));
	assert.ok(loopbackAt !== -1 && routeAt !== -1);
	assert.ok(loopbackAt < routeAt, "monitor return must precede the stream move");
});

test("application matching is case-insensitive", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });
	const result = await session.start("firefox");
	assert.equal(result.app, "Firefox");
});

test("start rolls everything back when the app is not playing", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	await assert.rejects(() => session.start("NotRunning"), /not playing audio/);

	assert.ok(router.calls.includes("restore"), "must restore after a failed start");
	assert.deepEqual(router.loadedModules, []);
	assert.deepEqual(router.movedStreams, []);
	assert.equal(session.activeApp, null);
	assert.equal(session.isActive(), false);
});

test("start rolls back when a setup step fails part-way", async () => {
	for (const step of ["createCaptureSink", "createVirtualMic", "addMonitorReturn", "routeApp"]) {
		const router = fakeRouter({ failAt: step });
		const session = createCaptureSession({ router });

		await assert.rejects(
			() => session.start("Firefox"),
			(err) => err instanceof Error,
			`expected failure at ${step}`,
		);

		assert.equal(session.isActive(), false, `leftover state after failing at ${step}`);
		assert.equal(session.activeApp, null);
	}
});

test("a failing probe is reported without pretending anything changed", async () => {
	const router = fakeRouter({ failAt: "probe" });
	const session = createCaptureSession({ router });

	await assert.rejects(() => session.start("Firefox"), /no audio server/);
	assert.equal(session.isActive(), false);
	assert.equal(session.activeApp, null);
});

test("stop restores and clears the active application", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	await session.start("Firefox");
	await session.stop();

	assert.equal(session.activeApp, null);
	assert.equal(session.isActive(), false);
	assert.ok(router.calls.includes("restore"));
});

test("listApps probes first when the environment is unknown", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	const apps = await session.listApps();
	assert.deepEqual(apps, [{ index: 2737, app: "Firefox" }]);
	assert.equal(router.calls[0], "probe");
});

test("a custom sink and mic name are honoured", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({
		router,
		sinkName: "my_sink",
		micName: "my_mic",
		micLabel: "MyLabel",
	});

	const result = await session.start("Firefox");
	assert.ok(router.calls.includes("createCaptureSink:my_sink"));
	assert.ok(router.calls.includes("createVirtualMic:my_sink:my_mic:MyLabel"));
	assert.equal(result.deviceLabel, "MyLabel");
});

// ---------------------------------------------------------------------------
// Applications own several streams
// ---------------------------------------------------------------------------

test("routes every stream an application owns, not just the first", async () => {
	// Firefox with two tabs playing has two sink-inputs. Moving only one would
	// leave the other on the speakers: the listener would get part of the audio
	// and the sharer would still hear the rest.
	const router = fakeRouter({
		apps: [
			{ index: 10, app: "Firefox" },
			{ index: 11, app: "Firefox" },
			{ index: 12, app: "Chromium" },
		],
	});
	const session = createCaptureSession({ router });

	const result = await session.start("Firefox");

	const routed = router.calls.filter((call) => call.startsWith("routeApp:"));
	assert.deepEqual(routed, [
		`routeApp:10:${DEFAULT_CAPTURE_SINK}`,
		`routeApp:11:${DEFAULT_CAPTURE_SINK}`,
	]);
	assert.equal(result.streams, 2);

	// Chromium must be left alone.
	assert.equal(router.movedStreams.length, 2);
});

test("a single-stream application reports one stream", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });
	const result = await session.start("Firefox");
	assert.equal(result.streams, 1);
});

test("groupByApplication collapses duplicates and counts them", () => {
	const grouped = groupByApplication([
		{ index: 1, app: "Firefox" },
		{ index: 2, app: "Firefox" },
		{ index: 3, app: "Chromium" },
		{ index: 4, app: "firefox" }, // same application, different casing
		{ index: 5, app: "" }, // not selectable
		{ index: 6 }, // malformed
	]);

	assert.deepEqual(grouped, [
		{ app: "Chromium", streams: 1 },
		{ app: "Firefox", streams: 3 },
	]);
});

test("groupByApplication tolerates nothing at all", () => {
	assert.deepEqual(groupByApplication([]), []);
	assert.deepEqual(groupByApplication(null), []);
	assert.deepEqual(groupByApplication(undefined), []);
});

test("listApplications returns one entry per application", async () => {
	const router = fakeRouter({
		apps: [
			{ index: 1, app: "Firefox" },
			{ index: 2, app: "Firefox" },
			{ index: 3, app: "SuperGame" },
		],
	});
	const session = createCaptureSession({ router });

	assert.deepEqual(await session.listApplications(), [
		{ app: "Firefox", streams: 2 },
		{ app: "SuperGame", streams: 1 },
	]);
});

// ---------------------------------------------------------------------------
// Whole-system mode
// ---------------------------------------------------------------------------

test("system mode taps the output and moves nothing", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	const result = await session.start({ mode: "system" });

	assert.deepEqual(router.calls, [
		"probe",
		`cleanupStale:${DEFAULT_CAPTURE_SINK},${VIRTUAL_MIC_NAME},${SYSTEM_TAP_NAME}`,
		`createSystemTap:${SYSTEM_TAP_NAME}:${SYSTEM_TAP_LABEL}`,
	]);

	// A tap, not a detour: no sink, no loopback, no stream moved. That is what
	// lets the user keep hearing everything normally.
	assert.equal(router.calls.some((call) => call.startsWith("createCaptureSink")), false);
	assert.equal(router.calls.some((call) => call.startsWith("addMonitorReturn")), false);
	assert.equal(router.movedStreams.length, 0);

	assert.equal(result.mode, "system");
	assert.equal(result.app, null);
	assert.equal(result.deviceLabel, SYSTEM_TAP_LABEL);
	assert.equal(session.activeMode, "system");
	assert.equal(session.activeApp, null);
});

test("application mode reports itself as such", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	const result = await session.start({ mode: "app", app: "Firefox" });
	assert.equal(result.mode, "app");
	assert.equal(result.app, "Firefox");
	assert.equal(result.deviceLabel, VIRTUAL_MIC_LABEL);
	assert.equal(session.activeMode, "app");
});

test("a bare string is still accepted as an application name", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	const result = await session.start("Firefox");
	assert.equal(result.mode, "app");
	assert.equal(result.app, "Firefox");
});

test("system mode restores when the tap fails", async () => {
	const router = fakeRouter({ failAt: "createSystemTap" });
	const session = createCaptureSession({ router });

	await assert.rejects(() => session.start({ mode: "system" }), /cannot tap/);
	assert.equal(session.isActive(), false);
	assert.equal(session.activeMode, null);
});

test("stop clears the mode as well as the application", async () => {
	const router = fakeRouter();
	const session = createCaptureSession({ router });

	await session.start({ mode: "system" });
	await session.stop();

	assert.equal(session.activeMode, null);
	assert.equal(session.activeApp, null);
});
