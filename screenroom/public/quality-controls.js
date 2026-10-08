// The stream quality dialog, shared by every client.
//
// Where the preference is stored depends on the client, because the origin does:
//
//   - The Windows shell serves its frontend from an ephemeral loopback port, so
//     its origin changes on every launch and localStorage would not survive a
//     restart. It keeps a file in the user data directory via the native bridge.
//   - Everywhere else the origin is stable, so localStorage is enough and no
//     extra IPC is needed.
//
// Everything else here is platform-neutral: it edits the live capture track and
// pushes new ceilings onto each peer's video sender.

import { normalizeQuality, RESOLUTIONS } from "./share-quality.js";

const STORAGE_KEY = "mygletv.quality";

async function loadQuality() {
	if (window.screenroomNative?.getQuality) {
		return normalizeQuality(await window.screenroomNative.getQuality());
	}
	try {
		return normalizeQuality(JSON.parse(localStorage.getItem(STORAGE_KEY)));
	} catch {
		// Absent, corrupt, or storage unavailable. normalizeQuality falls back to
		// the defaults, which is the same outcome as a first run.
		return normalizeQuality({});
	}
}

async function storeQuality(quality) {
	if (window.screenroomNative?.saveQuality) {
		await window.screenroomNative.saveQuality(quality);
		return;
	}
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(quality));
	} catch {
		// Private browsing or a full quota. Not worth interrupting a share over.
	}
}

export async function setupQualityControls({ getQuality, applyQuality, getTrack, isBusy, toast }) {
	try {
		await applyQuality(await loadQuality());
	} catch (err) {
		toast(`Could not load quality settings: ${err.message}`);
	}

	const button = document.createElement("button");
	button.id = "qualityBtn";
	button.className = "btn";
	button.textContent = "Quality";
	document.getElementById("copyBtn").after(button);

	const dialog = document.createElement("dialog");
	dialog.id = "qualityDialog";
	dialog.setAttribute("aria-label", "Stream quality");
	dialog.style.cssText =
		"background:#171b24;color:#edf0f7;border:1px solid #46516a;border-radius:12px;padding:24px;max-width:440px;width:calc(100% - 48px)";
	dialog.innerHTML = `<form id="qualityForm"><h2 style="margin-top:0">Stream quality</h2>
		<label class="field" style="margin:16px 0">Video bitrate limit (Mbps per viewer)<input id="qualityBitrate" type="number" min="0.5" max="100" step="any" required style="margin-top:8px"></label>
		<label style="display:block;margin:16px 0">FPS <select class="select" id="qualityFps"><option>30</option><option>60</option><option>120</option></select></label>
		<label style="display:block;margin:16px 0">Resolution <select class="select" id="qualityResolution">${Object.keys(RESOLUTIONS)
			.map(
				(key) =>
					`<option value="${key}">${key === "native" ? "Original" : key === "2160p" ? "4K (2160p)" : key}</option>`,
			)
			.join("")}</select></label>
		<p>These are limits. Capture and transmission may run below them. Resolution preserves the source aspect ratio.</p>
		<p id="qualityActual" aria-live="polite"></p><p id="qualityError" role="alert"></p>
		<div style="display:flex;justify-content:flex-end;gap:12px"><button class="btn" type="button" id="qualityCancel">Cancel</button><button class="btn btn-primary" id="qualityApply" type="submit">Apply</button></div></form>`;
	document.body.append(dialog);

	const find = (id) => dialog.querySelector(`#${id}`);
	const updateActual = () => {
		const track = getTrack();
		const settings = track?.getSettings();
		find("qualityActual").textContent = settings
			? `Current capture: ${settings.width ?? "?"} × ${settings.height ?? "?"}, ${Math.round(
					settings.frameRate ?? 0,
				)} FPS. The encoder may send fewer frames.`
			: "No active capture.";
	};

	let timer;
	button.onclick = () => {
		if (isBusy()) return toast("Wait for screen sharing to finish starting or stopping.");
		const quality = getQuality();
		find("qualityBitrate").value = quality.bitrate;
		find("qualityFps").value = quality.fps;
		find("qualityResolution").value = quality.resolution;
		find("qualityError").textContent = "";
		updateActual();
		dialog.showModal();
		timer = setInterval(updateActual, 1000);
	};
	dialog.addEventListener("close", () => clearInterval(timer));
	find("qualityCancel").onclick = () => dialog.close();

	find("qualityForm").onsubmit = async (event) => {
		event.preventDefault();
		find("qualityApply").disabled = true;
		find("qualityCancel").disabled = true;
		try {
			await applyQuality(
				normalizeQuality({
					bitrate: Number(find("qualityBitrate").value),
					fps: Number(find("qualityFps").value),
					resolution: find("qualityResolution").value,
				}),
			);
			await storeQuality(getQuality());
			dialog.close();
			toast("Stream quality updated.");
		} catch (err) {
			find("qualityError").textContent = `Could not apply settings: ${err.message}`;
		} finally {
			find("qualityApply").disabled = false;
			find("qualityCancel").disabled = false;
		}
	};
}
