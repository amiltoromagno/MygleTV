import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

export const PCM_FORMAT = Object.freeze({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });

export function resolveHelperPath() {
	if (process.resourcesPath) {
		const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", "bin", "macos-audio-helper");
		if (fs.existsSync(unpacked)) return unpacked;
		const resourceBin = path.join(process.resourcesPath, "bin", "macos-audio-helper");
		if (fs.existsSync(resourceBin)) return resourceBin;
	}
	return path.resolve(__dirname, "..", "bin", "macos-audio-helper");
}

export function parseProcesses(raw) {
	const parsed = JSON.parse(raw || "[]");
	return (Array.isArray(parsed) ? parsed : [parsed])
		.filter((p) => Number.isInteger(p.Id) && p.Id > 0 && p.ProcessName)
		.map((p) => ({ id: String(p.Id), app: p.ProcessName, detail: p.MainWindowTitle || "", streams: 1 }))
		.sort((a, b) => a.app.localeCompare(b.app) || Number(a.id) - Number(b.id));
}

export async function listWindowProcesses(execute = run, helperPath = resolveHelperPath()) {
	const { stdout } = await execute(helperPath, ["--list-apps"], {
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 1024 * 1024,
	});
	return parseProcesses(stdout.trim()).filter((p) => Number(p.id) !== process.pid);
}

/** Resolve CGWindowID owners without guessing from window titles. */
export async function resolveWindowAudio(sources, execute = run, helperPath = resolveHelperPath()) {
	const handles = [...new Set(sources.map((source) => /^window:(\d+):\d+$/.exec(source.id)?.[1]).filter(Boolean))];
	if (!handles.length) return new Map();
	const { stdout } = await execute(helperPath, ["--resolve-windows", handles.join(",")], {
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 1024 * 1024,
	});
	const parsed = JSON.parse(stdout.trim() || "[]");
	const owners = new Map(
		(Array.isArray(parsed) ? parsed : [parsed])
			.filter((item) => /^\d+$/.test(item.owner) && Number(item.owner) > 0)
			.map((item) => [String(item.handle), String(item.owner)]),
	);
	return new Map(sources.map((source) => [source.id, owners.get(/^window:(\d+):\d+$/.exec(source.id)?.[1]) || null]));
}

export class ScreenCaptureKitLoopback {
	constructor({ helperPath = resolveHelperPath(), spawnImpl = spawn } = {}) {
		this.helperPath = helperPath;
		this.spawnImpl = spawnImpl;
		this.child = null;
		this.stopped = false;
	}

	async _launch(args, onChunk) {
		if (!fs.existsSync(this.helperPath)) {
			throw new Error("The macOS audio helper binary is missing. Run npm run build:helper.");
		}
		this.stopped = false;
		const child = this.spawnImpl(this.helperPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		let remainder = Buffer.alloc(0);
		child.stdout.on("data", (chunk) => {
			if (this.stopped || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
			const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
			const alignedLength = combined.length - (combined.length % 4);
			if (alignedLength > 0) {
				onChunk(combined.subarray(0, alignedLength));
			}
			remainder = alignedLength < combined.length ? Buffer.from(combined.subarray(alignedLength)) : Buffer.alloc(0);
		});

		await new Promise((resolve, reject) => {
			let stderrText = "";
			const timer = setTimeout(() => {
				cleanupListeners();
				this.stop();
				reject(new Error("Timed out starting ScreenCaptureKit audio capture."));
			}, 10000);

			const onStderr = (data) => {
				stderrText += data.toString("utf8");
				if (stderrText.includes("READY")) {
					cleanupListeners();
					resolve();
				}
			};
			const onError = (err) => {
				cleanupListeners();
				this.stop();
				reject(err);
			};
			const onExit = (code) => {
				cleanupListeners();
				const detail = stderrText.replace(/READY/g, "").trim();
				reject(new Error(detail || `macOS audio helper exited with code ${code}`));
			};
			const cleanupListeners = () => {
				clearTimeout(timer);
				child.stderr?.off("data", onStderr);
				child.off("error", onError);
				child.off("exit", onExit);
			};

			child.stderr.on("data", onStderr);
			child.once("error", onError);
			child.once("exit", onExit);
		});
	}

	async start(pid, _includeDescendants, onChunk) {
		return this._launch(["--capture-pid", String(pid)], onChunk);
	}

	async startSystemAudio(onChunk) {
		return this._launch(["--capture-system"], onChunk);
	}

	stop() {
		this.stopped = true;
		const child = this.child;
		this.child = null;
		if (!child) return;
		try { child.stdin?.end(); } catch { /* ignore */ }
		try { child.kill("SIGTERM"); } catch { /* already gone */ }
	}
}

/**
 * macOS taps application or system audio via ScreenCaptureKit without changing
 * the user's default output device or requiring a virtual audio driver.
 */
export function createMacosCaptureSession({
	loadModule = async () => ({ LoopbackCapture: ScreenCaptureKitLoopback }),
	listProcesses = listWindowProcesses,
	release = os.release(),
	arch = process.arch,
} = {}) {
	let capture = null;
	let generation = 0;
	let activeMode = null;
	let activeApp = null;
	let onPcm = () => {};
	let environment = null;

	function stopSync() {
		const old = capture;
		capture = null;
		generation++;
		activeMode = null;
		activeApp = null;
		if (old) old.stop();
	}

	const session = {
		get environment() { return environment; },
		get activeMode() { return activeMode; },
		get activeApp() { return activeApp; },
		isActive: () => capture !== null,
		setPcmHandler(handler) { onPcm = handler; },
		async probe() {
			// Darwin kernel 22.0.0 corresponds to macOS 13.0 (Ventura), where
			// ScreenCaptureKit audio capture (SCStreamConfiguration.capturesAudio) was introduced.
			const darwinMajor = Number(String(release).split(".")[0]);
			if (!["arm64", "x64"].includes(arch)) {
				throw new Error("macOS audio capture requires Apple Silicon (arm64) or Intel (x64).");
			}
			if (!Number.isFinite(darwinMajor) || darwinMajor < 22) {
				throw new Error("Application audio capture requires macOS 13.0 (Darwin 22) or newer.");
			}
			environment = { backend: "ScreenCaptureKit", darwinMajor, arch, ...PCM_FORMAT };
			return environment;
		},
		async listApplications() {
			await session.probe();
			return listProcesses();
		},
		async start(target) {
			if (!target || !["app", "system"].includes(target.mode)) {
				throw new Error("Choose an application or system audio.");
			}
			const pid = target.mode === "app" ? Number(target.app) : null;
			if (
				target.mode === "app" &&
				(!/^\d+$/.test(String(target.app)) || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff)
			) {
				throw new Error("Choose a valid application process.");
			}
			await session.probe();
			await session.stop();
			const module = await loadModule();
			const Capture = module.default?.LoopbackCapture || module.LoopbackCapture;
			if (!Capture) {
				throw new Error("The macOS audio module could not be loaded. Run npm run build:helper.");
			}
			const current = new Capture();
			const captureId = ++generation;
			capture = current;
			const deliver = (pcm) => {
				if (generation !== captureId || capture !== current || !Buffer.isBuffer(pcm) || pcm.length % 4 !== 0) return;
				onPcm({ captureId, pcm });
			};
			try {
				if (target.mode === "system") await current.startSystemAudio(deliver);
				else await current.start(pid, true, deliver);
				activeMode = target.mode;
				activeApp = pid === null ? null : String(pid);
				return { transport: "pcm", captureId, mode: activeMode, app: activeApp, ...PCM_FORMAT };
			} catch (err) {
				try { stopSync(); } catch { /* preserve startup error */ }
				throw err;
			}
		},
		async stop() { stopSync(); },
		restoreSync() { try { stopSync(); } catch { /* best effort at process exit */ } },
	};
	return session;
}

