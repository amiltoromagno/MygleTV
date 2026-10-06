#!/usr/bin/env node
//
// Linux per-application audio spike.
//
// Proves the whole routing chain on a real machine:
//
//   probe -> create private sink -> route one app's stream -> record the sink
//   monitor -> confirm real audio was captured -> put everything back
//
// Usage:
//   node spike/linux-spike.mjs --list              environment + what's playing
//   node spike/linux-spike.mjs --tone              self-test with a generated tone
//   node spike/linux-spike.mjs --app firefox       route an app by name
//   node spike/linux-spike.mjs                     interactive picker
//
// Options: --seconds N (default 6), --sink-name NAME, --keep-raw
//
// The tone mode exists so this can be verified without disturbing whatever the
// user is actually listening to.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";

import {
	DEFAULT_CAPTURE_SINK,
	LinuxAudioRouter,
	registerExitCleanup,
} from "../audio/linux.js";

const RATE = 48_000;
const CHANNELS = 2;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const opts = { seconds: 6, sinkName: DEFAULT_CAPTURE_SINK, keepRaw: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--list") opts.list = true;
		else if (arg === "--tone") opts.tone = true;
		else if (arg === "--keep-raw") opts.keepRaw = true;
		else if (arg === "--seconds") opts.seconds = Number(argv[++i]);
		else if (arg === "--sink-name") opts.sinkName = argv[++i];
		else if (arg === "--app") opts.app = argv[++i];
		else if (arg === "--crash") opts.crash = true;
		else if (arg === "--help" || arg === "-h") opts.help = true;
	}
	return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
	console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 18).join("\n").replace(/^\/\/ ?/gm, ""));
	process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// ---------------------------------------------------------------------------
// raw audio helpers -- parecord writes headerless PCM, which sidesteps the
// half-written WAV header problem when we stop a recording mid-stream.
// ---------------------------------------------------------------------------

function analyzeRawPcm(buffer) {
	const samples = Math.floor(buffer.length / 2);
	if (samples === 0) return { samples: 0, peak: 0, rms: 0, nonSilentRatio: 0 };

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
		peak,
		rms: Math.sqrt(sumSquares / samples),
		nonSilentRatio: nonSilent / samples,
		seconds: samples / (RATE * CHANNELS),
	};
}

function wrapAsWav(pcm, { rate = RATE, channels = CHANNELS } = {}) {
	const header = Buffer.alloc(44);
	const byteRate = rate * channels * 2;
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

function writeToneWav(filePath, { seconds = 30, freq = 440 } = {}) {
	const frames = seconds * RATE;
	const data = Buffer.alloc(frames * CHANNELS * 2);
	for (let i = 0; i < frames; i++) {
		// Gated on/off so the recording contains obvious structure, not a wall of tone.
		const on = Math.floor(i / RATE) % 2 === 0;
		const value = on ? Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.4 * 32767) : 0;
		data.writeInt16LE(value, i * 4);
		data.writeInt16LE(value, i * 4 + 2);
	}
	fs.writeFileSync(filePath, wrapAsWav(data));
	return filePath;
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

function recordRaw(device, seconds, outPath) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"parecord",
			[
				`--device=${device}`,
				"--raw",
				"--format=s16le",
				`--rate=${RATE}`,
				`--channels=${CHANNELS}`,
				outPath,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);

		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", reject);

		const timer = setTimeout(() => child.kill("SIGINT"), seconds * 1000);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && code !== null && !fs.existsSync(outPath)) {
				reject(new Error(`parecord failed (${code}): ${stderr.trim()}`));
				return;
			}
			resolve({ stderr: stderr.trim() });
		});
	});
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

const createdFiles = [];
function tempFile(name) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sr-spike-")), name);
	createdFiles.push(file);
	return file;
}

function cleanupFiles(keepRaw) {
	for (const file of createdFiles) {
		if (keepRaw && file.endsWith(".wav")) continue;
		try {
			fs.unlinkSync(file);
		} catch {
			/* ignore */
		}
	}
}

function printEnvironment(env) {
	console.log(bold("\nAudio server"));
	console.log(`  server          ${env.serverName}`);
	console.log(`  PipeWire        ${env.isPipeWire ? green(`yes (${env.pipeWireVersion || "version unknown"})`) : yellow("no -- PulseAudio only")}`);
	console.log(`  pactl --format=json  ${env.jsonSupported ? green("supported") : yellow("not supported, using text parsing")}`);
	console.log(`  default sink    ${env.defaultSink || dim("(none)")}`);
	console.log(`  sample spec     ${env.sampleSpec || dim("(unknown)")}`);
}

function printApps(apps) {
	console.log(bold(`\nApplications currently producing audio (${apps.length})`));
	if (apps.length === 0) {
		console.log(dim("  none -- start playing something, or use --tone"));
		return;
	}
	for (const app of apps) {
		const detail = [app.binary, app.pid ? `pid ${app.pid}` : null, app.corked ? "paused" : null]
			.filter(Boolean)
			.join(", ");
		console.log(`  #${String(app.index).padEnd(5)} ${app.app.padEnd(22)} ${dim(detail)}`);
		console.log(`        ${dim(`on ${app.sinkDescription || app.sinkName || "unknown sink"}`)}`);
	}
}

async function pickApp(apps, requested) {
	if (requested) {
		const needle = requested.toLowerCase();
		const match = apps.find(
			(a) =>
				a.app.toLowerCase().includes(needle) ||
				a.binary.toLowerCase().includes(needle) ||
				a.mediaName.toLowerCase().includes(needle),
		);
		if (!match) throw new Error(`no audio stream matching "${requested}"`);
		return match;
	}

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question("\nWhich stream should we capture? [number] ");
		const index = Number(answer.trim().replace(/^#/, ""));
		const match = apps.find((a) => a.index === index);
		if (!match) throw new Error(`no stream numbered ${answer.trim()}`);
		return match;
	} finally {
		rl.close();
	}
}

async function startTone() {
	const tonePath = tempFile("tone.wav");
	writeToneWav(tonePath, { seconds: 60 });

	const player = spawn("pw-play", [tonePath], { stdio: ["ignore", "ignore", "pipe"] });
	let failed = false;
	player.on("error", () => {
		failed = true;
	});

	await sleep(700);
	if (failed || player.exitCode !== null) {
		throw new Error("could not start pw-play (is pipewire-audio / pipewire-utils installed?)");
	}
	return { player, tonePath, pid: player.pid };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
	const router = new LinuxAudioRouter({
		log: (message) => console.log(dim(`  . ${message}`)),
	});
	const detach = registerExitCleanup(router);

	let tone = null;
	let restoreNeeded = false;

	try {
		const env = await router.probe();
		printEnvironment(env);

		let apps = await router.listApps();
		printApps(apps);

		if (opts.list) return 0;

		let target = null;

		if (opts.tone) {
			console.log(dim("\nStarting a test tone to capture..."));
			tone = await startTone();
			await sleep(700);
			apps = await router.listApps();

			// PipeWire does not reliably expose application.process.id -- pw-play
			// reports none at all, while Chromium and Firefox do. So match on the
			// stream's media name rather than a PID. The real picker has to work
			// the same way.
			target =
				apps.find((a) => a.mediaName === tone.tonePath) ||
				apps.find((a) => a.mediaName.includes(path.basename(tone.tonePath))) ||
				apps.find((a) => a.app === "pw-play" || a.app === "pw-record");

			if (!target) {
				throw new Error("the test tone is playing but no matching stream appeared");
			}
			console.log(bold("\nTest tone detected as:"));
			printApps([target]);
		}

		if (!target) {
			if (apps.length === 0) {
				console.log(red("\nNothing is producing audio, so there is nothing to capture."));
				console.log(dim("Run with --tone to self-test, or start playing something."));
				return 1;
			}
			target = await pickApp(apps, opts.app);
		}

		console.log(bold(`\nRouting "${target.app}" (stream #${target.index})`));
		restoreNeeded = true;

		await router.createCaptureSink(opts.sinkName);
		await router.addMonitorReturn(opts.sinkName, env.defaultSink);
		await router.routeApp(target.index, opts.sinkName);

		// Exercises the exit-cleanup safety net: the whole point is that a crash
		// mid-share must not leave the user's audio stuck on a sink we created.
		if (opts.crash) {
			console.log(dim("  . simulating a crash now -- the exit handler must restore audio"));
			process.kill(process.pid, "SIGINT");
			await sleep(3000);
			throw new Error("crash simulation did not terminate the process");
		}

		const device = router.monitorSourceName(opts.sinkName);
		console.log(dim(`  . recording ${opts.seconds}s from ${device}`));

		// Give the moved stream a moment to settle before recording.
		await sleep(600);

		const rawPath = tempFile("capture.raw");
		await recordRaw(device, opts.seconds, rawPath);

		const pcm = fs.readFileSync(rawPath);
		const stats = analyzeRawPcm(pcm);

		const wavPath = rawPath.replace(/\.raw$/, ".wav");
		fs.writeFileSync(wavPath, wrapAsWav(pcm));
		createdFiles.push(wavPath);

		console.log(bold("\nCapture result"));
		console.log(`  recorded        ${stats.seconds.toFixed(2)}s (${stats.samples} samples)`);
		console.log(`  peak            ${stats.peak} / 32767`);
		console.log(`  RMS             ${stats.rms.toFixed(1)}`);
		console.log(`  above silence   ${(stats.nonSilentRatio * 100).toFixed(1)}% of samples`);

		const heardAudio = stats.peak > 200 && stats.nonSilentRatio > 0.05;

		console.log(`  file            ${wavPath}`);
		console.log(dim(`                  play it with: pw-play ${wavPath}`));

		if (heardAudio) {
			console.log(green("\nPASS -- real audio was captured from a single application."));
		} else {
			console.log(red("\nFAIL -- the recording is silent."));
			console.log(dim("Check that the app was actually making noise during the recording."));
		}

		return heardAudio ? 0 : 1;
	} catch (err) {
		console.log(red(`\nFAIL -- ${err.message}`));
		if (err.detail) console.log(dim(`  ${err.detail}`));
		return 1;
	} finally {
		// Put the audio back before stopping our own tone, so the restore path we
		// exercise is the normal one rather than the "stream disappeared" case.
		if (restoreNeeded || router.loadedModules.length > 0 || router.movedStreams.length > 0) {
			await router.restore();
		}
		if (tone) {
			try {
				tone.player.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
		detach();
		cleanupFiles(opts.keepRaw);
	}
}

const code = await main();
process.exit(code);
