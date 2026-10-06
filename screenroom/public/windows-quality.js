import { normalizeQuality, RESOLUTIONS } from "./share-quality.js";

export async function setupWindowsQuality({ getQuality, applyQuality, getTrack, isBusy, toast }) {
	try { await applyQuality(normalizeQuality(await window.screenroomNative.getQuality())); }
	catch (err) { toast(`Could not load quality settings: ${err.message}`); }
	const button = document.createElement("button");
	button.id = "qualityBtn";
	button.className = "btn";
	button.textContent = "Quality";
	document.getElementById("copyBtn").after(button);
	const dialog = document.createElement("dialog");
	dialog.id = "qualityDialog";
	dialog.setAttribute("aria-label", "Stream quality");
	dialog.style.cssText = "background:#171b24;color:#edf0f7;border:1px solid #46516a;border-radius:12px;padding:24px;max-width:440px;width:calc(100% - 48px)";
	dialog.innerHTML = `<form id="qualityForm"><h2 style="margin-top:0">Stream quality</h2>
		<label class="field" style="margin:16px 0">Video bitrate limit (Mbps per viewer)<input id="qualityBitrate" type="number" min="0.5" max="100" step="any" required style="margin-top:8px"></label>
		<label style="display:block;margin:16px 0">FPS <select class="select" id="qualityFps"><option>30</option><option>60</option><option>120</option></select></label>
		<label style="display:block;margin:16px 0">Resolution <select class="select" id="qualityResolution">${Object.keys(RESOLUTIONS).map((key) => `<option value="${key}">${key === "native" ? "Original" : key === "2160p" ? "4K (2160p)" : key}</option>`).join("")}</select></label>
		<p>These are limits. Capture and transmission may run below them. Resolution preserves the source aspect ratio.</p>
		<p id="qualityActual" aria-live="polite"></p><p id="qualityError" role="alert"></p>
		<div style="display:flex;justify-content:flex-end;gap:12px"><button class="btn" type="button" id="qualityCancel">Cancel</button><button class="btn btn-primary" id="qualityApply" type="submit">Apply</button></div></form>`;
	document.body.append(dialog);
	const find = (id) => dialog.querySelector(`#${id}`);
	const updateActual = () => {
		const track = getTrack();
		const settings = track?.getSettings();
		find("qualityActual").textContent = settings ? `Current capture: ${settings.width ?? "?"} × ${settings.height ?? "?"}, ${Math.round(settings.frameRate ?? 0)} FPS. The encoder may send fewer frames.` : "No active capture.";
	};
	let timer;
	button.onclick = () => {
		if (isBusy()) return toast("Wait for screen sharing to finish starting or stopping.");
		const quality = getQuality();
		find("qualityBitrate").value = quality.bitrate;
		find("qualityFps").value = quality.fps;
		find("qualityResolution").value = quality.resolution;
		find("qualityError").textContent = "";
		updateActual(); dialog.showModal(); timer = setInterval(updateActual, 1000);
	};
	dialog.addEventListener("close", () => clearInterval(timer));
	find("qualityCancel").onclick = () => dialog.close();
	find("qualityForm").onsubmit = async (event) => {
		event.preventDefault();
		find("qualityApply").disabled = true;
		find("qualityCancel").disabled = true;
		try {
			await applyQuality(normalizeQuality({ bitrate: Number(find("qualityBitrate").value), fps: Number(find("qualityFps").value), resolution: find("qualityResolution").value }));
			await window.screenroomNative.saveQuality(getQuality());
			dialog.close(); toast("Stream quality updated.");
		} catch (err) { find("qualityError").textContent = `Could not apply settings: ${err.message}`; }
		finally { find("qualityApply").disabled = false; find("qualityCancel").disabled = false; }
	};
}
