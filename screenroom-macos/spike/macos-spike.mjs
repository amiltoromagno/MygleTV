#!/usr/bin/env node
//
// macOS audio spike (ScreenCaptureKit).
//
//   npm run spike:macos -- --list
//   npm run spike:macos -- --tone          self-test, no game needed
//   npm run spike:macos -- --pid 1234      capture one process
//   npm run spike:macos -- --system        capture everything
//
// Verifies that ScreenCaptureKit delivers real 48 kHz 16-bit stereo PCM audio
// on this Mac without rerouting the user's speakers or installing a virtual
// audio driver.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { listWindowProcesses, resolveHelperPath, ScreenCaptureKitLoopback } from "../audio/macos.js";

const RATE = 48_000;
const CHANNELS = 2;

const args = process.argv.slice(2);
const opts = {
	list: args.includes("--list"),
	tone: args.includes("--tone"),
	system: args.includes("--system"),
	seconds: args.includes("--seconds") ? Number(args[args.indexOf("--seconds") + 1]) : 4,
	pid: args.includes("--pid") ? Number(args[args.indexOf("--pid") + 1]) : null,
	name: args.includes("--name") ? args[args.indexOf("--name") + 1] : null,
	out: args.includes("--out") ? args[args.indexOf("--out") + 1] : null,
};

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function writeTone({ seconds = 20, freq = 440 } = {}) {
	const frames = seconds * RATE;
	const data = Buffer.alloc(frames * CHANNELS * 2);
	for (let i = 0; i < frames; i++) {
		const on = Math.floor(i / RATE) % 2 === 0;
		const value = on ? Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.4 * 32767) : 0;
		data.writeInt16LE(value, i * 4);
		data.writeInt16LE(value, i * 4 + 2);
	}
	const file = path.join(os.tmpdir(), `screenroom-macos-tone-${Date.now()}.wav`);
	fs.writeFileSync(file, wrapAsWav(data));
	return file;
}

if (process.platform !== "darwin") {
	console.log(red(`\nThis spike only runs on macOS (detected: ${process.platform}).`));
	console.log(dim("ScreenCaptureKit audio capture does not exist on Linux or Windows."));
	process.exit(2);
}

console.log(bold("\nmacOS audio spike (ScreenCaptureKit)\n"));
console.log(`  node      ${process.version}`);
console.log(`  platform  ${process.platform} ${os.release()} (${process.arch})`);

const helperPath = resolveHelperPath();
if (!fs.existsSync(helperPath)) {
	console.log(red("\nbin/macos-audio-helper is not built."));
	console.log(dim("  npm run build:helper"));
	process.exit(1);
}
console.log(`  helper    ${green("macos-audio-helper ready")}`);

if (opts.list) {
	const processes = await listWindowProcesses();
	console.log(bold(`\nApplications (${processes.length})`));
	for (const p of processes) {
		console.log(`  ${String(p.id).padEnd(8)} ${p.app.padEnd(28)} ${dim(p.detail)}`);
	}
	console.log(dim("\nPick the one making noise, then:  npm run spike:macos -- --pid <id>"));
	process.exit(0);
}

let targetPid = opts.pid;
let toneFile = null;
let toneProcess = null;

if (opts.tone) {
	toneFile = writeTone({ seconds: Math.ceil(opts.seconds + 6) });
	toneProcess = spawn("/usr/bin/afplay", [toneFile], { stdio: "ignore" });
	process.on("exit", () => {
		try { toneProcess.kill(); } catch { /* already gone */ }
		try { fs.unlinkSync(toneFile); } catch { /* already removed */ }
	});
	await sleep(300);
	targetPid = toneProcess.pid;
	console.log(`  generated tone in afplay process ${targetPid}`);
}

if (opts.name) {
	const processes = await listWindowProcesses();
	const match = processes.find((p) => p.app.toLowerCase().includes(opts.name.toLowerCase()));
	if (!match) {
		console.log(red(`\nNo application matching "${opts.name}".`));
		process.exit(1);
	}
	targetPid = Number(match.id);
	console.log(dim(`  matched "${match.app}" (pid ${match.id})`));
}

if (!opts.system && !targetPid) {
	console.log(red("\nNothing to capture. Pass --list, --tone, --system, --pid <id> or --name <app>."));
	process.exit(1);
}

const captured = [];
const capture = new ScreenCaptureKitLoopback();
const onChunk = (chunk) => {
	if (Buffer.isBuffer(chunk)) captured.push(Buffer.from(chunk));
};

try {
	if (opts.system) {
		console.log(bold("\nCapturing the whole system output"));
		await capture.startSystemAudio(onChunk);
	} else {
		console.log(bold(`\nCapturing process ${targetPid}`));
		await capture.start(targetPid, true, onChunk);
	}
} catch (err) {
	console.log(red(`\nFailed to start capture: ${err.message}`));
	console.log(dim("Ensure Screen Recording / Audio Capture permission is granted to your terminal or MygleTV in System Settings > Privacy & Security."));
	process.exit(1);
}

console.log(dim(`  recording for ${opts.seconds}s...`));
await sleep(opts.seconds * 1000);

capture.stop();
await sleep(200);

const pcm = Buffer.concat(captured);
const stats = analysePcm(pcm);
const outFile = opts.out || path.join(os.tmpdir(), `screenroom-macos-capture-${Date.now()}.wav`);

console.log(bold("\nResult"));
console.log(`  chunks          ${captured.length}`);
console.log(`  captured        ${stats.seconds.toFixed(2)}s (${stats.samples} samples)`);
console.log(`  peak            ${stats.peak} / 32767`);
console.log(`  RMS             ${stats.rms.toFixed(1)}`);
console.log(`  above silence   ${(stats.nonSilentRatio * 100).toFixed(1)}% of samples`);

if (pcm.length > 0) {
	fs.writeFileSync(outFile, wrapAsWav(pcm));
	console.log(`  file            ${outFile}`);
}

const heard = stats.peak > 200 && stats.nonSilentRatio > 0.02;
if (heard) {
	console.log(green("\nPASS -- ScreenCaptureKit delivered real audio."));
} else if (captured.length === 0) {
	console.log(red("\nFAIL -- no audio was delivered at all."));
	console.log(dim("Check Screen Recording permission in System Settings > Privacy & Security."));
} else {
	console.log(red("\nFAIL -- chunks arrived but they were silent."));
	console.log(dim("Usually the wrong process or nothing playing: pick the one with audio, or try --tone / --system."));
}

process.exit(heard ? 0 : 1);

