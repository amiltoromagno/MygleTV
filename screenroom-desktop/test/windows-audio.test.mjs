import { test } from "node:test";
import assert from "node:assert/strict";
import { createWindowsCaptureSession, parseProcesses, resolveWindowAudio } from "../audio/windows.js";
import { PcmBuffer } from "../../screenroom/public/pcm-buffer.js";

function fixture({ fails = false } = {}) {
	const instances = [];
	class Capture {
		constructor() { instances.push(this); this.stops = 0; }
		start(pid, children, callback) { this.pid = pid; this.children = children; this.callback = callback; if (fails) throw new Error("WASAPI failed"); }
		startSystemAudio(callback) { this.callback = callback; this.system = true; }
		stop() { this.stops++; }
	}
	const session = createWindowsCaptureSession({ loadModule: async () => ({ default: { LoopbackCapture: Capture } }), listProcesses: async () => [{ id: "123", app: "Game" }], release: "10.0.26300", arch: "x64" });
	return { session, instances };
}

test("window audio owner mapping uses handles, not ambiguous titles", async () => {
	const sources = [{ id: "window:11:0", name: "Same title" }, { id: "window:12:0", name: "Same title" }, { id: "screen:0:0" }, { id: "window:99:0" }];
	const owners = await resolveWindowAudio(sources, async () => ({ stdout: JSON.stringify([{ handle: "11", owner: "123" }, { handle: "12", owner: "456" }]) }));
	assert.equal(owners.get(sources[0].id), "123");
	assert.equal(owners.get(sources[1].id), "456");
	assert.equal(owners.get(sources[2].id), null);
	assert.equal(owners.get(sources[3].id), null);
	assert.equal((await resolveWindowAudio([{ id: "screen:0:0" }], () => { throw new Error("Must not run for screens"); })).size, 0);
});

test("Windows picker preserves distinct processes with identical names", () => {
	const apps = parseProcesses(JSON.stringify([{ Id: 12, ProcessName: "game", MainWindowTitle: "One" }, { Id: 14, ProcessName: "game", MainWindowTitle: "Two" }, { Id: 0, ProcessName: "invalid" }]));
	assert.deepEqual(apps.map((p) => p.id), ["12", "14"]);
	assert.equal(apps[1].detail, "Two");
	assert.equal(parseProcesses('{"Id":4,"ProcessName":"player"}')[0].id, "4");
	assert.deepEqual(parseProcesses(""), []);
});
test("unsupported Windows build or architecture fails before capture", async () => {
	await assert.rejects(createWindowsCaptureSession({ release: "10.0.19045", arch: "x64" }).probe(), /20348/);
	await assert.rejects(createWindowsCaptureSession({ release: "10.0.26300", arch: "arm64" }).probe(), /x64/);
});
test("application capture uses the selected PID and includes descendants", async () => {
	const { session, instances } = fixture();
	const result = await session.start({ mode: "app", app: "123" });
	assert.equal(instances[0].pid, 123);
	assert.equal(instances[0].children, true);
	assert.equal(result.transport, "pcm");
	assert.equal(result.sampleRate, 48000);
	assert.equal(session.activeApp, "123");
	assert.equal(session.isActive(), true);
	await session.stop();
	assert.equal(instances[0].stops, 1);
	assert.equal(session.isActive(), false);
	assert.equal(session.activeMode, null);
});
test("system mode invokes whole-system capture explicitly", async () => {
	const { session, instances } = fixture();
	await session.start({ mode: "system" });
	assert.equal(instances[0].system, true);
	assert.equal(session.activeApp, null);
	await session.stop();
});
test("invalid PID and mode never start native capture", async () => {
	const { session, instances } = fixture();
	for (const app of ["Firefox", "", "0", "-1", "1.5", "1e3", "4294967296"]) await assert.rejects(session.start({ mode: "app", app }), /valid application/);
	await assert.rejects(session.start({ mode: "other" }), /Choose/);
	assert.equal(instances.length, 0);
});
test("replacement stops the previous capture and rejects its queued chunks", async () => {
	const { session, instances } = fixture();
	const chunks = [];
	session.setPcmHandler((message) => chunks.push(message));
	const first = await session.start({ mode: "app", app: "123" });
	instances[0].callback(Buffer.alloc(4));
	const next = await session.start({ mode: "app", app: "456" });
	instances[0].callback(Buffer.alloc(4));
	instances[1].callback(Buffer.alloc(4));
	instances[1].callback(Buffer.alloc(3));
	assert.equal(instances[0].stops, 1);
	assert.deepEqual(chunks.map((c) => c.captureId), [first.captureId, next.captureId]);
	await session.stop();
	instances[1].callback(Buffer.alloc(4));
	assert.equal(chunks.length, 2);
});
test("failed native startup clears state and releases the instance", async () => {
	const { session, instances } = fixture({ fails: true });
	await assert.rejects(session.start({ mode: "app", app: "123" }), /WASAPI failed/);
	assert.equal(instances[0].stops, 1);
	assert.equal(session.isActive(), false);
	assert.equal(session.activeApp, null);
});
test("Windows stop is idempotent and exit cleanup is synchronous", async () => {
	const { session, instances } = fixture();
	await session.start({ mode: "system" });
	session.restoreSync();
	await session.stop();
	assert.equal(instances[0].stops, 1);
});
test("missing native module gives a startup failure without retaining capture", async () => {
	const session = createWindowsCaptureSession({ release: "10.0.26300", arch: "x64", loadModule: async () => { throw new Error("missing addon"); } });
	await assert.rejects(session.start({ mode: "system" }), /missing addon/);
	assert.equal(session.isActive(), false);
});

function pcm(frames, left = 16384, right = -8192) {
	const bytes = Buffer.alloc(frames * 4);
	for (let i = 0; i < frames; i++) { bytes.writeInt16LE(left, i * 4); bytes.writeInt16LE(right, i * 4 + 2); }
	return bytes;
}
test("PCM is converted with independent stereo channels and signed samples", () => {
	const buffer = new PcmBuffer(1000, 2, 10);
	buffer.push(pcm(3));
	const output = [new Float32Array(3), new Float32Array(3)];
	buffer.process(output);
	assert.deepEqual([...output[0]], [0.5, 0.5, 0.5]);
	assert.deepEqual([...output[1]], [-0.25, -0.25, -0.25]);
});
test("PCM waits for a jitter buffer and outputs silence on underrun", () => {
	const buffer = new PcmBuffer(1000, 4, 10);
	const output = [new Float32Array(6), new Float32Array(6)];
	buffer.push(pcm(3)); buffer.process(output);
	assert.equal(output[0].some(Boolean), false);
	buffer.push(pcm(1)); buffer.process(output);
	assert.deepEqual([...output[0]], [0.5, 0.5, 0.5, 0.5, 0, 0]);
	buffer.process(output);
	assert.equal(output[0].some(Boolean), false);
	assert.equal(buffer.started, false);
});
test("PCM overflow discards old audio and memory stays bounded", () => {
	const buffer = new PcmBuffer(1000, 1, 5);
	buffer.push(pcm(5, 1000)); buffer.push(pcm(5, 2000));
	assert.equal(buffer.length, 5);
	const output = [new Float32Array(5), new Float32Array(5)]; buffer.process(output);
	assert.equal(output[0][0], 2000 / 32768);
});
test("PCM preserves ordering across ring wrap and ignores incomplete frames", () => {
	const buffer = new PcmBuffer(1000, 1, 4);
	buffer.push(pcm(3, 1000)); buffer.process([new Float32Array(2)]);
	buffer.push(pcm(3, 2000)); buffer.push(Buffer.alloc(3));
	const output = [new Float32Array(4)]; buffer.process(output);
	assert.deepEqual([...output[0]], [1000 / 32768, 2000 / 32768, 2000 / 32768, 2000 / 32768]);
});
