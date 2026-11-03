/** Choose a source for the preview; audio and quality follow in share setup. */
export async function chooseWindowsScreen(bridge) {
	const result = await bridge.listScreens();
	if (!result || !result.ok) throw new Error((result && result.error) || "Could not list screens.");
	if (!result.sources || !result.sources.length) throw new Error("No screens or windows are available.");
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
	const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:12px;margin-top:16px";
	const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.className = "btn";
	const next = document.createElement("button"); next.id = "confirmScreenShare"; next.textContent = "Next"; next.className = "btn btn-primary"; next.disabled = true;
	actions.append(cancel, next); dialog.append(actions); document.body.append(dialog);
	let chosen = null;
	const source = await new Promise((resolve) => {
		const finish = (value) => {
			dialog.close(); dialog.remove(); resolve(value);
		};
		cancel.onclick = () => finish(null);
		dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
		next.onclick = () => { if (chosen) finish(chosen); };
		for (const source of result.sources) {
			const button = document.createElement("button"); button.className = "btn"; button.dataset.sourceId = source.id; button.setAttribute("aria-pressed", "false");
			button.style.cssText = "display:flex;flex-direction:column;gap:8px;white-space:normal;text-align:left;padding:12px";
			const image = document.createElement("img"); image.src = source.thumbnail; image.alt = ""; image.style.cssText = "width:100%;aspect-ratio:16/9;object-fit:contain;background:#0d1017";
			const label = document.createElement("span"); label.textContent = source.name; button.append(image, label);
			button.onclick = () => {
				chosen = source;
				for (const item of grid.children) { item.setAttribute("aria-pressed", String(item === button)); item.style.borderColor = item === button ? "#4da3ff" : ""; }
				next.disabled = false;
			};
			grid.append(button);
		}
		dialog.showModal();
	});
	const selected = await bridge.selectScreen(source ? source.id : null);
	if (!selected || !selected.ok) throw new Error((selected && selected.error) || "Could not select that screen.");
	return source;
}
