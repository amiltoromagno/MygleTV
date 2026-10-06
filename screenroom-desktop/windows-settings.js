import fs from "node:fs";
import path from "node:path";

export const WINDOWS_APP_URL = "https://screenroom.amiltoromagno.workers.dev/";

/** Explicit overrides are retained for development; normal launches use our app. */
export function resolveWindowsUrl({ args = process.argv, env = process.env } = {}) {
	const flag = args.find((arg) => arg.startsWith("--url="));
	if (flag !== undefined) return flag.slice("--url=".length);
	return env.SCREENROOM_URL || WINDOWS_APP_URL;
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
