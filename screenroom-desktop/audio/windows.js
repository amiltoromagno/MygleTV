import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const PCM_FORMAT = Object.freeze({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });

export function parseProcesses(raw) {
	const parsed = JSON.parse(raw || "[]");
	return (Array.isArray(parsed) ? parsed : [parsed])
		.filter((p) => Number.isInteger(p.Id) && p.Id > 0 && p.ProcessName)
		.map((p) => ({ id: String(p.Id), app: p.ProcessName, detail: p.MainWindowTitle || "", streams: 1 }))
		.sort((a, b) => a.app.localeCompare(b.app) || Number(a.id) - Number(b.id));
}

export async function listWindowProcesses() {
	const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
	const { stdout } = await run("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
		encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024,
	});
	return parseProcesses(stdout.trim()).filter((p) => Number(p.id) !== process.pid);
}

/** Resolve HWND owners without guessing from window titles. */
export async function resolveWindowAudio(sources, execute = run) {
	const handles = [...new Set(sources.map((source) => /^window:(\d+):\d+$/.exec(source.id)?.[1]).filter(Boolean))];
	if (!handles.length) return new Map();
	const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WindowAudioOwner { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint owner); }'; @(${handles.join(",")}) | ForEach-Object { $ownerId = [uint32]0; [void][WindowAudioOwner]::GetWindowThreadProcessId([IntPtr]([long]$_), [ref]$ownerId); if ($ownerId -gt 0) { [pscustomobject]@{handle=[string]$_; owner=[string]$ownerId} } } | ConvertTo-Json -Compress`;
	const { stdout } = await execute("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
	const parsed = JSON.parse(stdout.trim() || "[]");
	const owners = new Map((Array.isArray(parsed) ? parsed : [parsed]).filter((item) => /^\d+$/.test(item.owner) && Number(item.owner) > 0).map((item) => [String(item.handle), String(item.owner)]));
	return new Map(sources.map((source) => [source.id, owners.get(/^window:(\d+):\d+$/.exec(source.id)?.[1]) || null]));
}

/** Windows taps audio without changing the user's playback routing. */
export function createWindowsCaptureSession({
	loadModule = () => import("loopback-capture"),
	listProcesses = listWindowProcesses,
	release = os.release(), arch = process.arch,
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
			const build = Number(release.split(".")[2]);
			if (arch !== "x64") throw new Error("Windows audio capture currently requires x64.");
			if (!Number.isFinite(build) || build < 20348) throw new Error("Application audio capture requires Windows build 20348 or newer.");
			environment = { backend: "WASAPI", build, arch, ...PCM_FORMAT };
			return environment;
		},
		async listApplications() { await session.probe(); return listProcesses(); },
		async start(target) {
			if (!target || !["app", "system"].includes(target.mode)) throw new Error("Choose an application or system audio.");
			const pid = target.mode === "app" ? Number(target.app) : null;
			if (target.mode === "app" && (!/^\d+$/.test(String(target.app)) || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff)) throw new Error("Choose a valid application process.");
			await session.probe();
			await session.stop();
			const module = await loadModule();
			const Capture = module.default?.LoopbackCapture || module.LoopbackCapture;
			if (!Capture) throw new Error("The Windows audio module could not be loaded. Reinstall desktop dependencies.");
			const current = new Capture();
			const captureId = ++generation;
			capture = current;
			const deliver = (pcm) => {
				if (generation !== captureId || capture !== current || !Buffer.isBuffer(pcm) || pcm.length % 4 !== 0) return;
				onPcm({ captureId, pcm });
			};
			try {
				if (target.mode === "system") current.startSystemAudio(deliver);
				else current.start(pid, true, deliver);
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
