// Headless-browser WebRTC check.
//
// Serves the project, opens test/webrtc-check.html in headless Chrome over the
// DevTools protocol, and reports whether two real peer connections negotiated
// and moved video. Exits non-zero on failure.
//
//   npm run test:browser

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HTTP_PORT = 8401;
const CDP_PORT = 9333;
const PAGE_URL = `http://127.0.0.1:${HTTP_PORT}/test/webrtc-check.html`;
const DEADLINE_MS = 70_000;

const CHROME_CANDIDATES = [
	process.env.CHROME,
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean);

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome profile dirs created for this run, removed on the way out. */
const tempDirs = [];

// --- static server ---------------------------------------------------------

const server = http.createServer((req, res) => {
	let pathname;
	try {
		pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
	} catch {
		res.writeHead(400).end();
		return;
	}
	const filePath = path.resolve(ROOT, "." + pathname);
	if (!filePath.startsWith(ROOT)) {
		res.writeHead(403).end();
		return;
	}
	fs.readFile(filePath, (err, buf) => {
		if (err) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
		res.end(buf);
	});
});

await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));

// --- browser ---------------------------------------------------------------

function launchChrome() {
	// A dedicated profile avoids attaching to a lingering instance, which would
	// silently ignore --remote-debugging-port and hand back the wrong browser.
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenroom-wrtc-"));
	tempDirs.push(userDataDir);

	for (const bin of CHROME_CANDIDATES) {
		const child = spawn(
			bin,
			[
				"--headless=new",
				"--no-sandbox",
				"--disable-dev-shm-usage",
				"--autoplay-policy=no-user-gesture-required",
				"--no-first-run",
				"--no-default-browser-check",
				`--user-data-dir=${userDataDir}`,
				`--remote-debugging-port=${CDP_PORT}`,
				"about:blank",
			],
			{ stdio: ["ignore", "ignore", "ignore"] },
		);
		child.on("error", () => {});
		return { bin, child };
	}
	return null;
}

const launched = launchChrome();
if (!launched) {
	console.error("No Chrome/Chromium binary found. Set CHROME=/path/to/chrome.");
	server.close();
	process.exit(2);
}

const { bin, child: chrome } = launched;

function cleanup() {
	try {
		chrome.kill("SIGKILL");
	} catch {
		/* already gone */
	}
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	server.close();
}

async function waitForCdp() {
	for (let i = 0; i < 100; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
			if (res.ok) return;
		} catch {
			/* not listening yet */
		}
		await sleep(100);
	}
	throw new Error("Chrome DevTools endpoint never came up");
}

try {
	await waitForCdp();

	const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
	const page = targets.find((t) => t.type === "page");
	if (!page) throw new Error("no page target in Chrome");

	const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});

	let nextId = 0;
	function cdp(method, params) {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			const onMessage = (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.id !== id) return;
				ws.off("message", onMessage);
				if (msg.error) reject(new Error(JSON.stringify(msg.error)));
				else resolve(msg.result);
			};
			ws.on("message", onMessage);
			ws.send(JSON.stringify({ id, method, params }));
		});
	}

	await cdp("Page.enable", {});
	await cdp("Runtime.enable", {});
	await cdp("Page.navigate", { url: PAGE_URL });

	const start = Date.now();
	let payload = null;

	while (Date.now() - start < DEADLINE_MS) {
		const { result } = await cdp("Runtime.evaluate", {
			expression: "document.body.dataset.result || ''",
			returnByValue: true,
		});
		const raw = result && result.value;
		if (raw) {
			payload = JSON.parse(raw);
			break;
		}
		await sleep(400);
	}

	if (!payload) throw new Error(`timed out after ${DEADLINE_MS}ms with no result from the page`);

	console.log(`browser: ${bin}`);
	for (const step of payload.steps) console.log("  • " + step);

	if (payload.ok) {
		console.log("\nPASS — peer negotiation and media flow verified in a real browser.");
		cleanup();
		process.exit(0);
	}

	console.error("\nFAIL — " + (payload.error || "unknown"));
	if (payload.pc) console.error("peer state: " + JSON.stringify(payload.pc));
	if (payload.ice) console.error("ice:        " + JSON.stringify(payload.ice));
	cleanup();
	process.exit(1);
} catch (err) {
	console.error("FAIL — " + (err && err.message ? err.message : err));
	cleanup();
	process.exit(1);
}
