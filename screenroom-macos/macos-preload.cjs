const { contextBridge, ipcRenderer } = require("electron");

let pcmCallback = null;
// Always acknowledge, including while the AudioWorklet is being loaded. Without
// this, early packets could fill the sender's delivery window permanently.
ipcRenderer.on("audio:pcm", (_event, message) => {
	try { pcmCallback?.(message); }
	finally { ipcRenderer.send("audio:ack", message.captureId, message.sequence); }
});

// Expose "win32" on `platform` so the untouched shared frontend in
// ../screenroom/public activates its PCM AudioWorklet pipeline, PID-based
// application picker, thumbnail screen picker, and multi-PiP support without
// modifying any existing frontend files. `hostPlatform` reports "darwin".
contextBridge.exposeInMainWorld("screenroomNative", {
	platform: "win32",
	hostPlatform: "darwin",
	multiPip: true,
	listApps: () => ipcRenderer.invoke("audio:list"),
	probe: () => ipcRenderer.invoke("audio:probe"),
	startCapture: (target) => ipcRenderer.invoke("audio:start", target),
	stopCapture: () => ipcRenderer.invoke("audio:stop"),
	getState: () => ipcRenderer.invoke("audio:state"),
	getInviteUrl: () => ipcRenderer.invoke("app:invite"),
	getQuality: () => ipcRenderer.invoke("quality:read"),
	saveQuality: (value) => ipcRenderer.invoke("quality:write", value),
	listScreens: () => ipcRenderer.invoke("display:list"),
	selectScreen: (id) => ipcRenderer.invoke("display:select", id),
	onPcm(callback) {
		pcmCallback = callback;
		return () => { if (pcmCallback === callback) pcmCallback = null; };
	},
});

