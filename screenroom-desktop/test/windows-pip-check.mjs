// Real Windows companion windows, shared live media, and synchronized volume.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { startAppServer } from '../app-server.js';
import { configureWindowsPip } from '../windows-pip.js';
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server, win;
let code = 0;
const evaluate = (expression) => win.webContents.executeJavaScript(expression, true);
async function waitFor(expression) {
  for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await sleep(50); }
  throw new Error(`Timed out: ${expression}`);
}
async function click(selector) {
  const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
  win.webContents.sendInputEvent({ type:'mouseMove', x, y });
  win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, x, y });
  win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, x, y });
}
async function run() {
 try {
  assert.equal(process.platform, 'win32');
  await app.whenReady();
  server = startAppServer({ port:18000 + Math.floor(Math.random()*2000) });
  assert.ok(await server.ready());
  win = new BrowserWindow({ width:1280, height:750, webPreferences:{ preload:path.join(rootDir,'windows-preload.cjs'), contextIsolation:true, nodeIntegration:false, backgroundThrottling:false } });
  configureWindowsPip(win.webContents, win, server.url);
  await win.loadURL(server.url);
  await evaluate(`(async () => {
    document.body.innerHTML = ''; window.errors = []; window.players = [];
    const { addStreamControls } = await import('./stream-controls.js');
    const audio = new AudioContext(); await audio.resume(); window.audio = audio;
    const oscillator = audio.createOscillator(); const destination = audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
    for (let i=0; i<3; i++) {
      const root = document.createElement('figure'); root.id = 'player'+i; root.className = 'tile'; root.style.cssText='width:350px;height:200px;display:inline-block;margin:4px';
      const video = document.createElement('video'); video.autoplay = true;
      const bar = document.createElement('div'); bar.className='tile-bar';
      const name = document.createElement('span'); name.className='tile-name'; name.textContent='Viewer '+i;
      const mute = document.createElement('button'); mute.className='tile-mute'; bar.append(name,mute); root.append(video,bar); document.body.append(root);
      const player = addStreamControls({root,video,bar,mute,isSelf:false,toast:e=>errors.push(e)});
      const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=360;
      const ctx=canvas.getContext('2d'); ctx.fillStyle=['green','blue','red'][i]; ctx.fillRect(0,0,640,360);
      const stream = canvas.captureStream(30); stream.addTrack(destination.stream.getAudioTracks()[0]);
      video.srcObject=stream; player.setStream(stream); await video.play();
      players.push({root,video,player,stream});
    }
  })()`);
  await waitFor("[...document.querySelectorAll('.tile-pip')].every(b=>!b.disabled)");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.tile-pip')).opacity"),'0');
  for (let i=0;i<3;i++) await click(`#player${i} .tile-pip`);
  await waitFor("[...screenroomPipSessions.values()].every(s=>s.subscribe && document.querySelectorAll('.tile-pip[aria-pressed=true]').length===3)");
  const children = () => BrowserWindow.getAllWindows().filter(w=>w!==win);
  assert.equal(children().length,3);
  for (const child of children()) {
    for (let i=0; i<120; i++) {
      if (await child.webContents.executeJavaScript("!!document.querySelector('video')?.videoWidth")) break;
      await sleep(50);
    }
    assert.equal(await child.webContents.executeJavaScript("document.querySelector('video').videoWidth"),640);
    assert.equal(child.isAlwaysOnTop(),true);
    assert.equal(await child.webContents.executeJavaScript("document.querySelector('video').muted && !document.querySelector('video').controls"),true);
  }
  console.log('PASS three independent always-on-top windows render live streams without native playback bars or duplicate audio');
  win.minimize(); await sleep(250);
  assert.equal(children().every(w=>w.isVisible()),true); win.restore();
  console.log('PASS all PiP windows remain visible when main app is minimized');
  const child=children().find(w=>w.getTitle().startsWith('Viewer 1'));
  assert.ok(child);
  await child.webContents.executeJavaScript("document.getElementById('volume').value='300'; document.getElementById('volume').dispatchEvent(new Event('input')); true",true);
  assert.equal(await evaluate("players[1].root.querySelector('.tile-volume').value"),'300');
  assert.equal(await evaluate("players[1].video.muted"),true);
  await child.webContents.executeJavaScript("document.getElementById('mute').click(); true",true);
  assert.equal(await evaluate("players[1].root.querySelector('.tile-mute').getAttribute('aria-pressed')"),'true');
  await child.webContents.executeJavaScript("document.getElementById('mute').click(); true",true);
  assert.equal(await child.webContents.executeJavaScript("document.getElementById('level').textContent"),'300%');
  await evaluate("players[1].root.querySelector('.tile-volume').value='45'; players[1].root.querySelector('.tile-volume').dispatchEvent(new Event('input')); true");
  assert.equal(await child.webContents.executeJavaScript("document.getElementById('volume').value"),'45');
  console.log('PASS PiP volume 0-300%, mute and room controls stay synchronized');
  await child.webContents.executeJavaScript("document.getElementById('close').click(); true");
  await waitFor("document.querySelectorAll('.tile-pip[aria-pressed=true]').length===2");
  assert.equal(children().length,2);
  await click('#player1 .tile-pip');
  await waitFor("document.querySelectorAll('.tile-pip[aria-pressed=true]').length===3");
  await evaluate("players[0].player.dispose(); true");
  await sleep(100);
  assert.equal(children().length,2);
  assert.equal(await evaluate("players[0].stream.getVideoTracks()[0].readyState"),'live');
  assert.equal(await evaluate("window.open('https://example.com') === null"),true);
  console.log('PASS independent close/reopen and stream removal preserve other windows and media; external popups are blocked');
  assert.deepEqual(await evaluate('errors'),[]);
  await win.loadURL(server.url);
  assert.equal(children().length,0);
  console.log('PASS main navigation cleans up every companion window');
 } catch(error) { console.error(error); code=1; }
 finally { win?.destroy(); server?.stop(); app.exit(code); }
}
void run();
