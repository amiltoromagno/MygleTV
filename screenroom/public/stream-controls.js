/** Playback controls shared by browser viewers and the Windows desktop app. */
export function addStreamControls({ root, video, bar, mute, isSelf, toast }) {
	root.classList.add("tile-player");
	const volume = document.createElement("input");
	volume.type = "range";
	volume.className = "tile-volume";
	volume.min = "0";
	volume.max = "100";
	volume.step = "1";
	volume.disabled = isSelf;
	volume.setAttribute("aria-label", "Stream volume");
	let lastVolume = 1;
	const sync = () => {
		const silent = video.muted || video.volume === 0;
		volume.value = isSelf || silent ? "0" : String(Math.round(video.volume * 100));
		volume.title = isSelf ? "Your own screen is always muted here" : `Volume: ${volume.value}%`;
		mute.textContent = silent ? "🔇" : "🔊";
		mute.title = isSelf ? "Your own screen is always muted here" : silent ? "Unmute this stream" : "Mute this stream";
		mute.setAttribute("aria-label", mute.title);
		mute.setAttribute("aria-pressed", String(silent));
	};
	video.addEventListener("volumechange", sync);
	volume.addEventListener("input", () => {
		video.volume = Number(volume.value) / 100;
		if (video.volume > 0) lastVolume = video.volume;
		video.muted = video.volume === 0;
		sync();
	});
	if (!isSelf) mute.addEventListener("click", () => {
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
		if (document.fullscreenElement) document.exitFullscreen().catch((err) => toast(err.message));
	});
	// Slider clicks and keyboard navigation must not also change the focused tile.
	bar.addEventListener("click", (event) => event.stopPropagation());
	bar.addEventListener("keydown", (event) => event.stopPropagation());
	exit.addEventListener("keydown", (event) => event.stopPropagation());
	bar.append(volume, fullscreen);
	root.append(exit);
	sync();
}
