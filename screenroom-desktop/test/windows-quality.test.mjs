import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeQuality, videoConstraints, DEFAULT_QUALITY } from "../../screenroom/public/share-quality.js";
import { createQualityStore } from "../windows-settings.js";

test("quality rejects corrupt values and preserves supported profiles", () => {
	for (const value of [null, {}, { bitrate: NaN, fps: 144, resolution: "bad" }, { bitrate: -1 }, { bitrate: 101 }]) assert.deepEqual(normalizeQuality(value), DEFAULT_QUALITY);
	for (const fps of [30, 60, 120]) assert.deepEqual(normalizeQuality({ bitrate: 12.5, fps, resolution: "1440p" }), { bitrate: 12.5, fps, resolution: "1440p" });
});
test("capture uses bounds without mandatory dimensions or an aspect ratio", () => {
	assert.deepEqual(videoConstraints({ fps: 120, resolution: "720p" }), { frameRate: { ideal: 120, max: 120 }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } });
	assert.deepEqual(videoConstraints(DEFAULT_QUALITY), { frameRate: { ideal: 30, max: 30 } });
});
test("Windows quality survives restart and malformed storage safely", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mygletv-quality-"));
	try {
		const store = createQualityStore(directory);
		assert.equal(store.read(), null);
		store.write({ bitrate: 8, fps: 60, resolution: "1080p", extra: true });
		assert.deepEqual(createQualityStore(directory).read(), { bitrate: 8, fps: 60, resolution: "1080p" });
		assert.throws(() => store.write({ bitrate: Infinity, fps: 30, resolution: "native" }));
		fs.writeFileSync(path.join(directory, "stream-quality.json"), "broken");
		assert.equal(store.read(), null);
	} finally { fs.rmSync(directory, { recursive: true }); }
});
