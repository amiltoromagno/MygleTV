// Linux per-application audio routing.
//
// PipeWire models every application's playback stream as its own node, so
// "capture one application's audio" is a *routing* problem rather than a
// capture problem: park the target stream on a private null-sink and record
// that sink's monitor.
//
// Routing is destructive -- once a stream moves to the null-sink the user stops
// hearing it. So every capture sink is paired with a loopback back to the real
// output. Without that loopback the user would share their game audio and hear
// nothing themselves, which is the exact flaw in the manual virtual-cable
// approach this replaces.
//
// The other half of the design is getting the state back. Anything this class
// changes is recorded and undone by restore(); restoreSync() exists so a crash
// or Ctrl-C cannot leave someone's sound stuck on a dead sink.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long any single pactl invocation may take before we give up on it. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Default name of the sink we create. Prefixed to avoid clashing with anything. */
export const DEFAULT_CAPTURE_SINK = "screenroom_capture";

/** Names that mark system plumbing as ours, for the stale sweep. */
export const DEFAULT_STALE_NAMES = [
	DEFAULT_CAPTURE_SINK,
	"screenroom_mic",
	"screenroom_system",
];

/** A remap depends on its master sink, so it has to be unloaded first. */
function rankModule(module) {
	return module.name === "module-remap-source" ? 0 : 1;
}

export class LinuxAudioError extends Error {
	constructor(message, detail) {
		super(message);
		this.name = "LinuxAudioError";
		this.detail = detail;
	}
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

/** Never throws: callers inspect `code` so failures stay recoverable. */
export async function defaultRun(cmd, args, { timeout = COMMAND_TIMEOUT_MS } = {}) {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			timeout,
			maxBuffer: 8 * 1024 * 1024,
			encoding: "utf8",
		});
		return { code: 0, stdout, stderr };
	} catch (err) {
		return {
			code: typeof err.code === "number" ? err.code : 1,
			stdout: err.stdout || "",
			stderr: err.stderr || String(err.message || err),
		};
	}
}

// ---------------------------------------------------------------------------
// pactl output parsing
//
// Both shapes are supported. Modern pactl (PulseAudio 15+, so anything on
// current Arch, Fedora, Ubuntu 22.04+) emits JSON, which is what we prefer;
// the text parser is the fallback for older systems and for anyone on a
// PulseAudio build without --format=json.
// ---------------------------------------------------------------------------

function pickAppName(properties) {
	if (!properties) return "Unknown";
	return (
		properties["application.name"] ||
		properties["application.process.binary"] ||
		properties["node.name"] ||
		properties["media.name"] ||
		"Unknown"
	);
}

export function parseSinkInputs(json) {
	if (!Array.isArray(json)) return [];
	return json.map((entry) => {
		const properties = entry.properties || {};
		const pid = Number(properties["application.process.id"]);
		return {
			index: entry.index,
			app: pickAppName(properties),
			mediaName: properties["media.name"] || "",
			binary: properties["application.process.binary"] || "",
			pid: Number.isFinite(pid) ? pid : null,
			sinkIndex: entry.sink,
			corked: entry.corked === true,
			mute: entry.mute === true,
		};
	});
}

/**
 * Parse `pactl list sink-inputs` text output.
 *
 * Shape per entry:
 *   Sink Input #2737
 *       Sink: 70
 *       Corked: no
 *       Properties:
 *           application.name = "Firefox"
 *           application.process.id = "1234"
 */
export function parseSinkInputsText(text) {
	const entries = [];
	const blocks = String(text).split(/^Sink Input #/m).slice(1);

	for (const block of blocks) {
		const header = block.match(/^(\d+)/);
		if (!header) continue;
		const index = Number(header[1]);

		const sinkMatch = block.match(/^\s*Sink:\s*(\d+)/m);
		const corkedMatch = block.match(/^\s*Corked:\s*(\w+)/m);
		const muteMatch = block.match(/^\s*Mute:\s*(\w+)/m);

		// Property values appear as:  key = "value"   (quotes are sometimes absent)
		const property = (key) => {
			const re = new RegExp(`^\\s*${key.replace(/\./g, "\\.")}\\s*=\\s*"?([^"\\n]*)"?\\s*$`, "m");
			const match = block.match(re);
			return match ? match[1] : "";
		};

		const pid = Number(property("application.process.id"));
		const properties = {
			"application.name": property("application.name"),
			"application.process.binary": property("application.process.binary"),
			"media.name": property("media.name"),
			"node.name": property("node.name"),
		};

		entries.push({
			index,
			app: pickAppName(properties),
			mediaName: properties["media.name"],
			binary: properties["application.process.binary"],
			pid: Number.isFinite(pid) && pid > 0 ? pid : null,
			sinkIndex: sinkMatch ? Number(sinkMatch[1]) : null,
			corked: corkedMatch ? corkedMatch[1] === "yes" : false,
			mute: muteMatch ? muteMatch[1] === "yes" : false,
		});
	}

	return entries;
}

export function parseSinks(json) {
	if (!Array.isArray(json)) return [];
	return json.map((sink) => ({
		index: sink.index,
		name: sink.name,
		description: (sink.properties && sink.properties["device.description"]) || sink.description || sink.name,
		state: sink.state || "",
	}));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class LinuxAudioRouter {
	/**
	 * @param {object} [options]
	 * @param {Function} [options.run]  injectable command runner, for tests
	 * @param {Function} [options.log]
	 */
	constructor({ run, log } = {}) {
		this.run = run || defaultRun;
		this.log = log || (() => {});

		/** Module ids we loaded, in load order; unloaded in reverse. */
		this.loadedModules = [];
		/** Sink inputs we moved, so we can put them back: {index, originalSink}. */
		this.movedStreams = [];
		/** Set by probe() so callers can report the environment. */
		this.environment = null;
		this.captureSink = null;
		this.virtualMic = null;
		this.systemTap = null;
	}

	async pactl(args) {
		return this.run("pactl", args);
	}

	async pactlJson(args) {
		const res = await this.pactl(["--format=json", ...args]);
		if (res.code !== 0) {
			throw new LinuxAudioError(`pactl ${args.join(" ")} failed`, res.stderr.trim());
		}
		try {
			return JSON.parse(res.stdout);
		} catch (err) {
			throw new LinuxAudioError(`could not parse pactl JSON for ${args.join(" ")}`, err.message);
		}
	}

	/** Detect the audio server and which tools are usable. */
	async probe() {
		const info = await this.pactl(["--format=json", "info"]);

		if (info.code !== 0) {
			// Either no JSON support or no server at all. Distinguish the two.
			const plain = await this.pactl(["info"]);
			if (plain.code !== 0) {
				throw new LinuxAudioError(
					"Could not reach a PulseAudio/PipeWire server. Is the audio service running?",
					plain.stderr.trim(),
				);
			}
			const serverName = (plain.stdout.match(/^Server Name:\s*(.+)$/m) || [])[1] || "unknown";
			const defaultSink = (plain.stdout.match(/^Default Sink:\s*(.+)$/m) || [])[1] || "";
			this.environment = {
				serverName,
				isPipeWire: /pipewire/i.test(serverName),
				defaultSink,
				jsonSupported: false,
				tool: "pactl",
			};
			return this.environment;
		}

		let parsed;
		try {
			parsed = JSON.parse(info.stdout);
		} catch (err) {
			throw new LinuxAudioError("could not parse pactl info output", err.message);
		}

		this.environment = {
			serverName: parsed.server_name || "unknown",
			isPipeWire: /pipewire/i.test(parsed.server_name || ""),
			pipeWireVersion: (parsed.server_name || "").match(/PipeWire ([\d.]+)/)?.[1] || null,
			defaultSink: parsed.default_sink_name || "",
			defaultSource: parsed.default_source_name || "",
			sampleSpec: parsed.default_sample_specification || "",
			jsonSupported: true,
			tool: "pactl",
		};
		return this.environment;
	}

	async listSinks() {
		if (this.environment && this.environment.jsonSupported === false) {
			return parseSinksText((await this.pactl(["list", "sinks"])).stdout);
		}
		return parseSinks(await this.pactlJson(["list", "sinks"]));
	}

	/** Applications currently producing audio, with their sink resolved to a name. */
	async listApps() {
		let entries;
		if (this.environment && this.environment.jsonSupported === false) {
			entries = parseSinkInputsText((await this.pactl(["list", "sink-inputs"])).stdout);
		} else {
			entries = parseSinkInputs(await this.pactlJson(["list", "sink-inputs"]));
		}

		let sinks = [];
		try {
			sinks = await this.listSinks();
		} catch {
			// Not fatal: the picker can still work with sink indices.
		}
		const byIndex = new Map(sinks.map((s) => [s.index, s]));

		return entries.map((entry) => {
			const sink = byIndex.get(entry.sinkIndex);
			return {
				...entry,
				sinkName: sink ? sink.name : null,
				sinkDescription: sink ? sink.description : null,
			};
		});
	}

	/**
	 * Poll until a sink or source with this exact name exists.
	 *
	 * A module can load and still not produce its node. Without this the only
	 * symptom is a vague "device did not appear" much later, in the renderer,
	 * with nothing to say which end failed.
	 */
	async waitForNode(kind, name, attempts = 30, delayMs = 80) {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const res = await this.pactl(["list", kind, "short"]);
			if (res.code === 0) {
				const found = res.stdout
					.split("\n")
					.some((line) => line.split("\t")[1] === name);
				if (found) return true;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		return false;
	}

	/**
	 * Create the private sink we capture from. Idempotent per instance.
	 * @returns {Promise<{id: number, name: string}>}
	 */
	async createCaptureSink(name = DEFAULT_CAPTURE_SINK) {
		if (this.captureSink) return this.captureSink;

		const res = await this.pactl([
			"load-module",
			"module-null-sink",
			`sink_name=${name}`,
			`sink_properties=device.description=ScreenRoom`,
			`rate=48000`,
			`channels=2`,
		]);

		if (res.code !== 0) {
			throw new LinuxAudioError("could not create the capture sink", res.stderr.trim());
		}
		const id = Number(res.stdout.trim());
		if (!Number.isFinite(id)) {
			throw new LinuxAudioError("pactl did not return a module id for the capture sink", res.stdout);
		}

		this.loadedModules.push(id);
		this.captureSink = { id, name };
		this.log(`created capture sink ${name} (module ${id})`);
		return this.captureSink;
	}
	/**
	 * Loop the capture sink back to the real output so the user keeps hearing
	 * the application they are sharing.
	 */
	async addMonitorReturn(sinkName, targetSink, latencyMs = 20) {
		if (!targetSink) return null;

		const res = await this.pactl([
			"load-module",
			"module-loopback",
			`source=${sinkName}.monitor`,
			`sink=${targetSink}`,
			`latency_msec=${latencyMs}`,
		]);

		if (res.code !== 0) {
			// A missing loopback means the user cannot hear their own audio, but
			// capture still works, so this is a warning rather than a failure.
			this.log(`warning: could not add monitor loopback: ${res.stderr.trim()}`);
			return null;
		}

		const id = Number(res.stdout.trim());
		if (Number.isFinite(id)) this.loadedModules.push(id);
		this.log(`monitor return ${sinkName}.monitor -> ${targetSink} (module ${id})`);
		return id;
	}

	/**
	 * Present the capture sink's monitor as a normal microphone input.
	 *
	 * Chromium hides `*.monitor` sources from enumerateDevices() -- verified
	 * against Chrome 148 on PipeWire 1.6.9, which listed only the real
	 * microphones. Handing the renderer a monitor name is therefore useless.
	 * module-remap-source wraps the monitor in a source that does not look like
	 * one, so getUserMedia can select it normally.
	 */
	async createVirtualMic(sinkName, sourceName, description = "ScreenRoom") {
		const res = await this.pactl([
			"load-module",
			"module-remap-source",
			`master=${sinkName}.monitor`,
			`source_name=${sourceName}`,
			`source_properties=device.description=${description}`,
		]);

		if (res.code !== 0) {
			throw new LinuxAudioError("could not create the virtual microphone", res.stderr.trim());
		}
		const id = Number(res.stdout.trim());
		if (!Number.isFinite(id)) {
			throw new LinuxAudioError("pactl did not return a module id for the virtual mic", res.stdout);
		}

		this.loadedModules.push(id);
		this.virtualMic = { id, name: sourceName };

		// Confirm the node exists before the renderer goes looking for it.
		if (!(await this.waitForNode("sources", sourceName))) {
			throw new LinuxAudioError(
				`module ${id} loaded but source "${sourceName}" never appeared`,
			);
		}

		this.log(`created virtual mic ${sourceName} (module ${id})`);
		return this.virtualMic;
	}

	/**
	 * Present the *default sink's* monitor as an input, without moving anything.
	 *
	 * This is the "whole system" option. Unlike the per-application route it is
	 * entirely non-destructive: no stream is moved and no loopback is needed,
	 * because the user carries on hearing everything exactly as before. It is a
	 * tap, not a detour.
	 */
	async createSystemTap(sourceName = "screenroom_system", description = "ScreenRoom System") {
		if (!this.environment) await this.probe();

		const res = await this.pactl([
			"load-module",
			"module-remap-source",
			`master=${this.environment.defaultSink}.monitor`,
			`source_name=${sourceName}`,
			`source_properties=device.description=${description}`,
		]);

		if (res.code !== 0) {
			throw new LinuxAudioError("could not tap the system output", res.stderr.trim());
		}
		const id = Number(res.stdout.trim());
		if (!Number.isFinite(id)) {
			throw new LinuxAudioError("pactl did not return a module id for the system tap", res.stdout);
		}

		this.loadedModules.push(id);
		this.systemTap = { id, name: sourceName };

		// A tap that loads but never materialises is exactly the failure that
		// surfaced as "the ScreenRoom System audio source did not appear" in the
		// renderer, with nothing pointing at the real cause.
		if (!(await this.waitForNode("sources", sourceName))) {
			throw new LinuxAudioError(
				`module ${id} loaded but source "${sourceName}" never appeared`,
			);
		}

		this.log(`tapped the system output as ${sourceName} (module ${id})`);
		return this.systemTap;
	}

	/** Move one application's stream onto the capture sink. */
	async routeApp(sinkInputIndex, sinkName) {
		const apps = await this.listApps();
		const app = apps.find((a) => a.index === sinkInputIndex);

		const res = await this.pactl(["move-sink-input", String(sinkInputIndex), sinkName]);
		if (res.code !== 0) {
			throw new LinuxAudioError(`could not move stream #${sinkInputIndex}`, res.stderr.trim());
		}

		// Remember the original sink so restore() can undo it.
		if (app && app.sinkIndex !== null && !this.movedStreams.some((m) => m.index === sinkInputIndex)) {
			this.movedStreams.push({ index: sinkInputIndex, originalSink: app.sinkIndex, app: app.app });
		}

		this.log(`routed "${app ? app.app : sinkInputIndex}" to ${sinkName}`);
		return app || null;
	}

	/** Device name a renderer can hand to getUserMedia. */
	monitorSourceName(sinkName = this.captureSink?.name || DEFAULT_CAPTURE_SINK) {
		return `${sinkName}.monitor`;
	}

	/**
	 * Modules that look like ours: a null-sink or remap-source whose arguments
	 * mention one of our names.
	 *
	 * The index has to come from the *text* listing. `pactl --format=json list
	 * modules` returns objects with only name/argument/usage_counter/properties
	 * -- there is no id in the JSON at all, so unloading "by index" from it
	 * silently does nothing.
	 */
	async listOurModules(names = DEFAULT_STALE_NAMES) {
		const res = await this.pactl(["list", "modules", "short"]);
		if (res.code !== 0) return [];

		const found = [];
		for (const line of res.stdout.split("\n")) {
			if (!line.trim()) continue;
			// "<index>\t<module-name>\t<argument>\t"
			const parts = line.split("\t");
			if (parts.length < 3) continue;

			const index = Number(parts[0]);
			const moduleName = parts[1];
			// The short listing ends each line with a trailing tab.
			const args = parts.slice(2).join(" ").trim();

			if (!Number.isFinite(index)) continue;
			if (!/^module-(null-sink|remap-source)$/.test(moduleName)) continue;
			if (!names.some((needle) => args.includes(needle))) continue;

			found.push({ index, name: moduleName, args });
		}
		return found;
	}

	/**
	 * Remove capture plumbing left behind by a previous run.
	 *
	 * A crash, a SIGKILL, or a laptop lid closing can leave the null-sink and
	 * remap-source loaded. That is not merely untidy: the stale "ScreenRoom"
	 * source then wins the renderer's device lookup on the next share, so the
	 * app captures a dead sink's monitor and sends silence -- with no error
	 * anywhere to explain it. Sweeping first makes capture robust to crashes.
	 */
	async cleanupStale(names = DEFAULT_STALE_NAMES) {
		const stale = await this.listOurModules(names);

		// Unload remaps before the sinks they depend on. Sorting explicitly rather
		// than reversing the listing, because PipeWire does not promise to list
		// modules in the order they were loaded.
		const ordered = [...stale].sort((a, b) => rankModule(a) - rankModule(b));

		let removed = 0;
		for (const module of ordered) {
			const out = await this.pactl(["unload-module", String(module.index)]);
			if (out.code === 0) {
				removed += 1;
				this.log(`removed stale ${module.name} (module ${module.index})`);
			} else {
				this.log(`warning: could not unload stale module ${module.index}`);
			}
		}

		// Confirm rather than trust: a malformed unload can exit 0 without doing
		// anything, which is how this went unnoticed the first time.
		const survivors = await this.listOurModules(names);
		if (survivors.length > 0) {
			this.log(`warning: ${survivors.length} stale module(s) survived the sweep`);
		}

		return removed;
	}

	/**
	 * Undo everything, in reverse order. Best-effort: a stream that disappeared
	 * (the app closed) is not an error worth throwing over.
	 */
	async restore() {
		const moved = this.movedStreams;
		const modules = this.loadedModules;
		this.movedStreams = [];
		this.loadedModules = [];
		this.captureSink = null;
		this.virtualMic = null;
		this.systemTap = null;

		for (const entry of moved.reverse()) {
			const res = await this.pactl([
				"move-sink-input",
				String(entry.index),
				String(entry.originalSink),
			]);
			if (res.code !== 0) {
				this.log(`note: could not restore stream #${entry.index} (it may have closed)`);
			}
		}

		for (const id of modules.reverse()) {
			const res = await this.pactl(["unload-module", String(id)]);
			if (res.code !== 0) {
				this.log(`warning: could not unload module ${id}: ${res.stderr.trim()}`);
			}
		}

		this.log("restored audio routing");
	}

	/**
	 * Synchronous variant for process-exit handlers, where promises will not be
	 * awaited. This is the safety net that stops a crash from leaving someone's
	 * sound routed to a sink that is about to disappear.
	 */
	restoreSync(execFileSyncImpl = execFileSync) {
		const moved = this.movedStreams;
		const modules = this.loadedModules;
		this.movedStreams = [];
		this.loadedModules = [];
		this.captureSink = null;
		this.virtualMic = null;
		this.systemTap = null;

		const attempt = (args) => {
			try {
				execFileSyncImpl("pactl", args, { timeout: 2000, stdio: "ignore" });
			} catch {
				/* best effort only */
			}
		};

		for (const entry of moved.reverse()) {
			attempt(["move-sink-input", String(entry.index), String(entry.originalSink)]);
		}
		for (const id of modules.reverse()) {
			attempt(["unload-module", String(id)]);
		}
	}
}

export function parseSinksText(text) {
	const sinks = [];
	const blocks = String(text).split(/^Sink #/m).slice(1);
	for (const block of blocks) {
		const index = Number((block.match(/^(\d+)/) || [])[1]);
		const name = (block.match(/^\s*Name:\s*(.+)$/m) || [])[1] || "";
		const description = (block.match(/^\s*Description:\s*(.+)$/m) || [])[1] || name;
		const state = (block.match(/^\s*State:\s*(\w+)/m) || [])[1] || "";
		if (Number.isFinite(index)) sinks.push({ index, name: name.trim(), description: description.trim(), state });
	}
	return sinks;
}

/**
 * Restore on exit. Returns a disposer so tests (and the app) can detach it.
 */
export function registerExitCleanup(router) {
	let done = false;
	const handler = () => {
		if (done) return;
		done = true;
		router.restoreSync();
	};

	process.on("exit", handler);
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) {
		process.on(signal, () => {
			handler();
			process.exit(signal === "SIGINT" ? 130 : 143);
		});
	}

	return () => {
		done = true;
		process.off("exit", handler);
		for (const signal of signals) process.removeAllListeners(signal);
	};
}
