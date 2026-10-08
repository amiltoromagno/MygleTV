// Real Electron + WASAPI + IPC + AudioWorklet + WebRTC. Windows hardware check.
// Generates two tones in separate processes; only the selected tone may arrive.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import { createWindowsCaptureSession, listWindowProcesses, resolveWindowAudio } from "../audio/windows.js";
import { createWindowsShell } from "../windows-shell.js";
import { startAppServer } from "../app-server.js";
import { startWindowsRelayProxy } from "../windows-relay-proxy.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const children = [];
const files = [];
let server;
let capture;
let proxy;
let qualityFile;
let qualityBackup;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (value, message) => { assert.ok(value, message); console.log(`PASS ${message}`); };

async function tone(frequency) {
	const frames = 48000 * 60;
	const bytes = Buffer.alloc(44 + frames * 4);
	bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
	bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36); bytes.writeUInt32LE(frames * 4, 40);
	for (let i = 0; i < frames; i++) {
		const value = Math.round(Math.sin(2 * Math.PI * frequency * i / 48000) * 0.15 * 32767);
		bytes.writeInt16LE(value, 44 + i * 4); bytes.writeInt16LE(value, 46 + i * 4);
	}
	const file = path.join(os.tmpdir(), `screenroom-tone-${frequency}-${process.pid}.wav`);
	files.push(file); fs.writeFileSync(file, bytes);
	const script = `$p = New-Object System.Media.SoundPlayer '${file.replaceAll("'", "''")}'; $p.Load(); Write-Output 'READY'; $p.PlaySync()`;
	const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
	children.push(child);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Tone startup timed out")), 15000);
		child.stdout.on("data", (data) => { if (data.toString().includes("READY")) { clearTimeout(timer); resolve(); } });
		child.on("error", (err) => { clearTimeout(timer); reject(err); });
		child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Tone exited ${code}`)); });
	});
	return child.pid;
}

async function evaluate(win, expression) { return win.webContents.executeJavaScript(expression, true); }
async function waitFor(win, expression, label, timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try { const result = await evaluate(win, expression); if (result) return result; } catch { /* page loading */ }
		await sleep(100);
	}
	throw new Error(`Timed out: ${label}`);
}

const analyserScript = `(async () => {
	const video = document.querySelector('#stage video'); video.muted = true;
	const ctx = new AudioContext({sampleRate:48000}); await ctx.resume();
	const source = ctx.createMediaStreamSource(video.srcObject);
	const analyser = ctx.createAnalyser(); analyser.fftSize = 4096; source.connect(analyser);
	window.audioCheck = {ctx, source, analyser}; return video.srcObject.getAudioTracks().length;
})()`;
const measureScript = `(() => {
	const {analyser, ctx} = window.audioCheck; const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
	const amplitude = (freq) => { let re=0, im=0; for(let i=0;i<data.length;i++){ const angle=2*Math.PI*freq*i/ctx.sampleRate; re+=data[i]*Math.cos(angle); im+=data[i]*Math.sin(angle); } return 2*Math.hypot(re,im)/data.length; };
	return {target:amplitude(440), other:amplitude(880)};
})()`;

async function runCheck() {
let code = 1;
try {
	assert.equal(process.platform, "win32", "This check requires Windows.");
	await app.whenReady();
	qualityFile = path.join(app.getPath("userData"), "stream-quality.json");
	try { qualityBackup = fs.readFileSync(qualityFile); } catch { /* No saved preferences. */ }
	const target = await tone(440);
	const other = await tone(880);
	const windows = await listWindowProcesses();
	check(windows.every((entry) => /^\d+$/.test(entry.id)), "real Windows process discovery returns PID identities");
	let failCapture = false;
	capture = createWindowsCaptureSession({ loadModule: async () => {
		if (failCapture) throw new Error("Injected audio startup failure");
		return import("loopback-capture");
	}, listProcesses: async () => [
		{ id: String(target), app: "Test tone", detail: "440 Hz", streams: 1 },
		{ id: String(other), app: "Excluded tone", detail: "880 Hz", streams: 1 },
	] });
	server = startAppServer({ port: 8499 });
	assert.equal(await server.ready(), true);
	proxy = await startWindowsRelayProxy({ relayUrl: `${server.url}?room=windows-check`, publicDir: path.resolve(root, "../screenroom/public") });
	class HiddenWindow extends BrowserWindow { constructor(options) { super({ ...options, show: false }); } }
	// Hidden tone processes have no window; associate test thumbnails explicitly.
	const shell = createWindowsShell({ app, BrowserWindow: HiddenWindow, desktopCapturer, ipcMain, session, captureSession: capture, router: capture, url: proxy.url, inviteUrl: proxy.inviteUrl, preloadPath: path.join(root, "windows-preload.cjs"), log: console.log, resolveWindowAudio: async (sources) => new Map(sources.map((source) => [source.id, String(target)])) });
	await shell.start();
	const host = shell.window;
	const handle = host.getNativeWindowHandle();
	const handleId = `window:${handle.length >= 8 ? handle.readBigUInt64LE() : handle.readUInt32LE()}:1`;
	check((await resolveWindowAudio([{ id: handleId }])).get(handleId) === String(process.pid), "Windows resolves the exact native window handle to its owning process");
	await waitFor(host, "!!document.getElementById('nameInput') && !!window.screenroomNative", "Windows preload");
	check(await evaluate(host, "screenroomNative.platform === 'win32'"), "real Electron loads the Windows bridge");
	check(await evaluate(host, "screenroomNative.getInviteUrl()") === proxy.inviteUrl, "invite points to the shared relay rather than the local proxy");
	await evaluate(host, `(() => { const original = RTCRtpSender.prototype.setParameters; window.sentQuality = []; RTCRtpSender.prototype.setParameters = function(params) { window.sentQuality.push(JSON.parse(JSON.stringify(params))); return original.call(this, params); }; })()`);
	await evaluate(host, "document.getElementById('nameInput').value='Windows host'; document.getElementById('gateForm').requestSubmit(); true");
	await waitFor(host, "document.getElementById('statusText').textContent === 'Connected'", "host joining");
	await waitFor(host, "!!document.getElementById('qualityBtn')", "quality preferences loaded");
	check(await evaluate(host, "document.getElementById('copyBtn').nextElementSibling.id === 'qualityBtn' && !document.querySelector('.bar-right #audioSource')"), "Quality sits beside Copy invite link and audio is removed from the Windows bar");
	await evaluate(host, "document.getElementById('qualityBtn').click(); document.getElementById('qualityBitrate').value='8'; document.getElementById('qualityFps').value='60'; document.getElementById('qualityResolution').value='720p'; document.getElementById('qualityForm').requestSubmit(); true");
	await waitFor(host, "!document.getElementById('qualityDialog').open", "quality saved");
	assert.deepEqual(await evaluate(host, "screenroomNative.getQuality()"), { bitrate: 8, fps: 60, resolution: "720p" });
	check(true, "Windows UI persists bitrate, FPS and resolution preferences");
	await evaluate(host, "document.getElementById('shareBtn').click(); true");
	await waitFor(host, "!!document.querySelector('dialog[open]')", "display picker");
	await waitFor(host, `!!document.querySelector('#audioSource option[value="app:${target}"]')`, "audio picker");
	check(await evaluate(host, "!!document.querySelector('dialog[open] #audioSource') && document.getElementById('audioSource').getBoundingClientRect().height > 0"), "Share screen dialog contains the visible audio selector");
	check(await evaluate(host, "[...document.querySelectorAll('#audioSource option')].every(o=>!o.textContent.startsWith('Only ')) && document.getElementById('confirmScreenShare').disabled"), "audio names have no Only prefix and sharing requires a selected picture");
	await evaluate(host, "[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Cancel').click(); true");
	await waitFor(host, "!document.getElementById('shareBtn').disabled", "cancel completion");
	check(!capture.isActive(), "cancelling the screen picker starts no audio capture");
	await evaluate(host, "document.getElementById('shareBtn').click(); true");
	await waitFor(host, "!!document.querySelector('dialog[open]')", "display picker again");
	await evaluate(host, "document.querySelector('.screen-picker-grid button').click(); true");
	check(!capture.isActive() && await evaluate(host, "!document.getElementById('shareWindowAudio').checked && !document.getElementById('shareWindowAudio').disabled && document.querySelector('dialog[open]') !== null"), "selecting a source offers its application audio but starts neither audio nor video");
	await evaluate(host, `document.getElementById('shareWindowAudio').click(); document.getElementById('audioSource').value='app:${other}'; document.getElementById('audioSource').dispatchEvent(new Event('change')); true`);
	check(await evaluate(host, "!document.getElementById('shareWindowAudio').checked"), "choosing other audio replaces the selected application's audio");
	await evaluate(host, "document.getElementById('shareWindowAudio').click(); document.getElementById('confirmScreenShare').click(); true");
	await waitFor(host, "document.getElementById('shareBtn').textContent === 'Stop sharing'", "actual screen capture");
	check(capture.activeApp === String(target), "UI starts WASAPI capture for the selected process");
	const viewer = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
	await viewer.loadURL(`${server.url}?room=windows-check`);
	await evaluate(viewer, "document.getElementById('nameInput').value='Late viewer'; document.getElementById('gateForm').requestSubmit(); true");
	await waitFor(viewer, "document.querySelector('#stage video')?.videoWidth > 0", "late viewer receives screen", 25000);
	await waitFor(host, "sentQuality.some(p=>p.encodings?.[0]?.maxBitrate===8000000 && p.encodings[0].maxFramerate===60)", "late peer quality parameters");
	check(await evaluate(viewer, "document.querySelector('#stage video').videoWidth<=1280 && document.querySelector('#stage video').videoHeight<=720"), "late viewer receives video bounded to 720p with 8 Mbps / 60 FPS sender limits");
	await evaluate(host, "document.getElementById('qualityBtn').click(); document.getElementById('qualityBitrate').value='6'; document.getElementById('qualityFps').value='120'; document.getElementById('qualityResolution').value='1080p'; document.getElementById('qualityForm').requestSubmit(); true");
	await waitFor(host, "!document.getElementById('qualityDialog').open", "live quality update");
	check(await evaluate(host, "sentQuality.some(p=>p.encodings?.[0]?.maxBitrate===6000000 && p.encodings[0].maxFramerate===120)"), "active sender accepts 120 FPS and a new bitrate ceiling without restarting capture");
	check(await evaluate(viewer, analyserScript) === 1, "late-joining browser receives an audio track over WebRTC");
	await waitFor(viewer, `(${measureScript}).target > 0.01`, "remote tone", 12000);
	const levels = await evaluate(viewer, measureScript);
	check(levels.target > 0.01 && levels.other < levels.target * 0.15, `selected application's audio arrives; other process excluded (${JSON.stringify(levels)})`);
	await evaluate(viewer, `(() => {
		const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=360;
		const context=canvas.getContext('2d'); context.fillStyle='blue'; context.fillRect(0,0,640,360);
		window.previewFrames=setInterval(()=>context.fillRect(0,0,640,360),100);
		navigator.mediaDevices.getDisplayMedia=async()=>canvas.captureStream(10);
		document.getElementById('shareBtn').click();
	})()`);
	await waitFor(host, "document.querySelectorAll('#stage .tile').length === 2", "Windows receives a second stream");
	check(await evaluate(host, `(() => {
		const tile=[...document.querySelectorAll('#stage .tile')].find(t=>t.querySelector('.tile-name').textContent==='Late viewer');
		window.remoteTile=tile; tile.click();
		const main=tile.getBoundingClientRect(), small=document.querySelector('#stage .tile:not(.focused)').getBoundingClientRect();
		const slider=tile.querySelector('.tile-volume'); slider.value='25'; slider.dispatchEvent(new Event('input'));
		return small.top>=main.bottom && small.width<main.width && tile.querySelector('video').volume===0.25 && tile.classList.contains('focused');
	})()`), "Windows keeps another stream below the focused video and adjusts its volume");
	await evaluate(host, "remoteTile.querySelector('.tile-fullscreen').click(); true");
	await waitFor(host, "document.fullscreenElement === remoteTile", "Windows fullscreen");
	check(await evaluate(host, "getComputedStyle(remoteTile.querySelector('.tile-fullscreen-exit')).display !== 'none'"), "Windows full screen has a visible exit X");
	await evaluate(host, "remoteTile.querySelector('.tile-fullscreen-exit').click(); true");
	await waitFor(host, "!document.fullscreenElement", "Windows exits fullscreen");
	await waitFor(host, "!document.body.classList.contains('monitor-fullscreen')", "Windows restores caption after monitor fullscreen");
	const windowBounds = host.getBounds();
	await evaluate(host, "remoteTile.querySelector('.tile-in-app-fullscreen').click(); true");
	check(await evaluate(host, `(() => {
		const box = remoteTile.getBoundingClientRect();
		return !document.fullscreenElement && box.x === 0 && box.y === 0 &&
			Math.abs(box.width - innerWidth) < 1 && Math.abs(box.height - innerHeight) < 1 &&
			getComputedStyle(remoteTile).borderTopWidth === '0px' &&
			getComputedStyle(document.querySelector('.windows-caption')).display === 'none' &&
			getComputedStyle(remoteTile.querySelector('.tile-fullscreen-exit')).display !== 'none';
	})()`), "In-app fullscreen fills the client area without chrome or borders");
	assert.deepEqual(host.getBounds(), windowBounds, "In-app fullscreen preserves the window bounds");
	await evaluate(host, "remoteTile.querySelector('.tile-fullscreen-exit').click(); true");
	check(await evaluate(host, "!document.body.classList.contains('in-app-fullscreen') && getComputedStyle(document.querySelector('.windows-caption')).display !== 'none'"), "Exit X restores the caption and streams");
	await evaluate(host, "remoteTile.querySelector('.tile-in-app-fullscreen').click(); document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); true");
	check(await evaluate(host, "!document.body.classList.contains('in-app-fullscreen') && remoteTile.classList.contains('focused')"), "Escape exits in-app fullscreen and keeps the selected stream focused");
	await evaluate(host, `remoteTile.querySelector('.tile-in-app-fullscreen').click();
		window.savedTileParent=remoteTile.parentNode; remoteTile.remove(); true`);
	await waitFor(host, "!document.body.classList.contains('in-app-fullscreen')", "removing a stream restores the app");
	await evaluate(host, "savedTileParent.append(remoteTile); true");
	check(true, "A removed stream restores the application chrome");
	await evaluate(viewer, "document.getElementById('shareBtn').click(); clearInterval(previewFrames); true");
	await waitFor(host, "document.querySelectorAll('#stage .tile').length === 1", "second stream stops");
	await evaluate(viewer, "audioCheck.ctx.close(); true");
	server.stop();
	await waitFor(host, "document.getElementById('statusText').textContent !== 'Connected'", "relay drops");
	await sleep(300);
	server = startAppServer({ port: 8499 });
	assert.ok(await server.ready());
	await waitFor(host, "document.getElementById('statusText').textContent === 'Connected'", "relay reconnects");
	await waitFor(viewer, "document.querySelector('#stage video')?.videoWidth > 0", "share returns after reconnection", 25000);
	await evaluate(viewer, analyserScript);
	await waitFor(viewer, `(${measureScript}).target > 0.01`, "native audio after reconnect");
	check(capture.activeApp === String(target), "relay reconnect republishes the active screen and native audio");
	await evaluate(viewer, "audioCheck.ctx.close(); true");
	await evaluate(host, "document.getElementById('shareBtn').click(); true");
	await waitFor(host, "!document.getElementById('shareBtn').disabled && document.getElementById('shareBtn').textContent === 'Share screen'", "stop completion");
	check(!capture.isActive(), "stopping a share releases native capture");
	await waitFor(viewer, "document.querySelectorAll('#stage video').length === 0", "viewer removes share");
	await evaluate(host, "document.getElementById('shareBtn').click(); true");
	await waitFor(host, "!!document.querySelector('dialog[open]')", "silent share picker");
	await evaluate(host, "document.querySelector('.screen-picker-grid button').click(); document.getElementById('confirmScreenShare').click(); true");
	await waitFor(host, "document.getElementById('shareBtn').textContent === 'Stop sharing'", "share without selected audio");
	check(!capture.isActive(), "leaving window audio unchecked shares video without starting native audio");
	await evaluate(host, "document.getElementById('shareBtn').click(); true");
	await waitFor(host, "!document.getElementById('shareBtn').disabled", "silent share stops");
	const invalid = await evaluate(host, "screenroomNative.startCapture({mode:'app',app:'bad'})");
	check(invalid.ok === false && !capture.isActive(), "invalid application selection returns a clean error");
	const system = await evaluate(host, "screenroomNative.startCapture({mode:'system'})");
	check(system.ok && system.transport === "pcm", "whole-system capture starts in Electron");
	await sleep(250); // Fill the delivery window before the renderer subscribes.
	await evaluate(host, `(async () => {
		const {captureWindowsAudio} = await import('./windows-audio.js');
		const stream = await captureWindowsAudio(screenroomNative, ${JSON.stringify(system)});
		const ctx = new AudioContext({sampleRate:48000}); await ctx.resume();
		const source = ctx.createMediaStreamSource(stream); const analyser = ctx.createAnalyser(); analyser.fftSize=4096; source.connect(analyser);
		window.audioCheck={ctx,source,analyser}; return true;
	})()`);
	await waitFor(host, `(${measureScript}).target > 0.01 && (${measureScript}).other > 0.01`, "system mix contains both tones");
	check(true, "whole-system PCM track contains both processes' audio");
	await evaluate(host, "audioCheck.ctx.close(); import('./audio-source.js').then(m=>m.stopNativeCapture())");
	check(!capture.isActive(), "whole-system capture stops cleanly");
	failCapture = true;
	await evaluate(host, "document.getElementById('shareBtn').click(); true");
	await waitFor(host, "!!document.querySelector('dialog[open]')", "failure-path picker");
	await evaluate(host, `document.querySelector('.screen-picker-grid button').click(); document.getElementById('audioSource').value='app:${target}'; document.getElementById('audioSource').dispatchEvent(new Event('change')); document.getElementById('confirmScreenShare').click(); true`);
	await waitFor(host, "document.getElementById('shareBtn').textContent === 'Stop sharing'", "video survives audio failure");
	check(!capture.isActive() && await evaluate(host, "/without sound/i.test(document.getElementById('toast').textContent)"), "Windows audio failure leaves video sharing with a clear warning");
	await evaluate(host, "document.getElementById('shareBtn').click(); true");
	await waitFor(host, "!document.getElementById('shareBtn').disabled", "stop silent share");
	failCapture = false;
	await evaluate(host, `screenroomNative.startCapture({mode:'app',app:'${target}'})`);
	host.webContents.reload();
	await waitFor(host, "!!document.getElementById('gateForm')", "reload");
	await sleep(200);
	check(!capture.isActive(), "renderer reload releases capture");
	await evaluate(host, "document.getElementById('nameInput').value='Windows host'; document.getElementById('gateForm').requestSubmit(); true");
	await waitFor(host, "document.getElementById('statusText').textContent === 'Connected' && !document.getElementById('shareBtn').disabled", "host rejoins for moderation check");
	await evaluate(host, "document.querySelector('#rosterList .roster-member').click(); true");
	check(await evaluate(host, "document.getElementById('kickDialog').open && document.getElementById('kickTitle').textContent.includes('Late viewer')"), "Windows roster click opens a kick confirmation for the selected member");
	await evaluate(host, "document.getElementById('confirmKick').click(); true");
	await waitFor(viewer, "document.getElementById('statusText').textContent === 'Removed from room'", "Windows kicks browser participant");
	await waitFor(host, "document.querySelectorAll('#rosterList li').length === 1", "Windows removes browser from roster");
	viewer.webContents.reload();
	await waitFor(viewer, "!!document.getElementById('gateForm')", "viewer reload");
	await evaluate(viewer, "document.getElementById('nameInput').value='Late viewer'; document.getElementById('gateForm').requestSubmit(); true");
	await waitFor(viewer, "document.querySelectorAll('#rosterList li').length === 2", "viewer explicitly rejoins");
	await evaluate(host, "document.getElementById('shareBtn').click(); true");
	await waitFor(host, "!!document.getElementById('confirmScreenShare')", "moderation audio picker");
	await evaluate(host, "document.querySelector('.screen-picker-grid button').click(); document.getElementById('shareWindowAudio').checked=true; document.getElementById('shareWindowAudio').dispatchEvent(new Event('change')); document.getElementById('confirmScreenShare').click(); true");
	await waitFor(host, "document.getElementById('shareBtn').textContent === 'Stop sharing'", "moderation native capture starts");
	check(capture.isActive(), "native audio is active before removal");
	await waitFor(viewer, "document.querySelector('#stage video')?.videoWidth > 0", "viewer receives Windows stream before kick");
	await evaluate(host, "window.captureBeforeKick=document.querySelector('#stage video').srcObject; true");
	await evaluate(viewer, "document.querySelector('#rosterList .roster-member').click(); document.getElementById('confirmKick').click(); true");
	await waitFor(host, "document.getElementById('statusText').textContent === 'Removed from room' && captureBeforeKick.getTracks().every(t=>t.readyState==='ended')", "browser kicks Windows sharer");
	await sleep(800);
	check(!capture.isActive() && await evaluate(host, "document.getElementById('shareBtn').disabled && !!document.querySelector('.session-removed')"), "kick stops Windows WASAPI and video and prevents automatic rejoining");
	check(await evaluate(viewer, "document.querySelectorAll('#rosterList li').length === 1 && document.querySelectorAll('#stage video').length === 0"), "kick removes Windows stream and roster entry from the web");
	code = 0;
} catch (err) {
	console.error(err.stack);
} finally {
	if (qualityFile) {
		if (qualityBackup) fs.writeFileSync(qualityFile, qualityBackup);
		else { try { fs.unlinkSync(qualityFile); } catch { /* Not created. */ } }
	}
	capture?.restoreSync();
	proxy?.stop();
	server?.stop();
	for (const child of children) child.kill();
	for (const file of files) { try { fs.unlinkSync(file); } catch { /* best effort */ } }
	app.exit(code);
}
}
void runCheck();
