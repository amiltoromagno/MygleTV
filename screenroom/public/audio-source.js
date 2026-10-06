// Native audio sources, available only inside the desktop shell.
//
// In a plain browser `window.screenroomNative` is absent, `hasNative` is false,
// and the app uses display audio exactly as it did before. Nothing here runs in
// Firefox, so the web build is unaffected.

const bridge = typeof window !== "undefined" ? window.screenroomNative : null;

export const hasNative = Boolean(bridge);
export const isWindowsNative = bridge?.platform === "win32";

export async function chooseNativeScreen(audioSelect) {
	if (!isWindowsNative) return true;
	const { chooseWindowsScreen } = await import("./windows-screen-picker.js");
	return chooseWindowsScreen(bridge, audioSelect);
}

/** Must match VIRTUAL_MIC_LABEL / SYSTEM_TAP_LABEL in the desktop shell. */
export const NATIVE_DEVICE_LABEL = "MygleTV";

export async function listNativeApps() {
	if (!bridge) return [];
	const result = await bridge.listApps();
	if (!result || !result.ok) {
		throw new Error((result && result.error) || "could not list audio applications");
	}
	// Streams without a name are not selectable.
	return (result.apps || []).filter((app) => app && app.app);
}

/**
 * @param {{mode: "app"|"system", app?: string}} target
 * @returns {Promise<{deviceLabel: string, mode: string, app: string|null, streams?: number}>}
 */
export async function startNativeCapture(target) {
	if (!bridge) throw new Error("native audio capture is not available");
	const result = await bridge.startCapture(target);
	if (!result || !result.ok) {
		throw new Error((result && result.error) || "could not start native audio capture");
	}
	return result;
}

export async function stopNativeCapture() {
	if (!bridge) return;
	try {
		if (isWindowsNative) {
			const { stopWindowsAudio } = await import("./windows-audio.js");
			await stopWindowsAudio();
		}
	} catch {
		// Native capture must still stop if renderer cleanup fails.
	} finally {
		try { await bridge.stopCapture(); } catch { /* shell also restores on quit */ }
	}
}

/**
 * Chromium caches its device list, and the source the shell just created may not
 * show up immediately, so poll briefly rather than failing on the first look.
 */
export async function findNativeDevice(label = NATIVE_DEVICE_LABEL, attempts = 12, delayMs = 120) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const match = devices.find(
			(device) => device.kind === "audioinput" && device.label === label,
		);
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	return null;
}

/**
 * Capture the routed application audio. Processing is disabled on purpose:
 * echo cancellation and noise suppression are tuned for speech and would chew
 * up game and music audio.
 */
export async function captureNativeAudio(label = NATIVE_DEVICE_LABEL, description = null) {
	if (isWindowsNative) {
		const { captureWindowsAudio } = await import("./windows-audio.js");
		return captureWindowsAudio(bridge, description);
	}
	const device = await findNativeDevice(label);
	if (!device) {
		throw new Error(`the "${label}" audio source did not appear`);
	}

	const stream = await navigator.mediaDevices.getUserMedia({
		audio: {
			deviceId: { exact: device.deviceId },
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
		},
	});
	return stream;
}
