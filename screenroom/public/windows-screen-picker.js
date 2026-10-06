/** Select picture first, then explicitly choose its audio before sharing. */
export async function chooseWindowsScreen(bridge, audioSelect) {
	const result = await bridge.listScreens();
	if (!result?.ok) throw new Error(result?.error || "Could not list screens.");
	if (!result.sources?.length) throw new Error("No screens or windows are available.");
	const dialog = document.createElement("dialog");
	dialog.setAttribute("aria-label", "Choose a screen or window to share");
	dialog.style.cssText = "color:#e8edf5;background:#151a22;border:1px solid #38465b;border-radius:12px;max-width:920px;width:85vw;padding:24px";
	const title = document.createElement("h2");
	title.textContent = "Choose a screen or window";
	dialog.append(title);
	const grid = document.createElement("div");
	grid.className = "screen-picker-grid";
	grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-height:40vh;overflow:auto";
	dialog.append(grid);
	const audioLabel = document.createElement("label");
	audioLabel.style.cssText = "display:block;margin-top:16px";
	const ownAudio = document.createElement("input");
	ownAudio.type = "checkbox"; ownAudio.id = "shareWindowAudio"; ownAudio.disabled = true;
	const ownCaption = document.createElement("span");
	ownCaption.textContent = " Select a window to share its application audio";
	audioLabel.append(ownAudio, ownCaption); dialog.append(audioLabel);
	const note = document.createElement("p");
	note.style.cssText = "color:#8b96a8;font-size:13px;margin:8px 0";
	note.textContent = "Application audio includes other windows from the same process. Sharing starts only when you click Share.";
	dialog.append(note);
	const audioParent = audioSelect?.parentNode;
	const audioNext = audioSelect?.nextSibling;
	const audioStyle = audioSelect?.getAttribute("style");
	if (audioSelect) {
		audioSelect.value = "none";
		const other = document.createElement("label"); other.style.cssText = "display:block;margin:16px 0";
		const caption = document.createElement("span"); caption.textContent = "Other audio to share"; caption.style.cssText = "display:block;margin-bottom:8px";
		audioSelect.style.cssText = "width:100%;max-width:100%";
		other.append(caption, audioSelect); dialog.append(other);
	}
	const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:12px;margin-top:16px";
	const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.className = "btn";
	const share = document.createElement("button"); share.id = "confirmScreenShare"; share.textContent = "Share"; share.className = "btn btn-primary"; share.disabled = true;
	actions.append(cancel, share); dialog.append(actions); document.body.append(dialog);
	let chosen = null;
	const otherChanged = () => { if (audioSelect.value !== "none") ownAudio.checked = false; };
	audioSelect?.addEventListener("change", otherChanged);
	ownAudio.addEventListener("change", () => { if (ownAudio.checked && audioSelect) audioSelect.value = "none"; });
	const id = await new Promise((resolve) => {
		const finish = (value) => {
			if (value !== null && audioSelect) {
				if (ownAudio.checked && chosen.audioApp) {
					const audioValue = `app:${chosen.audioApp}`;
					if (![...audioSelect.options].some((option) => option.value === audioValue)) {
						const option = document.createElement("option"); option.value = audioValue; option.textContent = chosen.name; audioSelect.append(option);
					}
					audioSelect.value = audioValue;
				}
				audioSelect.dispatchEvent(new Event("change"));
			}
			audioSelect?.removeEventListener("change", otherChanged);
			if (audioParent) {
				audioParent.insertBefore(audioSelect, audioNext);
				if (audioStyle === null) audioSelect.removeAttribute("style"); else audioSelect.setAttribute("style", audioStyle);
			}
			dialog.close(); dialog.remove(); resolve(value);
		};
		cancel.onclick = () => finish(null);
		dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
		share.onclick = () => { if (chosen) finish(chosen.id); };
		for (const source of result.sources) {
			const button = document.createElement("button"); button.className = "btn"; button.dataset.sourceId = source.id; button.setAttribute("aria-pressed", "false");
			button.style.cssText = "display:flex;flex-direction:column;gap:8px;white-space:normal;text-align:left;padding:12px";
			const image = document.createElement("img"); image.src = source.thumbnail; image.alt = ""; image.style.cssText = "width:100%;aspect-ratio:16/9;object-fit:contain;background:#0d1017";
			const label = document.createElement("span"); label.textContent = source.name; button.append(image, label);
			button.onclick = () => {
				chosen = source;
				for (const item of grid.children) { item.setAttribute("aria-pressed", String(item === button)); item.style.borderColor = item === button ? "#4da3ff" : ""; }
				ownAudio.checked = false; ownAudio.disabled = !source.audioApp;
				ownCaption.textContent = source.audioApp ? ` Share audio from ${source.name}` : " Application audio unavailable for this source; select other audio below if needed";
				if (audioSelect) audioSelect.value = "none";
				share.disabled = false;
			};
			grid.append(button);
		}
		dialog.showModal();
	});
	const selected = await bridge.selectScreen(id);
	if (!selected?.ok) throw new Error(selected?.error || "Could not select that screen.");
	return id !== null;
}
