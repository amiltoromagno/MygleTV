#!/usr/bin/env node
//
// Verifies the app works behind a TLS-terminating reverse proxy.
//
// Every way of putting this online -- Cloudflare Tunnel, nginx, Cloudflare
// Pages -- is a TLS proxy in front of the same Node server. If the client's
// WebSocket URL derivation or the signaling handshake breaks under that shape,
// it is much cheaper to find out here than after sharing a link with someone.
//
// Builds a real HTTPS proxy that forwards both HTTP and WebSocket upgrades,
// then drives two browser sessions through it.
//
//   npm run check:proxy

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCREENROOM_DIR = path.join(path.dirname(ROOT), "screenroom");

const APP_PORT = 8491; // the ordinary MygleTV server
const PROXY_PORT = 8492; // HTTPS in front of it
const CDP_PORT = 9366;
const ROOM = "proxycheck";

const CHROME_CANDIDATES = [
	process.env.CHROME,
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const children = [];
const tempDirs = [];

function cleanup() {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* gone */
		}
	}
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}
process.on("exit", cleanup);

// ---------------------------------------------------------------------------

class Page {
	constructor(ws, label) {
		this.ws = ws;
		this.label = label;
		this.nextId = 0;
	}
	send(method, params = {}) {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const onMessage = (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.id !== id) return;
				this.ws.off("message", onMessage);
				if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
				else resolve(msg.result);
			};
			this.ws.on("message", onMessage);
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails) {
			throw new Error(
				`${this.label} threw: ` +
					(result.exceptionDetails.exception?.description || result.exceptionDetails.text),
			);
		}
		return result.result?.value;
	}
	async waitFor(expression, label, timeoutMs = 20_000) {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			try {
				if (await this.evaluate(expression)) return true;
			} catch {
				/* mid-navigation */
			}
			await sleep(200);
		}
		throw new Error(`${this.label}: timed out waiting for ${label}`);
	}
}

const failures = [];
function check(condition, label) {
	console.log(`  ${condition ? green("ok  ") : red("FAIL")} ${label}`);
	if (!condition) failures.push(label);
}

async function openPage(target) {
	const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const page = new Page(ws, target.url || "page");
	await page.send("Page.enable");
	await page.send("Runtime.enable");
	return page;
}

let exitCode = 1;

try {
	// --- the ordinary MygleTV server ---------------------------------
	const appServer = spawn(process.execPath, ["server.js"], {
		cwd: SCREENROOM_DIR,
		env: { ...process.env, PORT: String(APP_PORT), HOST: "127.0.0.1" },
		stdio: "ignore",
	});
	children.push(appServer);

	let healthy = false;
	for (let i = 0; i < 80; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${APP_PORT}/healthz`);
			if (res.ok && (await res.text()).trim() === "ok") {
				healthy = true;
				break;
			}
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	if (!healthy) throw new Error("the MygleTV server did not start");

	// --- a TLS proxy in front of it, like every real deployment ----------
	const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-proxy-"));
	tempDirs.push(certDir);
	const keyPath = path.join(certDir, "key.pem");
	const certPath = path.join(certDir, "cert.pem");
	execFileSync(
		"openssl",
		[
			"req", "-x509", "-newkey", "rsa:2048",
			"-keyout", keyPath, "-out", certPath,
			"-days", "1", "-nodes", "-subj", "/CN=localhost",
		],
		{ stdio: "ignore" },
	);

	const proxy = https.createServer(
		{ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
		(req, res) => {
			const upstream = http.request(
				{
					hostname: "127.0.0.1",
					port: APP_PORT,
					path: req.url,
					method: req.method,
					headers: req.headers,
				},
				(upstreamRes) => {
					res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
					upstreamRes.pipe(res);
				},
			);
			upstream.on("error", () => {
				res.writeHead(502);
				res.end("bad gateway");
			});
			req.pipe(upstream);
		},
	);

	// WebSocket upgrades have to be tunnelled, or signaling dies here.
	proxy.on("upgrade", (req, socket, head) => {
		const upstream = net.connect(APP_PORT, "127.0.0.1", () => {
			const headers = Object.entries(req.headers)
				.map(([name, value]) => `${name}: ${value}`)
				.join("\r\n");
			upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
			if (head && head.length) upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});

	await new Promise((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve));
	children.push({ kill: () => proxy.close() });

	const origin = `https://127.0.0.1:${PROXY_PORT}/?room=${ROOM}`;
	console.log(bold("\nTLS reverse proxy\n"));
	console.log(dim(`  https://127.0.0.1:${PROXY_PORT}/  ->  http://127.0.0.1:${APP_PORT}/`));

	// --- drive browsers through the proxy --------------------------------
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-proxy-chrome-"));
	tempDirs.push(userDataDir);
	const chrome = spawn(
		CHROME_CANDIDATES[0],
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--ignore-certificate-errors", // our proxy uses a self-signed certificate
			"--use-fake-ui-for-media-stream",
			"--autoplay-policy=no-user-gesture-required",
			"--no-first-run",
			"--no-default-browser-check",
			`--user-data-dir=${userDataDir}`,
			`--remote-debugging-port=${CDP_PORT}`,
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	children.push(chrome);

	let targets = null;
	for (let i = 0; i < 120; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
			if (res.ok) {
				targets = await res.json();
				break;
			}
		} catch {
			/* not up */
		}
		await sleep(100);
	}
	if (!targets) throw new Error("Chrome DevTools endpoint never came up");

	// Two distinct tabs, so two people can meet. The new tab has to be excluded
	// when picking the original, or both handles drive the same page.
	const secondTarget = await (
		await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })
	).json();
	const allTargets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
	const firstTarget = allTargets.find((t) => t.type === "page" && t.id !== secondTarget.id);
	if (!firstTarget) throw new Error("could not find two distinct page targets");

	const first = await openPage(firstTarget);
	const secondLiteral = await openPage(secondTarget);
	check(firstTarget.id !== secondTarget.id, "two separate browser tabs are in play");

	for (const [pageHandle, name] of [
		[first, "Alice"],
		[secondLiteral, "Bob"],
	]) {
		await pageHandle.send("Page.navigate", { url: origin });
		await pageHandle.waitFor("!!document.getElementById('gateForm')", "the gate to render");
		await pageHandle.waitFor(
			`document.getElementById('gateRoom').textContent === ${JSON.stringify(ROOM)} && !!document.activeElement && document.activeElement.id === 'nameInput'`,
			"the app to initialise",
		);
		await pageHandle.evaluate(`
			document.getElementById('nameInput').value = ${JSON.stringify(name)};
			document.getElementById('gateForm').requestSubmit();
			true;
		`);
		await pageHandle.waitFor("document.getElementById('app').hidden === false", `${name} to join`);
	}

	console.log(bold("\nThrough the proxy\n"));

	const secureContext = await first.evaluate("window.isSecureContext");
	check(secureContext === true, "the page is a secure context (mediaDevices exists)");
	check(
		(await first.evaluate("typeof navigator.mediaDevices")) === "object",
		"navigator.mediaDevices is available, so sharing is possible",
	);

	// The whole point: signaling over wss:// through the proxy.
	await first.waitFor(
		"document.getElementById('statusText').textContent === 'Connected'",
		"Alice's signaling to connect over wss",
	);
	await secondLiteral.waitFor(
		"document.getElementById('statusText').textContent === 'Connected'",
		"Bob's signaling to connect over wss",
	);
	check(true, "both clients connected their signaling over wss:// through the proxy");

	const usedWss = await first.evaluate("window.location.protocol");
	check(usedWss === "https:", "the page was loaded over https");

	// Presence proves the relay is working end to end, not just the socket.
	await first.waitFor("document.querySelectorAll('#rosterList li').length === 2", "both to appear");
	await secondLiteral.waitFor(
		"document.querySelectorAll('#rosterList li').length === 2",
		"both to appear for Bob",
	);
	check(true, "each client sees the other in the roster through the proxy");

	const names = await first.evaluate(
		"[...document.querySelectorAll('#rosterList .roster-name')].map(n => n.textContent)",
	);
	check(
		names.some((n) => n.includes("Alice")) && names.some((n) => n.includes("Bob")),
		"the roster carries both names",
	);

	exitCode = failures.length === 0 ? 0 : 1;
	if (failures.length === 0) {
		console.log(green("\nPASS -- the app works behind a TLS proxy, so any tunnel or VPS will do."));
		console.log(dim("Same shape as Cloudflare Tunnel, nginx, or Pages + Workers."));
	} else {
		console.log(red(`\nFAIL -- ${failures.length} check(s) failed:`));
		for (const failure of failures) console.log(`  - ${failure}`);
	}
} catch (err) {
	console.log(red(`\nFAIL -- ${err && err.message ? err.message : err}`));
} finally {
	cleanup();
}

process.exit(exitCode);
