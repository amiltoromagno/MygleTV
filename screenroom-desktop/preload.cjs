// Bridge between the desktop shell and the shared web frontend.
//
// The frontend detects window.screenroomNative and offers native audio sources;
// in a plain browser the object is absent and it falls back to display audio.
// Only this narrow surface is exposed -- no Node, no ipcRenderer.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("screenroomNative", {
	platform: process.platform,

	/** Applications currently producing audio. */
	listApps: () => ipcRenderer.invoke("audio:list"),

	/** Audio server details, for diagnostics. */
	probe: () => ipcRenderer.invoke("audio:probe"),

	/**
	 * Route audio into a capture source and return the device label the renderer
	 * should capture with getUserMedia.
	 *
	 *   startCapture({ mode: "system" })                 everything playing
	 *   startCapture({ mode: "app", app: "SuperGame" })  just that application
	 */
	startCapture: (target) => ipcRenderer.invoke("audio:start", target),

	/** Undo the routing and tear the capture source down. */
	stopCapture: () => ipcRenderer.invoke("audio:stop"),

	/** Which application is currently being captured, if any. */
	getState: () => ipcRenderer.invoke("audio:state"),
});
