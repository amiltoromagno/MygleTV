// The pre-flight dialog shown between picking a screen and going live.
//
// The system picker only answers "which screen". Everything else -- quality, and
// what audio to send with it -- is decided here, with the chosen screen visible
// behind the controls so it is obvious what is about to be shared. Nothing is
// sent until Share is pressed, and Cancel releases the capture entirely.
//
// The dialog is deliberately presentational: it collects values and hands them
// back. Applying quality, capturing audio and persisting the choice all belong
// to app.js, so there is one implementation of each.

import { RESOLUTIONS, normalizeQuality, videoConstraints } from "./share-quality.js";

const RESOLUTION_LABELS = {
	native: "Original",
	"720p": "720p",
	"1080p": "1080p",
	"1440p": "1440p",
	"2160p": "4K (2160p)",
};

/**
 * @param {object} options
 * @param {MediaStream} options.stream      live capture to preview
 * @param {object} options.quality          current quality profile
 * @param {HTMLSelectElement} options.audioSelect  the shared audio picker
 * @param {(hasDisplayAudio: boolean) => Promise<void>} options.refreshAudio
 * @returns {Promise<{quality: object, audio: string} | null>} null when cancelled
 */
export function showShareSetup({ stream, quality, audioSelect, refreshAudio }) {
	return new Promise((resolve) => {
		// Captured before anything moves the picker, so it can be put back where it
		// came from. Reading these later would record the dialog as its parent and
		// leave the element detached once the dialog is removed.
		const audioParent = audioSelect.parentNode;
		const audioNext = audioSelect.nextSibling;

		const dialog = document.createElement("dialog");
		dialog.id = "shareSetupDialog";
		dialog.setAttribute("aria-label", "Share settings");
		dialog.style.cssText = [
			"color:#e8edf5",
			"background:#151a22",
			"border:1px solid #38465b",
			"border-radius:14px",
			"padding:24px",
			"width:min(880px, 92vw)",
			"max-height:90vh",
		].join(";");

		const heading = document.createElement("h2");
		heading.textContent = "Ready to share";
		heading.style.cssText = "margin:0 0 16px";
		dialog.append(heading);

		const columns = document.createElement("div");
		columns.className = "share-setup-columns";
		dialog.append(columns);

		// --- preview -------------------------------------------------------
		const previewWrap = document.createElement("div");
		previewWrap.className = "share-setup-preview";
		const preview = document.createElement("video");
		preview.muted = true;
		preview.autoplay = true;
		preview.playsInline = true;
		preview.srcObject = stream;
		previewWrap.append(preview);
		const previewNote = document.createElement("p");
		previewNote.className = "share-setup-note";
		previewNote.textContent = "This is what everyone will see.";
		previewWrap.append(previewNote);
		columns.append(previewWrap);

		// --- options -------------------------------------------------------
		const options = document.createElement("div");
		options.className = "share-setup-options";
		columns.append(options);

		const field = (labelText) => {
			const label = document.createElement("label");
			label.className = "field";
			label.style.cssText = "display:block;margin:0 0 14px";
			const caption = document.createElement("span");
			caption.textContent = labelText;
			label.append(caption);
			options.append(label);
			return label;
		};

		const bitrate = document.createElement("input");
		bitrate.type = "number";
		bitrate.id = "setupBitrate";
		bitrate.min = "0.5";
		bitrate.max = "100";
		bitrate.step = "any";
		bitrate.required = true;
		bitrate.value = normalizeQuality(quality).bitrate;
		field("Video bitrate limit (Mbps per viewer)").append(bitrate);

		const fps = document.createElement("select");
		fps.className = "select";
		fps.id = "setupFps";
		for (const value of [30, 60, 120]) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = `${value} FPS`;
			fps.append(option);
		}
		fps.value = String(normalizeQuality(quality).fps);
		field("Frame rate").append(fps);

		const resolution = document.createElement("select");
		resolution.className = "select";
		resolution.id = "setupResolution";
		for (const key of Object.keys(RESOLUTIONS)) {
			const option = document.createElement("option");
			option.value = key;
			option.textContent = RESOLUTION_LABELS[key] ?? key;
			resolution.append(option);
		}
		resolution.value = normalizeQuality(quality).resolution;
		field("Resolution").append(resolution);

		const audioField = document.createElement("label");
		audioField.className = "field";
		audioField.style.cssText = "display:block;margin:0 0 14px";
		const audioCaption = document.createElement("span");
		audioCaption.textContent = "Audio to share";
		audioField.append(audioCaption, audioSelect);
		audioSelect.style.cssText = "width:100%";
		options.append(audioField);

		const actual = document.createElement("p");
		actual.id = "setupActual";
		actual.className = "share-setup-note";
		options.append(actual);

		// The bitrate is a ceiling, and the dialog should not imply otherwise --
		// particularly on a very large display, where it is the thing that bites.
		const caveat = document.createElement("p");
		caveat.className = "share-setup-note";
		caveat.textContent =
			"Bitrate is per viewer. A stalled picture here usually means the source is " +
			"larger than the ceiling can carry: lower the resolution.";
		options.append(caveat);

		// --- actions -------------------------------------------------------
		const actions = document.createElement("div");
		actions.style.cssText = "display:flex;justify-content:flex-end;gap:12px;margin-top:8px";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "btn";
		cancel.id = "shareSetupCancel";
		cancel.textContent = "Cancel";
		const share = document.createElement("button");
		share.type = "button";
		share.className = "btn btn-primary";
		share.id = "shareSetupConfirm";
		share.textContent = "Share";
		actions.append(cancel, share);
		dialog.append(actions);
		document.body.append(dialog);

		// Report the dimensions actually being captured, which is the fastest way
		// to notice that "1440p" is really 2560x720 on an ultrawide source.
		const reportActual = () => {
			const track = stream.getVideoTracks()[0];
			const settings = track?.getSettings();
			actual.textContent = settings
				? `Capturing ${settings.width ?? "?"} x ${settings.height ?? "?"}.`
				: "";
		};
		const reportAfterConstraints = () => {
			queueMicrotask(reportActual);
			setTimeout(reportActual, 400);
		};
		for (const control of [resolution, fps]) control.addEventListener("change", reportAfterConstraints);
		reportActual();

		// Re-apply the chosen resolution to the live capture so the preview shows
		// what will actually be sent, not the raw screen.
		const previewConstraints = () => {
			const track = stream.getVideoTracks()[0];
			if (!track?.applyConstraints) return;
			track
				.applyConstraints(
					videoConstraints({
						fps: Number(fps.value),
						resolution: resolution.value,
					}),
				)
				.catch(() => {
					/* not every source honours this; the sender clamps anyway */
				});
		};

		const finish = (value) => {
			preview.srcObject = null;
			audioParent?.insertBefore(audioSelect, audioNext);
			audioSelect.removeAttribute("style");
			dialog.close();
			dialog.remove();
			resolve(value);
		};

		cancel.addEventListener("click", () => finish(null));
		dialog.addEventListener("cancel", (event) => {
			event.preventDefault();
			finish(null);
		});
		share.addEventListener("click", () => {
			if (!bitrate.reportValidity()) return;
			finish({
				quality: normalizeQuality({
					bitrate: Number(bitrate.value),
					fps: Number(fps.value),
					resolution: resolution.value,
				}),
				audio: audioSelect.value || "none",
			});
		});

		// Populate the audio choices knowing whether the capture itself has sound.
		const hasDisplayAudio = stream.getAudioTracks().length > 0;
		refreshAudio(hasDisplayAudio)
			.catch(() => {
				/* the picker falls back to its own defaults */
			})
			.finally(() => dialog.showModal());
	});
}
