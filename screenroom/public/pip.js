const session = window.opener?.screenroomPipSessions?.get(new URL(location.href).searchParams.get("stream"));
if (!session) window.close();
else {
	const video = document.querySelector("video");
	const volume = document.getElementById("volume");
	const mute = document.getElementById("mute");
	const sync = () => {
		if (video.srcObject !== session.stream) {
			video.srcObject = session.stream;
			void video.play().catch(() => {});
		}
		document.getElementById("name").textContent = session.name;
		document.title = `${session.name} — MygleTV`;
		const state = session.readVolume();
		volume.value = String(state.level);
		volume.disabled = mute.disabled = state.disabled;
		document.getElementById("level").textContent = `${state.level}%`;
		volume.setAttribute("aria-valuetext", `${state.level}%`);
		mute.textContent = state.silent ? "🔇" : "🔊";
		mute.setAttribute("aria-pressed", String(state.silent));
		mute.setAttribute("aria-label", state.silent ? "Unmute stream" : "Mute stream");
	};
	const unsubscribe = session.subscribe(sync);
	volume.addEventListener("input", () => session.setVolume(Number(volume.value)));
	mute.addEventListener("click", () => session.toggleMute());
	document.getElementById("close").addEventListener("click", () => window.close());
	document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.close(); });
	window.addEventListener("pagehide", () => { unsubscribe(); video.srcObject = null; session.closed(window); }, { once: true });
	sync();
}
