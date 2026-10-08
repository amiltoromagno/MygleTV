import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startAppServer } from "../app-server.js";
import { startWindowsRelayProxy, validateRelayUrl } from "../windows-relay-proxy.js";
import { WINDOWS_APP_URL, resolveWindowsUrl } from "../windows-settings.js";

let relay;
let proxy;
const sockets = [];
before(async () => {
	relay = startAppServer({ port: 8515 });
	assert.ok(await relay.ready());
	proxy = await startWindowsRelayProxy({ relayUrl: `${relay.url}?room=proxy-room`, publicDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../screenroom/public") });
});
after(() => { for (const socket of sockets) socket.terminate(); proxy?.stop(); relay?.stop(); });

function client(url, origin) {
	const socket = new WebSocket(url, origin ? { origin } : {});
	sockets.push(socket);
	const queue = [];
	const waiters = [];
	socket.on("message", (data) => {
		const message = JSON.parse(data.toString()); queue.push(message);
		for (const waiter of [...waiters]) if (waiter.test(message)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
	});
	return {
		socket,
		opened: new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }),
		wait(test) {
			const found = queue.find(test); if (found) return Promise.resolve(found);
			return new Promise((resolve, reject) => { const waiter = { test, resolve, timer: setTimeout(() => reject(new Error("message timeout")), 4000) }; waiters.push(waiter); });
		},
	};
}

test("Windows proxy serves the bundled PCM frontend and preserves room/invite", async () => {
	assert.equal(new URL(proxy.url).searchParams.get("room"), "proxy-room");
	assert.equal(proxy.inviteUrl, `${relay.url}?room=proxy-room`);
	assert.match(await (await fetch(new URL("/audio-source.js", proxy.url))).text(), /captureWindowsAudio/);
	assert.match(await (await fetch(new URL("/pcm-worklet.js", proxy.url))).text(), /mygletv-pcm/);
	assert.equal((await fetch(new URL("/missing", proxy.url))).status, 404);
});
test("proxied desktop and direct browser join the same real relay", async () => {
	const a = client(new URL("/ws?room=proxy-room", proxy.url).toString().replace("http:", "ws:"), new URL(proxy.url).origin);
	await a.opened;
	a.socket.send(JSON.stringify({ t: "join", room: "proxy-room", name: "Desktop" }));
	const welcomeA = await a.wait((m) => m.t === "welcome");
	const b = client(`${relay.url.replace("http:", "ws:")}ws?room=proxy-room`);
	await b.opened;
	b.socket.send(JSON.stringify({ t: "join", room: "proxy-room", name: "Browser" }));
	const welcomeB = await b.wait((m) => m.t === "welcome");
	assert.equal(welcomeB.peers[0].id, welcomeA.id);
	a.socket.send(JSON.stringify({ t: "signal", to: welcomeB.id, data: { offer: "unchanged" } }));
	assert.deepEqual((await b.wait((m) => m.t === "signal")).data, { offer: "unchanged" });
	b.socket.send(JSON.stringify({ t: "signal", to: welcomeA.id, data: { answer: "unchanged" } }));
	assert.deepEqual((await a.wait((m) => m.t === "signal")).data, { answer: "unchanged" });
});
test("proxy rejects websocket requests from another website", async () => {
	const socket = new WebSocket(new URL("/ws", proxy.url).toString().replace("http:", "ws:"), { origin: "https://untrusted.example" });
	await assert.rejects(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }), /socket hang up/);
});

test("Windows proxy delivers a kick and preserves its intentional close code", async () => {
	const room = "proxy-kick";
	const desktop = client(new URL(`/ws?room=${room}`, proxy.url).toString().replace("http:", "ws:"), new URL(proxy.url).origin);
	await desktop.opened;
	desktop.socket.send(JSON.stringify({ t: "join", room, name: "Desktop" }));
	const { id } = await desktop.wait((m) => m.t === "welcome");
	const browser = client(`${relay.url.replace("http:", "ws:")}ws?room=${room}`);
	await browser.opened;
	browser.socket.send(JSON.stringify({ t: "join", room, name: "Browser" }));
	await browser.wait((m) => m.t === "welcome");
	const closed = new Promise((resolve) => desktop.socket.once("close", (code) => resolve(code)));
	browser.socket.send(JSON.stringify({ t: "kick", to: id }));
	await desktop.wait((m) => m.t === "kicked");
	assert.equal(await closed, 4003);
	await browser.wait((m) => m.t === "peer-leave" && m.id === id);
});
test("relay URLs reject credentials, unsupported protocols and insecure remote hosts", () => {
	for (const url of ["file:///tmp/app", "https://user:pass@example.com", "http://example.com", "invalid"]) assert.throws(() => validateRelayUrl(url));
	assert.equal(validateRelayUrl("https://example.com/?room=abc").searchParams.get("room"), "abc");
	assert.equal(validateRelayUrl("http://127.0.0.1:8080").hostname, "127.0.0.1");
});
test("Windows opens our Cloudflare application by default, with explicit test overrides", () => {
	assert.equal(resolveWindowsUrl({ args: [], env: {} }), WINDOWS_APP_URL);
	assert.equal(WINDOWS_APP_URL, "https://screenroom.amiltoromagno.workers.dev/");
	assert.equal(resolveWindowsUrl({ args: [], env: { SCREENROOM_URL: "" } }), WINDOWS_APP_URL);
	assert.equal(resolveWindowsUrl({ args: [], env: { SCREENROOM_URL: "http://127.0.0.1:8080/" } }), "http://127.0.0.1:8080/");
	assert.equal(resolveWindowsUrl({ args: ["--url="], env: { SCREENROOM_URL: WINDOWS_APP_URL } }), "");
});
