import { exitInAppFullscreen } from "./windows-window.js";

/** Use the original video so PiP keeps the stream's existing audio path. */
export function addStreamPictureInPicture({ root, video, toast }) {
	if (window.screenroomNative?.platform !== "win32" || !document.pictureInPictureEnabled || !video.requestPictureInPicture) return { dispose() {} };
	let disposed = false;
	let pending = false;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "tile-pip";
	button.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="12" y="11" width="8" height="7" rx="1" fill="currentColor"/></svg>';
	const sync = () => {
		const active = document.pictureInPictureElement === video;
		button.title = active ? "Exit Picture-in-Picture" : "Picture-in-Picture";
		button.setAttribute("aria-label", button.title);
		button.setAttribute("aria-pressed", String(active));
		button.disabled = pending || video.readyState === 0 || !video.videoWidth;
	};
	const close = () => {
		if (document.pictureInPictureElement === video) return document.exitPictureInPicture().catch(() => {});
	};
	button.addEventListener("click", async (event) => {
		event.stopPropagation();
		if (pending || disposed) return;
		pending = true;
		sync();
		try {
			if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
			else {
				exitInAppFullscreen();
				await video.requestPictureInPicture();
				if (disposed) await close();
			}
		} catch (error) {
			if (!disposed) toast(`Could not open Picture-in-Picture: ${error.message}`);
		} finally { pending = false; if (!disposed) sync(); }
	});
	button.addEventListener("keydown", (event) => event.stopPropagation());
	const events = ["loadedmetadata", "resize", "emptied", "enterpictureinpicture", "leavepictureinpicture"];
	for (const event of events) video.addEventListener(event, sync);
	video.addEventListener("ended", close);
	root.append(button);
	sync();
	return {
		dispose() {
			disposed = true;
			void close();
			for (const event of events) video.removeEventListener(event, sync);
			video.removeEventListener("ended", close);
			button.remove();
		},
	};
}
