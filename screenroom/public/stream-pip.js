import { exitInAppFullscreen } from "./windows-window.js";

/** Independent floating windows share video tracks; audio plays only in the room. */
export function addStreamPictureInPicture({ root, video, toast, readVolume, setVolume, toggleMute }) {
	if (window.screenroomNative?.platform !== "win32" || !window.screenroomNative.multiPip) return { dispose() {}, sync() {}, setStream() {} };
	const sessions = window.screenroomPipSessions ||= new Map();
	const id = crypto.randomUUID();
	let child = null;
	let disposed = false;
	let stream = null;
	const listeners = new Set();
	const button = document.createElement("button");
	button.type = "button";
	button.className = "tile-pip";
	button.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="12" y="11" width="8" height="7" rx="1" fill="currentColor"/></svg>';
	const sync = () => {
		const active = child && !child.closed;
		button.title = active ? "Exit Picture-in-Picture" : "Picture-in-Picture";
		button.setAttribute("aria-label", button.title);
		button.setAttribute("aria-pressed", String(Boolean(active)));
		button.disabled = video.readyState === 0 || !video.videoWidth;
		for (const callback of listeners) {
			try { callback(); } catch { listeners.delete(callback); }
		}
	};
	const close = () => { child?.close(); child = null; sync(); };
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		if (disposed) return;
		if (child && !child.closed) { close(); return; }
		try {
			exitInAppFullscreen();
			const url = new URL("./pip.html", location.href); url.search = `?stream=${id}`; url.hash = "";
			child = window.open(url.href, `mygletv-pip-${id}`, "width=480,height=270");
			if (!child) throw new Error("The floating window could not be opened. Update the Windows app and retry.");
			sync();
		} catch (error) { toast(`Could not open Picture-in-Picture: ${error.message}`); }
	});
	button.addEventListener("keydown", (event) => event.stopPropagation());
	const session = {
		get stream() { return stream || video.srcObject; },
		get name() { return root.querySelector(".tile-name")?.textContent || "MygleTV"; },
		readVolume, setVolume, toggleMute,
		subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
		closed(closedWindow) { if (child === closedWindow) { child = null; sync(); } },
	};
	sessions.set(id, session);
	const events = ["loadedmetadata", "resize", "emptied"];
	for (const event of events) video.addEventListener(event, sync);
	video.addEventListener("ended", close);
	root.append(button);
	sync();
	return {
		sync,
		setStream(next) { stream = next; if (!next) close(); else sync(); },
		dispose() {
			disposed = true; close(); listeners.clear(); sessions.delete(id);
			for (const event of events) video.removeEventListener(event, sync);
			video.removeEventListener("ended", close); button.remove();
		},
	};
}
