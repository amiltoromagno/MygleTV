export const DEFAULT_QUALITY = Object.freeze({ bitrate: 4, fps: 30, resolution: "native" });
export const RESOLUTIONS = Object.freeze({
	native: null, "720p": [1280, 720], "1080p": [1920, 1080],
	"1440p": [2560, 1440], "2160p": [3840, 2160],
});

export function normalizeQuality(value = {}) {
	return {
		bitrate: typeof value?.bitrate === "number" && Number.isFinite(value.bitrate) && value.bitrate >= 0.5 && value.bitrate <= 100 ? value.bitrate : 4,
		fps: [30, 60, 120].includes(value?.fps) ? value.fps : 30,
		resolution: Object.hasOwn(RESOLUTIONS, value?.resolution) ? value.resolution : "native",
	};
}

export function videoConstraints(value) {
	const quality = normalizeQuality(value);
	const dimensions = RESOLUTIONS[quality.resolution];
	return {
		frameRate: { ideal: quality.fps, max: quality.fps },
		...(dimensions ? { width: { ideal: dimensions[0], max: dimensions[0] }, height: { ideal: dimensions[1], max: dimensions[1] } } : {}),
	};
}
