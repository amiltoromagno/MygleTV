// Unit tests for the Linux audio router.
//
// These deliberately never touch a real sound server: the whole point of the
// injectable runner is that the parsing and -- more importantly -- the teardown
// ordering can be verified deterministically. Getting restore order wrong is
// how a user ends up with silent audio and no obvious way back.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_CAPTURE_SINK,
	LinuxAudioError,
	LinuxAudioRouter,
	parseSinkInputs,
	parseSinkInputsText,
	parseSinks,
	parseSinksText,
} from "../audio/linux.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INFO_JSON = JSON.stringify({
	server_name: "PulseAudio (on PipeWire 1.6.9)",
	default_sink_name: "alsa_output.usb-SteelSeries-00.analog-stereo",
	default_source_name: "alsa_input.usb-SteelSeries-00.mono-fallback",
	default_sample_specification: "float32le 2ch 48000Hz",
});

const SINKS_JSON = JSON.stringify([
	{
		index: 65,
		name: "alsa_output.pci-0000_03_00.1.pro-output-7",
		state: "SUSPENDED",
		properties: { "device.description": "Navi 48 HDMI/DP Audio Controller Pro 7" },
	},
	{
		index: 70,
		name: "alsa_output.usb-SteelSeries-00.analog-stereo",
		state: "RUNNING",
		properties: { "device.description": "Arctis Nova 3P Wireless Analog Stereo" },
	},
]);

const SINK_INPUTS_JSON = JSON.stringify([
	{
		index: 2737,
		sink: 70,
		corked: false,
		mute: false,
		properties: {
			"application.name": "Chromium",
			"application.process.id": "2321",
			"application.process.binary": "chromium",
			"media.name": "Playback",
		},
	},
	{
		index: 2984,
		sink: 70,
		corked: true,
		mute: false,
		properties: {
			// No application.name: we should fall back to the binary.
			"application.process.binary": "firefox",
			"application.process.id": "4410",
		},
	},
]);

const SINK_INPUTS_TEXT = `Sink Input #2737
\tDriver: PipeWire
\tOwner Module: 4294967295
\tClient: 45
\tSink: 70
\tSample Specification: float32le 2ch 48000Hz
\tCorked: no
\tMute: no
\tVolume: front-left: 65536 / 100% / 0.00 dB
\tProperties:
\t\tmedia.name = "Playback"
\t\tapplication.name = "Chromium"
\t\tapplication.icon_name = "chromium"
\t\tapplication.process.id = "2321"
\t\tapplication.process.binary = "chromium"

Sink Input #2984
\tDriver: PipeWire
\tClient: 61
\tSink: 70
\tCorked: yes
\tMute: no
\tProperties:
\t\tmedia.name = "playStream"
\t\tapplication.process.binary = "firefox"
\t\tapplication.process.id = "4410"
`;

const SINKS_TEXT = `Sink #70
\tState: RUNNING
\tName: alsa_output.usb-SteelSeries-00.analog-stereo
\tDescription: Arctis Nova 3P Wireless Analog Stereo
\tDriver: PipeWire
`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A runner that records every call and replies from a list of matchers. */
function fakeRunner(handlers = []) {
	const calls = [];
	const run = async (cmd, args) => {
		calls.push({ cmd, args, line: [cmd, ...args].join(" ") });
		for (const handler of handlers) {
			if (handler.match(cmd, args)) {
				const reply = typeof handler.reply === "function" ? handler.reply(cmd, args) : handler.reply;
				return { code: 0, stdout: "", stderr: "", ...reply };
			}
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	run.calls = calls;
	run.lines = () => calls.map((c) => c.line);
	return run;
}

const respond = (predicate, reply) => ({ match: predicate, reply });
const has = (...needles) => (cmd, args) => needles.every((n) => args.includes(n));

function healthyRunner(extra = []) {
	return fakeRunner([
		respond(has("info"), { stdout: INFO_JSON }),
		respond(has("list", "sink-inputs"), { stdout: SINK_INPUTS_JSON }),
		respond(has("list", "sinks"), { stdout: SINKS_JSON }),
		...extra,
	]);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parses sink inputs from pactl JSON", () => {
	const apps = parseSinkInputs(JSON.parse(SINK_INPUTS_JSON));
	assert.equal(apps.length, 2);
	assert.equal(apps[0].index, 2737);
	assert.equal(apps[0].app, "Chromium");
	assert.equal(apps[0].pid, 2321);
	assert.equal(apps[0].sinkIndex, 70);
	assert.equal(apps[0].corked, false);
	assert.equal(apps[1].corked, true);
});

test("falls back to the process binary when application.name is absent", () => {
	const apps = parseSinkInputs(JSON.parse(SINK_INPUTS_JSON));
	assert.equal(apps[1].app, "firefox");
	assert.equal(apps[1].pid, 4410);
});

test("parses sink inputs from pactl text output", () => {
	const apps = parseSinkInputsText(SINK_INPUTS_TEXT);
	assert.equal(apps.length, 2);

	assert.equal(apps[0].index, 2737);
	assert.equal(apps[0].app, "Chromium");
	assert.equal(apps[0].pid, 2321);
	assert.equal(apps[0].sinkIndex, 70);
	assert.equal(apps[0].corked, false);

	// Second block exercises the binary fallback and the corked flag.
	assert.equal(apps[1].index, 2984);
	assert.equal(apps[1].app, "firefox");
	assert.equal(apps[1].pid, 4410);
	assert.equal(apps[1].corked, true);
});

test("parses sinks from JSON and text", () => {
	const json = parseSinks(JSON.parse(SINKS_JSON));
	assert.equal(json.length, 2);
	assert.equal(json[1].name, "alsa_output.usb-SteelSeries-00.analog-stereo");
	assert.equal(json[1].description, "Arctis Nova 3P Wireless Analog Stereo");

	const text = parseSinksText(SINKS_TEXT);
	assert.equal(text.length, 1);
	assert.equal(text[0].index, 70);
	assert.equal(text[0].state, "RUNNING");
	assert.equal(text[0].description, "Arctis Nova 3P Wireless Analog Stereo");
});

test("tolerates empty and malformed input", () => {
	assert.deepEqual(parseSinkInputs(null), []);
	assert.deepEqual(parseSinkInputs("nonsense"), []);
	assert.deepEqual(parseSinkInputsText(""), []);
	assert.deepEqual(parseSinks(undefined), []);
	assert.deepEqual(parseSinksText(""), []);
});

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

test("probe detects PipeWire and the default sink", async () => {
	const router = new LinuxAudioRouter({ run: healthyRunner() });
	const env = await router.probe();

	assert.equal(env.isPipeWire, true);
	assert.equal(env.pipeWireVersion, "1.6.9");
	assert.equal(env.jsonSupported, true);
	assert.equal(env.defaultSink, "alsa_output.usb-SteelSeries-00.analog-stereo");
});

test("probe falls back to text when --format=json is unsupported", async () => {
	const run = fakeRunner([
		respond(
			has("info"),
			(cmd, args) => (args.includes("--format=json") ? { code: 1, stderr: "invalid option" } : { stdout: "Server Name: pulseaudio\nDefault Sink: alsa_output.built-in\n" }),
		),
	]);
	const router = new LinuxAudioRouter({ run });
	const env = await router.probe();

	assert.equal(env.jsonSupported, false);
	assert.equal(env.isPipeWire, false);
	assert.equal(env.defaultSink, "alsa_output.built-in");
});

test("probe reports a clear error when no audio server is reachable", async () => {
	const run = fakeRunner([respond(() => true, { code: 1, stderr: "Connection refused" })]);
	const router = new LinuxAudioRouter({ run });

	await assert.rejects(() => router.probe(), (err) => {
		assert.ok(err instanceof LinuxAudioError);
		assert.match(err.message, /audio service running/i);
		return true;
	});
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

test("listApps resolves each stream to its sink name", async () => {
	const router = new LinuxAudioRouter({ run: healthyRunner() });
	const apps = await router.listApps();

	assert.equal(apps.length, 2);
	assert.equal(apps[0].sinkName, "alsa_output.usb-SteelSeries-00.analog-stereo");
	assert.equal(apps[0].sinkDescription, "Arctis Nova 3P Wireless Analog Stereo");
});

test("listApps still works when sink lookup fails", async () => {
	const run = fakeRunner([
		respond(has("info"), { stdout: INFO_JSON }),
		respond(has("list", "sink-inputs"), { stdout: SINK_INPUTS_JSON }),
		respond(has("list", "sinks"), { code: 1, stderr: "boom" }),
	]);
	const router = new LinuxAudioRouter({ run });
	await router.probe();

	const apps = await router.listApps();
	assert.equal(apps.length, 2);
	assert.equal(apps[0].sinkName, null);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test("createCaptureSink records the module id for later unload", async () => {
	const run = healthyRunner([respond(has("load-module", "module-null-sink"), { stdout: "42\n" })]);
	const router = new LinuxAudioRouter({ run });

	const sink = await router.createCaptureSink();
	assert.equal(sink.name, DEFAULT_CAPTURE_SINK);
	assert.equal(sink.id, 42);
	assert.deepEqual(router.loadedModules, [42]);

	// A second call must not create a second sink.
	await router.createCaptureSink();
	assert.equal(run.calls.filter((c) => c.args.includes("module-null-sink")).length, 1);
});

test("createCaptureSink complains if pactl returns no module id", async () => {
	const run = healthyRunner([respond(has("load-module"), { stdout: "not-a-number" })]);
	const router = new LinuxAudioRouter({ run });
	await assert.rejects(() => router.createCaptureSink(), LinuxAudioError);
});

test("addMonitorReturn wires the sink back to the real output", async () => {
	const run = healthyRunner([respond(has("module-loopback"), { stdout: "43\n" })]);
	const router = new LinuxAudioRouter({ run });

	const id = await router.addMonitorReturn(DEFAULT_CAPTURE_SINK, "alsa_output.speakers", 25);
	assert.equal(id, 43);

	const call = run.calls.find((c) => c.args.includes("module-loopback"));
	assert.ok(call.args.includes(`source=${DEFAULT_CAPTURE_SINK}.monitor`));
	assert.ok(call.args.includes("sink=alsa_output.speakers"));
	assert.ok(call.args.includes("latency_msec=25"));
});

test("a failed monitor return is a warning, not a fatal error", async () => {
	const run = healthyRunner([respond(has("module-loopback"), { code: 1, stderr: "no such sink" })]);
	const router = new LinuxAudioRouter({ run });

	// The user loses monitoring, but capture still works -- don't abort the share.
	const id = await router.addMonitorReturn(DEFAULT_CAPTURE_SINK, "bad-sink");
	assert.equal(id, null);
});

test("routeApp moves the stream and remembers where it came from", async () => {
	const run = healthyRunner([
		respond(has("load-module"), { stdout: "42\n" }),
		respond(has("move-sink-input"), { code: 0 }),
	]);
	const router = new LinuxAudioRouter({ run });
	await router.probe();
	await router.createCaptureSink();

	const app = await router.routeApp(2737, DEFAULT_CAPTURE_SINK);
	assert.equal(app.app, "Chromium");

	const move = run.calls.find((c) => c.args[0] === "move-sink-input");
	assert.deepEqual(move.args, ["move-sink-input", "2737", DEFAULT_CAPTURE_SINK]);

	assert.deepEqual(router.movedStreams, [
		{ index: 2737, originalSink: 70, app: "Chromium" },
	]);
});

test("routeApp surfaces a failure instead of silently doing nothing", async () => {
	const run = healthyRunner([respond(has("move-sink-input"), { code: 1, stderr: "no such stream" })]);
	const router = new LinuxAudioRouter({ run });
	await router.probe();

	await assert.rejects(() => router.routeApp(9999, DEFAULT_CAPTURE_SINK), (err) => {
		assert.match(err.message, /could not move stream #9999/);
		return true;
	});
});

test("monitorSourceName is the sink name plus .monitor", () => {
	const router = new LinuxAudioRouter({ run: healthyRunner() });
	assert.equal(router.monitorSourceName("foo"), "foo.monitor");
});

// ---------------------------------------------------------------------------
// Restore -- the part that must never get the ordering wrong
// ---------------------------------------------------------------------------

test("restore moves streams back and unloads modules in reverse order", async () => {
	const order = [];
	const run = fakeRunner([
		respond(has("info"), { stdout: INFO_JSON }),
		respond(has("list", "sink-inputs"), { stdout: SINK_INPUTS_JSON }),
		respond(has("list", "sinks"), { stdout: SINKS_JSON }),
		{
			match: has("load-module"),
			reply: (cmd, args) => {
				const id = args.includes("module-loopback") ? "43" : "42";
				order.push(`load:${id}`);
				return { stdout: `${id}\n` };
			},
		},
		{
			match: has("move-sink-input"),
			reply: (cmd, args) => {
				order.push(`move:${args[1]}->${args[2]}`);
				return {};
			},
		},
		{
			match: has("unload-module"),
			reply: (cmd, args) => {
				order.push(`unload:${args[1]}`);
				return {};
			},
		},
	]);

	const router = new LinuxAudioRouter({ run });
	await router.probe();
	await router.createCaptureSink(); // module 42
	await router.addMonitorReturn(DEFAULT_CAPTURE_SINK, "alsa_output.speakers"); // module 43
	await router.routeApp(2737, DEFAULT_CAPTURE_SINK);

	await router.restore();

	assert.deepEqual(order, [
		"load:42",
		"load:43",
		"move:2737->screenroom_capture",
		"move:2737->70", // stream returned to its original sink
		"unload:43", // loopback removed before...
		"unload:42", // ...the sink it was looping from
	]);
	assert.deepEqual(router.loadedModules, []);
	assert.deepEqual(router.movedStreams, []);
	assert.equal(router.captureSink, null);
});

test("restore tolerates a stream that already closed", async () => {
	const log = [];
	const run = fakeRunner([
		respond(has("info"), { stdout: INFO_JSON }),
		respond(has("list", "sink-inputs"), { stdout: SINK_INPUTS_JSON }),
		respond(has("list", "sinks"), { stdout: SINKS_JSON }),
		respond(has("load-module"), { stdout: "42\n" }),
		{
			match: has("move-sink-input"),
			reply: (cmd, args) => (args[2] === "70" ? { code: 1, stderr: "no such sink input" } : {}),
		},
		respond(has("unload-module"), {}),
	]);

	const router = new LinuxAudioRouter({ run, log: (m) => log.push(m) });
	await router.probe();
	await router.createCaptureSink();
	await router.routeApp(2737, DEFAULT_CAPTURE_SINK);

	// Must not throw: the app closing mid-share is normal.
	await router.restore();
	assert.ok(log.some((line) => /could not restore stream #2737/.test(line)));
	assert.ok(log.some((line) => /restored audio routing/.test(line)));
});

test("restore is idempotent", async () => {
	const run = healthyRunner([respond(has("load-module"), { stdout: "42\n" })]);
	const router = new LinuxAudioRouter({ run });
	await router.probe();
	await router.createCaptureSink();
	await router.routeApp(2737, DEFAULT_CAPTURE_SINK);

	await router.restore();
	const unloadsAfterFirst = run.calls.filter((c) => c.args[0] === "unload-module").length;

	await router.restore();
	assert.equal(run.calls.filter((c) => c.args[0] === "unload-module").length, unloadsAfterFirst);
});

test("restoreSync undoes state without promises, for exit handlers", () => {
	const attempts = [];
	const fakeSync = (cmd, args) => {
		attempts.push([cmd, ...args].join(" "));
	};

	const router = new LinuxAudioRouter({ run: healthyRunner() });
	router.loadedModules = [42, 43];
	router.movedStreams = [{ index: 2737, originalSink: 70 }];

	router.restoreSync(fakeSync);

	assert.deepEqual(attempts, [
		"pactl move-sink-input 2737 70",
		"pactl unload-module 43",
		"pactl unload-module 42",
	]);
	assert.deepEqual(router.loadedModules, []);
	assert.deepEqual(router.movedStreams, []);
});

test("restoreSync never throws, even if pactl does", () => {
	const router = new LinuxAudioRouter({ run: healthyRunner() });
	router.loadedModules = [42];
	router.movedStreams = [{ index: 2737, originalSink: 70 }];

	assert.doesNotThrow(() => {
		router.restoreSync(() => {
			throw new Error("pactl exploded");
		});
	});
});

// ---------------------------------------------------------------------------
// Sweeping up after a crash
//
// The module index exists only in the *text* listing: `pactl --format=json list
// modules` returns objects with no id at all. Reading the JSON and unloading
// "by index" from it silently does nothing, which is exactly how a stale
// capture source survives to shadow the next one.
// ---------------------------------------------------------------------------

/** A stateful stand-in for pactl, so unloads are actually observable. */
function moduleRunner({ unloadCode = 0, listCode = 0 } = {}) {
	const calls = [];
	const loaded = new Set(["536870916", "536870917", "99"]);

	const listing = () => {
		const lines = [];
		if (loaded.has("536870916")) {
			lines.push(
				"536870916\tmodule-null-sink\tsink_name=screenroom_capture sink_properties=device.description=MygleTV rate=48000 channels=2\t",
			);
		}
		if (loaded.has("536870917")) {
			lines.push(
				"536870917\tmodule-remap-source\tmaster=screenroom_capture.monitor source_name=screenroom_mic source_properties=device.description=MygleTV\t",
			);
		}
		if (loaded.has("99")) {
			lines.push("99\tmodule-null-sink\tsink_name=some_other_app rate=48000\t");
		}
		return lines.join("\n");
	};

	const run = async (cmd, args) => {
		calls.push({ cmd, args, line: [cmd, ...args].join(" ") });
		if (args[0] === "list" && args[1] === "modules") {
			return { code: listCode, stdout: listCode === 0 ? listing() : "", stderr: "" };
		}
		if (args[0] === "unload-module") {
			if (unloadCode !== 0) return { code: unloadCode, stdout: "", stderr: "refused" };
			loaded.delete(String(args[1]));
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	run.calls = calls;
	run.loaded = loaded;
	return run;
}

test("cleanupStale removes our modules, dependants first, and nothing else", async () => {
	const run = moduleRunner();
	const router = new LinuxAudioRouter({ run });

	const removed = await router.cleanupStale();

	assert.equal(removed, 2);
	assert.deepEqual(
		run.calls.filter((call) => call.args[0] === "unload-module").map((call) => call.args[1]),
		["536870917", "536870916"], // the remap before the sink it remaps
	);
	assert.ok(run.loaded.has("99"), "another application's null-sink must survive");
});

test("cleanupStale unloads remaps first whatever order they are listed in", async () => {
	// PipeWire does not promise to list modules in load order, so the ordering has
	// to be explicit rather than a reversal of the listing.
	const unloaded = [];
	const router = new LinuxAudioRouter({
		run: async (cmd, args) => {
			if (args[0] === "list" && args[1] === "modules") {
				return {
					code: 0,
					stderr: "",
					// The remap is listed first here, which is the awkward case.
					stdout: [
						"536870917\tmodule-remap-source\tmaster=screenroom_capture.monitor source_name=screenroom_mic\t",
						"536870916\tmodule-null-sink\tsink_name=screenroom_capture rate=48000\t",
					].join("\n"),
				};
			}
			if (args[0] === "unload-module") {
				unloaded.push(args[1]);
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	});

	await router.cleanupStale();

	assert.deepEqual(unloaded, ["536870917", "536870916"], "the remap must go first");
});

test("cleanupStale reports nothing to do when the system is clean", async () => {
	const run = moduleRunner();
	run.loaded.clear();

	const router = new LinuxAudioRouter({ run });
	assert.equal(await router.cleanupStale(), 0);
	assert.equal(run.calls.some((call) => call.args[0] === "unload-module"), false);
});

test("cleanupStale confirms its work rather than trusting the exit code", async () => {
	// pactl can exit 0 while doing nothing -- the failure mode that hid this bug.
	const run = moduleRunner({ unloadCode: 1 });
	const router = new LinuxAudioRouter({ run });

	assert.equal(await router.cleanupStale(), 0);
	// The modules are still there, and the router should have said so.
	assert.equal(run.loaded.size, 3);
});

test("cleanupStale honours custom names", async () => {
	const run = moduleRunner();
	const router = new LinuxAudioRouter({ run });

	assert.equal(await router.cleanupStale(["totally_different"]), 0);
	assert.equal(run.calls.some((call) => call.args[0] === "unload-module"), false);
	assert.equal(run.loaded.size, 3);
});

test("cleanupStale tolerates an unreadable module list", async () => {
	const run = moduleRunner({ listCode: 1 });
	const router = new LinuxAudioRouter({ run });
	assert.equal(await router.cleanupStale(), 0);
});

test("listOurModules ignores lines it cannot parse", async () => {
	const run = fakeRunner([
		respond(has("list", "modules"), {
			code: 0,
			stdout: [
				"",
				"garbage",
				"notanumber\tmodule-null-sink\tsink_name=screenroom_capture\t",
				"5\tmodule-loopback\tsource=screenroom_capture.monitor\t", // wrong module type
				"6\tmodule-null-sink\tsink_name=screenroom_capture\t", // ours
			].join("\n"),
		}),
	]);
	const router = new LinuxAudioRouter({ run });

	const found = await router.listOurModules();
	assert.deepEqual(found, [{ index: 6, name: "module-null-sink", args: "sink_name=screenroom_capture" }]);
});

// ---------------------------------------------------------------------------
// Device labels
// ---------------------------------------------------------------------------

test("a device label containing whitespace is refused, not silently truncated", async () => {
	// PipeWire parses source_properties by splitting on whitespace, so a label
	// with a space loses everything after it. That is exactly how the system tap
	// once ended up labelled identically to the application mic, while the
	// renderer searched for the full string and reported a vague
	// "audio source did not appear" from somewhere else entirely.
	const router = new LinuxAudioRouter({ run: healthyRunner() });

	await assert.rejects(
		() => router.createVirtualMic("screenroom_capture", "screenroom_mic", "MygleTV TV"),
		/whitespace/,
		"the virtual mic label must be rejected before PipeWire truncates it",
	);

	await assert.rejects(
		() => router.createSystemTap("screenroom_system", "MygleTV System"),
		/whitespace/,
		"the system tap label must be rejected too",
	);
});

test("a hyphenated label is accepted", async () => {
	// The guard must not be so eager that the real labels fail it.
	const run = healthyRunner([
		// createSystemTap confirms the source materialised before returning.
		respond(has("list", "sources"), {
			stdout: "1\tscreenroom_system\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n",
		}),
	]);
	const router = new LinuxAudioRouter({ run });

	const tap = await router.createSystemTap("screenroom_system", "MygleTV-System");
	assert.equal(tap.name, "screenroom_system");
});

