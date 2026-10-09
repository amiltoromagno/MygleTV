// Real Electron PiP windows with live MediaStreams; no audio/capture hardware needed.
import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { startAppServer } from "../app-server.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
let win;
async function evaluate(code) { return win.webContents.executeJavaScript(code, true); }
async function waitFor(code) {
	for (let i = 0; i < 100; i++) {
		if (await evaluate(code)) return;
		await sleep(50);
	}
	throw new Error(`Timed out: ${code}`);
}
async function click(selector) {
	const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
	win.webContents.sendInputEvent({ type: "mouseMove", x, y });
	win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x, y });
	win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x, y });
}
async function run() {
try {
	assert.equal(process.platform, "win32");
	await app.whenReady();
	server = startAppServer({ port: 18000 + Math.floor(Math.random() * 2000) });
	assert.ok(await server.ready());
	win = new BrowserWindow({ width: 1000, height: 750, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
	await win.loadURL(server.url);
	await evaluate(`(async () => {
		document.body.innerHTML = '';
		window.screenroomNative = { platform: 'win32' };
		window.errors = [];
		const { addStreamControls } = await import('./stream-controls.js');
		window.players = [];
		for (let i = 0; i < 2; i++) {
			const root = document.createElement('figure'); root.className = 'tile'; root.id = 'player' + i;
			root.style.cssText = 'width:400px;height:230px;display:inline-block';
			const video = document.createElement('video'); video.autoplay = true; video.muted = true;
			const bar = document.createElement('div'); bar.className = 'tile-bar';
			const mute = document.createElement('button'); bar.append(mute); root.append(video, bar); document.body.append(root);
			const player = addStreamControls({ root, video, bar, mute, isSelf: i === 0, toast: (e) => errors.push(e) });
			const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
			const ctx = canvas.getContext('2d'); ctx.fillStyle = i ? 'blue' : 'green'; ctx.fillRect(0,0,640,360);
			video.srcObject = canvas.captureStream(30); await video.play();
			players.push({ root, video, player, stream: video.srcObject });
		}
	})()`);
	await waitFor("!document.querySelector('.tile-pip').disabled");
	assert.equal(await evaluate("getComputedStyle(document.querySelector('.tile-pip')).opacity"), "0");
	await click("#player0 .tile-pip");
	await waitFor("document.pictureInPictureElement === players[0].video");
	console.log("PASS real mouse click opens live stream in native PiP");
	win.minimize();
	await sleep(250);
	assert.equal(await evaluate("document.pictureInPictureElement === players[0].video"), true);
	win.restore();
	console.log("PASS PiP remains active with application minimized");
	await evaluate(`(() => {
		const slider = players[1].root.querySelector('.tile-volume'); slider.value = '250'; slider.dispatchEvent(new Event('input'));
	})()`);
	await click("#player1 .tile-pip");
	await waitFor("document.pictureInPictureElement === players[1].video");
	assert.equal(await evaluate("players[0].root.querySelector('.tile-pip').getAttribute('aria-pressed')"), "false");
	console.log("PASS switching stream updates previous and current controls");
	assert.equal(await evaluate("players[1].root.querySelector('.tile-volume').value"), "250");
	console.log("PASS opening PiP preserves viewer amplification level");
	await click("#player1 .tile-pip");
	await waitFor("!document.pictureInPictureElement");
	console.log("PASS same control closes PiP");
	await click("#player0 .tile-pip");
	await waitFor("document.pictureInPictureElement === players[0].video");
	await evaluate("players[0].player.dispose()");
	await waitFor("!document.pictureInPictureElement");
	assert.equal(await evaluate("players[0].stream.getVideoTracks()[0].readyState"), "live");
	console.log("PASS removing stream closes PiP without stopping media tracks");
	assert.deepEqual(await evaluate("errors"), []);
	await evaluate(`void (players[1].video.requestPictureInPicture = () => Promise.reject(new Error('Test PiP failure')))`);
	await click("#player1 .tile-pip");
	await waitFor("errors.length === 1");
	assert.match(await evaluate("errors[0]"), /Test PiP failure/);
	assert.equal(await evaluate("players[1].root.querySelector('.tile-pip').disabled"), false);
	await evaluate("delete players[1].video.requestPictureInPicture");
	await click("#player1 .tile-pip");
	await waitFor("document.pictureInPictureElement === players[1].video");
	await evaluate("players[1].stream.getVideoTracks()[0].stop(); players[1].player.dispose()");
	await waitFor("!document.pictureInPictureElement");
	console.log("PASS failed PiP request shows feedback and allows retry");
	await evaluate(`(async () => {
		window.screenroomNative.platform = 'linux';
		const { addStreamPictureInPicture } = await import('./stream-pip.js');
		const root = document.createElement('div');
		addStreamPictureInPicture({ root, video: players[1].video, toast() {} });
		window.linuxPipCount = root.children.length;
	})()`);
	assert.equal(await evaluate("linuxPipCount"), 0);
	console.log("PASS Linux interface is unchanged");
} catch (error) {
	console.error(error);
	app.exitCode = 1;
} finally {
	win?.destroy();
	server?.stop();
	app.exit(app.exitCode || 0);
}
}
void run();
