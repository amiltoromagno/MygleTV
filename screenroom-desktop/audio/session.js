// The capture lifecycle, deliberately separate from Electron.
//
// main.js is left as a thin IPC shell so this sequencing -- set up, route,
// roll back on failure, tear down -- can be tested without launching a browser
// or touching a real sound server.

import { DEFAULT_CAPTURE_SINK } from "./linux.js";

export const VIRTUAL_MIC_NAME = "screenroom_mic";
export const VIRTUAL_MIC_LABEL = "MygleTV";

// The system tap is a separate source so its label is distinguishable from the
// application mic's.
//
// Neither label may contain a space. `source_properties` is parsed by splitting
// on whitespace, so a label like `ScreenRoom System` was silently truncated to
// just `ScreenRoom` -- which then collided with the mic's label, while the
// renderer was searching for the full string and failed with "the ScreenRoom
// System audio source did not appear". Escaping the space, quoting the value and
// quoting the whole property all truncate identically, so the labels are
// hyphenated instead, and linux.js now rejects a label containing whitespace
// outright rather than letting it truncate in silence.
export const SYSTEM_TAP_NAME = "screenroom_system";
export const SYSTEM_TAP_LABEL = "MygleTV-System";

/**
 * @param {object} options
 * @param {import("./linux.js").LinuxAudioRouter} options.router
 * @param {string} [options.sinkName]
 * @param {string} [options.micName]
 * @param {string} [options.micLabel]  label the renderer looks for
 * @param {string} [options.systemName]
 * @param {string} [options.systemLabel]
 */
export function createCaptureSession({
	router,
	sinkName = DEFAULT_CAPTURE_SINK,
	micName = VIRTUAL_MIC_NAME,
	micLabel = VIRTUAL_MIC_LABEL,
	systemName = SYSTEM_TAP_NAME,
	systemLabel = SYSTEM_TAP_LABEL,
	log = () => {},
}) {
	let activeApp = null;
	let activeMode = null;

	/** True when anything has been changed on the system and needs undoing. */
	function isActive() {
		return router.loadedModules.length > 0 || router.movedStreams.length > 0;
	}

	async function listApps() {
		if (!router.environment) await router.probe();
		return router.listApps();
	}

	async function listApplications() {
		return groupByApplication(await listApps());
	}

	/** Just one application: needs a private sink, a loopback and routing. */
	async function startAppCapture(appName) {
		const sink = await router.createCaptureSink(sinkName);
		await router.createVirtualMic(sink.name, micName, micLabel);
		await router.addMonitorReturn(sink.name, router.environment.defaultSink);

		const apps = await router.listApps();
		const needle = String(appName || "").toLowerCase();

		// An application can own several streams at once -- Firefox with two tabs
		// playing, say. Moving only the first would leave the rest on the
		// speakers, so the listener would receive part of the audio while the
		// sharer still heard the remainder.
		const targets = apps.filter((entry) => entry.app.toLowerCase() === needle);
		if (targets.length === 0) {
			throw new Error(`"${appName}" is not playing audio right now`);
		}

		for (const target of targets) {
			await router.routeApp(target.index, sink.name);
		}

		return {
			mode: "app",
			app: targets[0].app,
			deviceLabel: micLabel,
			streams: targets.length,
		};
	}

	/**
	 * Everything the machine is playing. Nothing is moved, so no loopback is
	 * needed and the user keeps hearing the output exactly as before.
	 */
	async function startSystemCapture() {
		await router.createSystemTap(systemName, systemLabel);
		return { mode: "system", app: null, deviceLabel: systemLabel };
	}

	return {
		get activeApp() {
			return activeApp;
		},
		get activeMode() {
			return activeMode;
		},
		isActive,
		listApps,
		listApplications,

		/**
		 * Start capturing audio.
		 *
		 * Two modes, matching the only two things a person actually wants:
		 *   { mode: "app", app: "Firefox" }  just that application
		 *   { mode: "system" }               everything the machine is playing
		 *
		 * A bare string is accepted as an application name for convenience.
		 *
		 * A failure at *any* step restores the router before the error escapes.
		 * Otherwise a half-finished setup would leave the application's audio
		 * routed into a sink the user cannot hear -- silent game, no explanation.
		 */
		async start(target) {
			const wanted = normalizeTarget(target);

			try {
				await router.probe();

				// Clear anything a previous run left behind before adding our own,
				// or the stale source would shadow the one we are about to create.
				await router.cleanupStale([sinkName, micName, systemName]);

				const result =
					wanted.mode === "system"
						? await startSystemCapture()
						: await startAppCapture(wanted.app);

				activeMode = result.mode;
				activeApp = result.app || null;
				log(
					result.mode === "system"
						? "capturing the whole system output"
						: `capturing "${result.app}" (${result.streams} stream${result.streams === 1 ? "" : "s"})`,
				);

				return result;
			} catch (err) {
				try {
					await router.restore();
				} catch {
					// Surface the original failure, not the cleanup's.
				}
				activeApp = null;
				activeMode = null;
				throw err;
			}
		},

		async stop() {
			await router.restore();
			activeApp = null;
			activeMode = null;
		},
	};
}

function normalizeTarget(target) {
	if (typeof target === "string") return { mode: "app", app: target };
	if (target && typeof target === "object") {
		return { mode: target.mode === "system" ? "system" : "app", app: target.app || null };
	}
	return { mode: "app", app: null };
}

/**
 * Collapse raw PipeWire streams into one entry per application.
 *
 * A picker offering three identical "Firefox" rows is useless, and a stream
 * index means nothing to a person -- what they choose is an application.
 */
export function groupByApplication(apps) {
	const grouped = new Map();

	for (const entry of apps || []) {
		if (!entry || !entry.app) continue;
		const key = entry.app.toLowerCase();
		const existing = grouped.get(key);
		if (existing) {
			existing.streams += 1;
		} else {
			grouped.set(key, { app: entry.app, streams: 1 });
		}
	}

	return [...grouped.values()].sort((a, b) => a.app.localeCompare(b.app));
}
