/** Playback controls shared by browser viewers and the Windows desktop app. */
import { enterInAppFullscreen, exitInAppFullscreen } from "./windows-window.js";
import { createStreamVolume } from "./stream-volume.js";
export function addStreamControls({ root, video, bar, mute, isSelf, toast }) {
	root.classList.add("tile-player");
	const volume = document.createElement("input");
	volume.type = "range";
	volume.className = "tile-volume";
	volume.min = "0";
	const canBoost = !isSelf && (!window.screenroomNative || window.screenroomNative.platform === "win32");
	volume.max = canBoost ? "300" : "100";
	volume.step = "1";
	volume.disabled = isSelf;
	volume.setAttribute("aria-label", canBoost ? "Stream volume, up to 300%" : "Stream volume");
	let lastVolume = 1;
	let playback = null;
	const value = document.createElement("span");
	value.className = "tile-volume-value";
	const sync = () => {
		const silent = playback ? playback.silent : video.muted || video.volume === 0;
		volume.value = isSelf || silent ? "0" : String(playback ? playback.level : Math.round(video.volume * 100));
		value.textContent = `${volume.value}%`;
		volume.setAttribute("aria-valuetext", value.textContent);
		volume.title = isSelf ? "Your own screen is always muted here" : `Volume: ${volume.value}%${playback?.level > 100 ? " — amplified; lower if distorted" : ""}`;
		mute.textContent = silent ? "🔇" : "🔊";
		mute.title = isSelf ? "Your own screen is always muted here" : silent ? "Unmute this stream" : "Mute this stream";
		mute.setAttribute("aria-label", mute.title);
		mute.setAttribute("aria-pressed", String(silent));
	};
	if (canBoost) playback = createStreamVolume(video, sync, (err) => toast(`Could not amplify audio: ${err.message}`));
	else video.addEventListener("volumechange", sync);
	volume.addEventListener("input", () => {
		if (playback) { playback.setVolume(volume.value); return; }
		video.volume = Number(volume.value) / 100;
		if (video.volume > 0) lastVolume = video.volume;
		video.muted = video.volume === 0;
		sync();
	});
	if (!isSelf) mute.addEventListener("click", () => {
		if (playback) { playback.toggleMute(); return; }
		if (video.muted || video.volume === 0) {
			if (video.volume === 0) video.volume = lastVolume;
			video.muted = false;
		} else video.muted = true;
		sync();
	});
	const fullscreen = document.createElement("button");
	fullscreen.type = "button";
	fullscreen.className = "tile-fullscreen";
	fullscreen.textContent = "⛶";
	fullscreen.title = "Full screen";
	fullscreen.setAttribute("aria-label", "Full screen");
	fullscreen.disabled = !document.fullscreenEnabled;
	fullscreen.addEventListener("click", () => {
		exitInAppFullscreen();
		root.requestFullscreen().catch((err) => toast(`Could not enter full screen: ${err.message}`));
	});
	const exit = document.createElement("button");
	exit.type = "button";
	exit.className = "tile-fullscreen-exit";
	exit.textContent = "×";
	exit.title = "Exit full screen (Esc)";
	exit.setAttribute("aria-label", "Exit full screen");
	exit.addEventListener("click", (event) => {
		event.stopPropagation();
		exitInAppFullscreen();
		if (document.fullscreenElement) document.exitFullscreen().catch((err) => toast(err.message));
	});
	// Slider clicks and keyboard navigation must not also change the focused tile.
	bar.addEventListener("click", (event) => event.stopPropagation());
	bar.addEventListener("keydown", (event) => event.stopPropagation());
	exit.addEventListener("keydown", (event) => event.stopPropagation());
	bar.append(volume);
	if (canBoost) bar.append(value);
	bar.append(fullscreen);
	if (window.screenroomNative?.platform === "win32" && window.screenroomNative.windowControl) {
		const inApp = document.createElement("button");
		inApp.type = "button";
		inApp.className = "tile-in-app-fullscreen";
		inApp.textContent = "Full screen in app";
		inApp.title = "Fill this application window";
		inApp.addEventListener("click", () => enterInAppFullscreen(root));
		bar.append(inApp);
	}
	root.append(exit);
	sync();
	return {
		setStream: (stream) => playback?.setStream(stream),
		dispose: () => { playback?.dispose(); video.removeEventListener("volumechange", sync); },
	};
}
