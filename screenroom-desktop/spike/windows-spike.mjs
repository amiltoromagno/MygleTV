#!/usr/bin/env node
//
// Windows audio spike.
//
//   npm install loopback-capture
//   node spike/windows-spike.mjs --list
//   node spike/windows-spike.mjs --tone          self-test, no game needed
//   node spike/windows-spike.mjs --pid 1234      capture one process
//   node spike/windows-spike.mjs --system        capture everything
//
// This exists to answer one question before anything is built on top of it:
// does WASAPI process loopback actually deliver that application's audio on
// this machine? Everything else in the Windows port depends on the answer.
//
// Nothing here is destructive. Process loopback taps an application's audio
// without moving it, so you keep hearing the game normally -- unlike the Linux
// route, which has to reroute a stream and loop it back.
//
// Run this on Windows. It will not work anywhere else.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const RATE = 48_000;
const CHANNELS = 2;

const args = process.argv.slice(2);
const opts = {
	list: args.includes("--list"),
	tone: args.includes("--tone"),
	system: args.includes("--system"),
	seconds: args.includes("--seconds") ? Number(args[args.indexOf("--seconds") + 1]) : 6,
	pid: args.includes("--pid") ? Number(args[args.indexOf("--pid") + 1]) : null,
	name: args.includes("--name") ? args[args.indexOf("--name") + 1] : null,
	out: args.includes("--out") ? args[args.indexOf("--out") + 1] : null,
};

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

function analysePcm(buffer) {
	const samples = Math.floor(buffer.length / 2);
	if (samples === 0) return { samples: 0, seconds: 0, peak: 0, rms: 0, nonSilentRatio: 0 };

	let peak = 0;
	let sumSquares = 0;
	let nonSilent = 0;

	for (let i = 0; i < samples; i++) {
		const value = buffer.readInt16LE(i * 2);
		const magnitude = Math.abs(value);
		if (magnitude > peak) peak = magnitude;
		sumSquares += value * value;
		if (magnitude > 64) nonSilent++;
	}

	return {
		samples,
		seconds: samples / (RATE * CHANNELS),
		peak,
		rms: Math.sqrt(sumSquares / samples),
		nonSilentRatio: nonSilent / samples,
	};
}

function wrapAsWav(pcm) {
	const header = Buffer.alloc(44);
	const byteRate = RATE * CHANNELS * 2;
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(RATE, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(CHANNELS * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

function writeTone({ seconds = 30, freq = 440 } = {}) {
	const frames = seconds * RATE;
	const data = Buffer.alloc(frames * CHANNELS * 2);
	for (let i = 0; i < frames; i++) {
		// Gated on/off so the recording has obvious structure.
		const on = Math.floor(i / RATE) % 2 === 0;
		const value = on ? Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.4 * 32767) : 0;
		data.writeInt16LE(value, i * 4);
		data.writeInt16LE(value, i * 4 + 2);
	}
	const file = path.join(os.tmpdir(), `screenroom-tone-${Date.now()}.wav`);
	fs.writeFileSync(file, wrapAsWav(data));
	return file;
}

// ---------------------------------------------------------------------------
// Listing candidate applications
// ---------------------------------------------------------------------------

/**
 * Applications that plausibly produce audio: anything with a window title.
 *
 * This is deliberately crude. The proper API is IAudioSessionManager2, which is
 * what the Windows volume mixer uses, and it would list only things actually
 * playing. That needs native code of its own, so the first version of the picker
 * lists windows and lets the user choose -- the wrong choice is immediately
 * obvious, because the capture is silent.
 */
function listCandidateProcesses() {
	if (process.platform !== "win32") return [];

	try {
		const raw = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				"Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | " +
					"Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress",
			],
			{ encoding: "utf8", timeout: 20_000 },
		).trim();

		if (!raw) return [];
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed) ? parsed : [parsed];
		return list.map((p) => ({
			pid: p.Id,
			name: p.ProcessName,
			title: p.MainWindowTitle,
		}));
	} catch (err) {
		console.log(dim(`  (process listing failed: ${err.message})`));
		return [];
	}
}

// ---------------------------------------------------------------------------

if (process.platform !== "win32") {
	console.log(red(`\nThis spike only runs on Windows (detected: ${process.platform}).`));
	console.log(dim("WASAPI process loopback does not exist on Linux or macOS."));
	process.exit(2);
}

console.log(bold("\nWindows audio spike\n"));
console.log(`  node      ${process.version}`);
console.log(`  platform  ${process.platform} ${os.release()}`);

// --- is the native module usable at all? ---------------------------------
let loopback = null;
try {
	loopback = (await import("loopback-capture")).default;
} catch (err) {
	try {
		const { createRequire } = await import("node:module");
		loopback = createRequire(import.meta.url)("loopback-capture");
	} catch {
		console.log(red("\nloopback-capture is not installed."));
		console.log(dim("  npm install loopback-capture"));
		console.log(
			dim(
				"\nIf the install fails, that is the answer for now: the native module has no\n" +
					"prebuilt for this Node/Electron version, and the Windows port would need it\n" +
					"built from source (CMake, MSVC, Windows SDK).",
			),
		);
		process.exit(1);
	}
}

console.log(`  module    ${green("loopback-capture loaded")}`);

// --- list mode ------------------------------------------------------------
if (opts.list) {
	const processes = listCandidateProcesses();
	console.log(bold(`\nApplications with a window (${processes.length})`));
	for (const p of processes) {
		console.log(`  ${String(p.pid).padEnd(8)} ${p.name.padEnd(28)} ${dim(p.title)}`);
	}
	console.log(
		dim(
			"\nPick the one making noise, then:  node spike/windows-spike.mjs --pid <id>",
		),
	);
	process.exit(0);
}

// --- choose a target ------------------------------------------------------
let targetPid = opts.pid;
let toneFile = null;
let toneProcess = null;

if (opts.tone) {
	toneFile = writeTone({ seconds: Math.ceil(opts.seconds + 10) });
	const script = `$player = New-Object System.Media.SoundPlayer '${toneFile.replaceAll("'", "''")}'; $player.Load(); Write-Output 'READY'; $player.PlaySync()`;
	toneProcess = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
	process.on("exit", () => {
		toneProcess.kill();
		try { fs.unlinkSync(toneFile); } catch { /* already removed */ }
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Tone player did not start")), 15_000);
		toneProcess.stdout.on("data", (data) => {
			if (data.toString().includes("READY")) { clearTimeout(timer); resolve(); }
		});
		toneProcess.on("error", (err) => { clearTimeout(timer); reject(err); });
		toneProcess.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Tone player exited: ${code}`)); });
	});
	targetPid = toneProcess.pid;
	console.log(`  generated tone in process ${targetPid}`);
}

if (opts.name) {
	const match = listCandidateProcesses().find((p) =>
		p.name.toLowerCase().includes(opts.name.toLowerCase()),
	);
	if (!match) {
		console.log(red(`\nNo window process matching "${opts.name}".`));
		process.exit(1);
	}
	targetPid = match.pid;
	console.log(dim(`  matched "${match.title}" (pid ${match.pid})`));
}

if (!opts.system && !targetPid) {
	console.log(red("\nNothing to capture. Pass --list, --system, --pid <id> or --name <app>."));
	process.exit(1);
}

// --- capture --------------------------------------------------------------
const captured = [];
const capture = new loopback.LoopbackCapture();

const onChunk = (chunk) => {
	if (Buffer.isBuffer(chunk)) captured.push(chunk);
};

try {
	if (opts.system) {
		console.log(bold("\nCapturing the whole system output"));
		capture.startSystemAudio(onChunk);
	} else {
		console.log(bold(`\nCapturing process ${targetPid}`));
		// includeDescendants: games routinely spawn child processes that hold the
		// audio, so capturing only the parent yields silence.
		capture.start(targetPid, true, onChunk);
	}
} catch (err) {
	console.log(red(`\nFailed to start capture: ${err.message}`));
	process.exit(1);
}

console.log(dim(`  recording for ${opts.seconds}s...`));
await sleep(opts.seconds * 1000);

try {
	capture.stop();
} catch {
	/* already stopped */
}
await sleep(400);

// --- result ---------------------------------------------------------------
const pcm = Buffer.concat(captured);
const stats = analysePcm(pcm);
const outFile = opts.out || path.join(os.tmpdir(), `screenroom-capture-${Date.now()}.wav`);

console.log(bold("\nResult"));
console.log(`  chunks          ${captured.length}`);
console.log(`  captured        ${stats.seconds.toFixed(2)}s (${stats.samples} samples)`);
console.log(`  peak            ${stats.peak} / 32767`);
console.log(`  RMS             ${stats.rms.toFixed(1)}`);
console.log(`  above silence   ${(stats.nonSilentRatio * 100).toFixed(1)}% of samples`);

if (pcm.length > 0) {
	fs.writeFileSync(outFile, wrapAsWav(pcm));
	console.log(`  file            ${outFile}`);
	console.log(dim(`                  play it to confirm it is the right application`));
}

const heard = stats.peak > 200 && stats.nonSilentRatio > 0.02;
if (heard) {
	console.log(green("\nPASS -- WASAPI loopback delivered real audio."));
	console.log(dim("The Windows port is viable. Everything else is plumbing."));
} else if (captured.length === 0) {
	console.log(red("\nFAIL -- no audio was delivered at all."));
	console.log(
		dim(
			"The module loaded but produced nothing. Check: was the target actually\n" +
				"playing sound? Process loopback requires Windows build 20348 or newer.\n",
		),
	);
} else {
	console.log(red("\nFAIL -- chunks arrived but they were silent."));
	console.log(dim("Usually the wrong process: pick the one with the audio, or try --system."));
}

process.exit(heard ? 0 : 1);
