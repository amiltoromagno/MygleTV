import fs from "node:fs";
import path from "node:path";

import { DEFAULT_APP_URL, resolveAppUrl } from "./app-url.js";

/** The relay a normal launch uses. Shared with the Linux shell, so one value. */
export const WINDOWS_APP_URL = DEFAULT_APP_URL;

/**
 * Windows-specific name kept for the packaging checks and existing callers.
 * The behaviour lives in resolveAppUrl() so the two shells cannot drift apart.
 */
export function resolveWindowsUrl(options) {
	return resolveAppUrl(options);
}

export function configureWindowsData(app) {
	app.setName("MygleTV");
	const directory = path.join(app.getPath("appData"), "MygleTV");
	fs.mkdirSync(directory, { recursive: true });
	app.setPath("userData", directory);
}

export function createQualityStore(directory) {
	const file = path.join(directory, "stream-quality.json");
	return {
		read() {
			try { return JSON.parse(fs.readFileSync(file, "utf8")); }
			catch { return null; }
		},
		write(value) {
			if (!value || !Number.isFinite(value.bitrate) || value.bitrate < 0.5 || value.bitrate > 100 || ![30, 60, 120].includes(value.fps) || !["native", "720p", "1080p", "1440p", "2160p"].includes(value.resolution)) throw new Error("Invalid stream quality settings.");
			const temporary = file + ".tmp";
			fs.writeFileSync(temporary, JSON.stringify({ bitrate: value.bitrate, fps: value.fps, resolution: value.resolution }));
			fs.renameSync(temporary, file);
		},
	};
}
