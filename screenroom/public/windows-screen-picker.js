/** Explicit screen/window choice, used only by the Windows preload. */
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
	const audioParent = audioSelect?.parentNode;
	const audioNext = audioSelect?.nextSibling;
	const audioStyle = audioSelect?.getAttribute("style");
	if (audioSelect) {
		const audioLabel = document.createElement("label");
		audioLabel.style.cssText = "display:block;margin:0 0 16px";
		const caption = document.createElement("span");
		caption.textContent = "Audio to share";
		caption.style.cssText = "display:block;margin-bottom:8px";
		audioSelect.style.cssText = "width:100%;max-width:100%";
		audioLabel.append(caption, audioSelect);
		dialog.append(audioLabel);
	}
	const hint = document.createElement("p");
	hint.textContent = "Choose your audio, then click a screen or window to start sharing.";
	dialog.append(hint);
	const grid = document.createElement("div");
	grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-height:45vh;overflow:auto";
	dialog.append(grid);
	const cancel = document.createElement("button");
	cancel.textContent = "Cancel";
	cancel.className = "btn";
	cancel.style.marginTop = "20px";
	dialog.append(cancel);
	document.body.append(dialog);
	const id = await new Promise((resolve) => {
		const finish = (value) => {
			if (audioParent) {
				audioParent.insertBefore(audioSelect, audioNext);
				if (audioStyle === null) audioSelect.removeAttribute("style");
				else audioSelect.setAttribute("style", audioStyle);
			}
			dialog.close(); dialog.remove(); resolve(value);
		};
		cancel.addEventListener("click", () => finish(null));
		dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
		for (const source of result.sources) {
			const button = document.createElement("button");
			button.className = "btn";
			button.style.cssText = "display:flex;flex-direction:column;gap:8px;white-space:normal;text-align:left;padding:12px";
			const image = document.createElement("img");
			image.src = source.thumbnail;
			image.alt = "";
			image.style.cssText = "width:100%;aspect-ratio:16/9;object-fit:contain;background:#0d1017";
			const label = document.createElement("span");
			label.textContent = source.name;
			button.append(image, label);
			button.addEventListener("click", () => finish(source.id));
			grid.append(button);
		}
		dialog.showModal();
	});
	const selected = await bridge.selectScreen(id);
	if (!selected?.ok) throw new Error(selected?.error || "Could not select that screen.");
	return id !== null;
}
