const { contextBridge, ipcRenderer } = require("electron");

let pcmCallback = null;
// Always acknowledge, including while the AudioWorklet is being loaded. Without
// this, early packets could fill the sender's delivery window permanently.
ipcRenderer.on("audio:pcm", (_event, message) => {
	try { pcmCallback?.(message); }
	finally { ipcRenderer.send("audio:ack", message.captureId, message.sequence); }
});

contextBridge.exposeInMainWorld("screenroomNative", {
	platform: "win32",
	multiPip: true,
	windowControl: (action) => ipcRenderer.invoke("window:control", action),
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
