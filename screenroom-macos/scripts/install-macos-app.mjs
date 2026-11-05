import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
	path.join(root, "dist/macos/mac-arm64/MygleTV.app"),
	path.join(root, "dist/macos/mac/MygleTV.app"),
	path.join(root, "dist/macos/mac-x64/MygleTV.app"),
];

const sourceApp = candidates.find((p) => fs.existsSync(p));
if (!sourceApp) {
	console.error("Built MygleTV.app not found in dist/macos/. Run npm run pack:macos first.");
	process.exit(1);
}

const targetApp = "/Applications/MygleTV.app";

if (process.argv.includes("--uninstall")) {
	if (fs.existsSync(targetApp)) {
		fs.rmSync(targetApp, { recursive: true, force: true });
		console.log(`Removed ${targetApp}`);
	} else {
		console.log(`${targetApp} is not installed.`);
	}
	process.exit(0);
}

console.log(`Installing ${sourceApp} -> ${targetApp} ...`);
if (fs.existsSync(targetApp)) {
	fs.rmSync(targetApp, { recursive: true, force: true });
}
execFileSync("ditto", [sourceApp, targetApp], { stdio: "inherit" });
try {
	execFileSync("xattr", ["-cr", targetApp], { stdio: "inherit" });
} catch {
	/* best effort */
}
execFileSync("codesign", ["--force", "--deep", "--sign", "-", targetApp], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", targetApp], { stdio: "inherit" });
console.log(`Installed ${targetApp} successfully!`);

