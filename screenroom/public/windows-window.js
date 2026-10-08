let activeTile = null;
let previousFocus = null;

export function exitInAppFullscreen() {
	activeTile?.classList.remove("in-app-player");
	activeTile = null;
	document.body.classList.remove("in-app-fullscreen");
	if (previousFocus?.isConnected) previousFocus.focus();
	previousFocus = null;
}

export function enterInAppFullscreen(tile) {
	exitInAppFullscreen();
	previousFocus = document.activeElement;
	activeTile = tile;
	tile.classList.add("in-app-player");
	document.body.classList.add("in-app-fullscreen");
	tile.querySelector(".tile-fullscreen-exit")?.focus();
}

export function setupWindowsWindow() {
	const bridge = window.screenroomNative;
	if (bridge?.platform !== "win32" || !bridge.windowControl) return;
	document.body.classList.add("windows-window");
	const caption = document.createElement("header");
	caption.className = "windows-caption";
	const title = document.createElement("span");
	title.textContent = "MygleTV";
	caption.append(title);
	const control = (action) => bridge.windowControl(action).catch(console.error);
	for (const [action, label, icon] of [["minimize", "Minimize", "−"], ["maximize", "Maximize / restore", "□"], ["close", "Close", "×"]]) {
		const button = document.createElement("button");
		button.type = "button";
		button.title = label;
		button.setAttribute("aria-label", label);
		button.textContent = icon;
		button.dataset.windowAction = action;
		button.addEventListener("click", () => control(action));
		caption.append(button);
	}
	caption.addEventListener("dblclick", (event) => { if (!event.target.closest("button")) control("maximize"); });
	document.body.prepend(caption);
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && activeTile) {
			event.preventDefault();
			event.stopImmediatePropagation();
			exitInAppFullscreen();
		}
	}, true);
	document.addEventListener("fullscreenchange", () => {
		document.body.classList.toggle("monitor-fullscreen", Boolean(document.fullscreenElement));
	});
	// A participant stopping or leaving must restore the application chrome.
	new MutationObserver(() => {
		if (activeTile && !activeTile.isConnected) exitInAppFullscreen();
	}).observe(document.body, { childList: true, subtree: true });
}
