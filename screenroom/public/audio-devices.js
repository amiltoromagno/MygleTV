// Audio input devices, offered directly as a sharing source.
//
// This is the escape hatch for sound that no application owns. A capture card
// wired straight to the speakers is the clearest example: PipeWire links the
// card's input to the output device itself, so no application stream exists and
// neither "only this app" nor "all system audio" can see it. The card is still
// an ordinary audio input, though, and this captures it as one -- no routing, no
// null sinks, nothing changed on the user's system.
//
// It doubles as a way to share a microphone or an audio interface, which is the
// same operation.

export const DEVICE_PREFIX = "device:";

/** Asked once per session: a denied request should not be retried on every open. */
let labelsRequested = false;

/**
 * Device labels are withheld until the page has been granted audio access at
 * least once, and a list of anonymous entries is useless for picking a capture
 * card. So ask once, and stop the track immediately -- the point is the grant,
 * not the sound.
 */
async function withLabels(devices) {
	if (labelsRequested || devices.length === 0 || devices.some((device) => device.label)) {
		return devices;
	}
	labelsRequested = true;
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		for (const track of stream.getTracks()) track.stop();
		return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
	} catch {
		// Denied. Show what we have rather than nothing at all.
		return devices;
	}
}

/**
 * Audio inputs worth offering.
 *
 * @param {{exclude?: string[]}} [options] label fragments to drop -- our own
 *   capture plumbing, which would be a feedback loop if shared back.
 * @returns {Promise<{id: string, label: string}[]>}
 */
export async function listAudioDevices({ exclude = [] } = {}) {
	if (!navigator.mediaDevices?.enumerateDevices) return [];

	let devices = (await navigator.mediaDevices.enumerateDevices()).filter(
		(device) => device.kind === "audioinput",
	);
	devices = await withLabels(devices);

	const exclusions = exclude.map((fragment) => fragment.toLowerCase());
	const seen = new Set();

	return devices
		.filter((device) => device.deviceId && device.label)
		.filter((device) => !exclusions.some((f) => device.label.toLowerCase().includes(f)))
		.filter((device) => !seen.has(device.deviceId) && seen.add(device.deviceId))
		.map((device) => ({ id: device.deviceId, label: device.label }));
}

/**
 * Capture one device directly.
 *
 * Processing is deliberately off: these options are tuned for speech and would
 * mangle game or capture-card audio.
 */
export function captureAudioDevice(deviceId) {
	return navigator.mediaDevices.getUserMedia({
		audio: {
			deviceId: { exact: deviceId },
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
		},
	});
}
