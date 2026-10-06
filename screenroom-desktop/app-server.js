// Starts the MygleTV web server as a child process.
//
// The desktop shell loads a MygleTV *origin* rather than bundling the
// frontend, because signaling.js derives its WebSocket URL from location.host.
// That means the origin has to be served by something that also speaks the
// signaling protocol -- so for local use the shell brings its own server up.
//
// The child runs the bundled Node via ELECTRON_RUN_AS_NODE, so the app does not
// depend on a system Node install.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_DIR = path.resolve(__dirname, "..", "screenroom");
const DEFAULT_PORT = 8080;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll /healthz until the server answers, it dies, or we run out of patience. */
export async function waitForHealth({
	url,
	isDead = () => false,
	attempts = 80,
	delayMs = 150,
	fetchImpl = fetch,
	log = () => {},
} = {}) {
	const health = new URL("/healthz", url).toString();

	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const response = await fetchImpl(health, { signal: AbortSignal.timeout(1000) });
			// Check the body, not just the status: any web server on this port would
			// answer 200, and we need to know it is specifically MygleTV.
			if (response.ok && (await response.text()).trim() === "ok") return true;
		} catch {
			// Not listening yet.
		}
		if (isDead()) return false;
		await sleep(delayMs);
	}
	log(`gave up waiting for ${health}`);
	return false;
}

/**
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {string} [options.serverDir]  directory holding screenroom/server.js
 * @param {Function} [options.log]
 */
export function startAppServer({ port = DEFAULT_PORT, serverDir = DEFAULT_SERVER_DIR, log = () => {} } = {}) {
	const url = `http://127.0.0.1:${port}/`;
	let exited = false;
	let exitInfo = null;

	const child = spawn(process.execPath, ["server.js"], {
		cwd: serverDir,
		env: {
			...process.env,
			PORT: String(port),
			HOST: "127.0.0.1",
			// Run the bundled Node rather than launching a second Electron.
			ELECTRON_RUN_AS_NODE: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	child.on("exit", (code, signal) => {
		exited = true;
		exitInfo = { code, signal };
	});
	child.on("error", (err) => {
		exited = true;
		exitInfo = { code: null, signal: null, error: err.message };
	});

	const forward = (stream) => {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text) log(`[server] ${text}`);
		});
	};
	forward(child.stdout);
	forward(child.stderr);

	return {
		url,
		port,
		child,
		get exited() {
			return exited;
		},
		get exitInfo() {
			return exitInfo;
		},

		async ready(options = {}) {
			return waitForHealth({ url, isDead: () => exited, log, ...options });
		},

		stop() {
			if (exited) return;
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		},
	};
}
