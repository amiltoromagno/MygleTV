/** Only the bundled PiP page may create an always-on-top companion window. */
export function configureWindowsPip(contents, owner, appUrl) {
	const origin = new URL(appUrl).origin;
	const windows = new Set();
	let sequence = 0;
	contents.setWindowOpenHandler(({ url, frameName }) => {
		const target = new URL(url);
		if (target.origin !== origin || target.pathname !== "/pip.html" || !/^mygletv-pip-[a-f0-9-]+$/.test(frameName)) return { action: "deny" };
		const bounds = owner.getBounds();
		const offset = 30 * (sequence++ % 6);
		return {
			action: "allow",
			overrideBrowserWindowOptions: {
				width: 480, height: 270, minWidth: 280, minHeight: 158,
				x: bounds.x + 40 + offset, y: bounds.y + 60 + offset,
				frame: false, alwaysOnTop: true, skipTaskbar: true,
				autoHideMenuBar: true, backgroundColor: "#000000",
				webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
			},
		};
	});
	contents.on("did-create-window", (win, details) => {
		windows.add(win);
		win.setMenu(null);
		win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		win.webContents.on("will-navigate", (event, nextUrl) => { if (nextUrl !== details.url) event.preventDefault(); });
		win.on("closed", () => windows.delete(win));
	});
	const closeAll = () => { for (const win of windows) win.destroy(); windows.clear(); };
	contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) closeAll(); });
	contents.on("render-process-gone", closeAll);
	owner.on("closed", closeAll);
}
