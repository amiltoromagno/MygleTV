import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcFile = path.join(root, "native", "macos-audio-helper.swift");
const binDir = path.join(root, "bin");
const outFile = path.join(binDir, "macos-audio-helper");
const packagingDir = path.join(root, "packaging");
const desktopPackagingDir = path.resolve(root, "..", "screenroom-desktop", "packaging");

fs.mkdirSync(packagingDir, { recursive: true });
for (const asset of ["mygletv-512.png", "mygletv-256.png", "mygletv.svg"]) {
	const srcAsset = path.join(desktopPackagingDir, asset);
	const dstAsset = path.join(packagingDir, asset);
	if (fs.existsSync(srcAsset) && !fs.existsSync(dstAsset)) {
		fs.copyFileSync(srcAsset, dstAsset);
	}
}

if (process.platform !== "darwin") {
	console.log("[build:helper] skipping Swift compilation on non-macOS host.");
	process.exit(0);
}

fs.mkdirSync(binDir, { recursive: true });

let needsBuild = !fs.existsSync(outFile);
if (!needsBuild) {
	const srcStat = fs.statSync(srcFile);
	const binStat = fs.statSync(outFile);
	if (srcStat.mtimeMs > binStat.mtimeMs) needsBuild = true;
}

if (needsBuild || process.argv.includes("--force")) {
	console.log("[build:helper] compiling native/macos-audio-helper.swift -> bin/macos-audio-helper...");
	execFileSync(
		"swiftc",
		[
			"-O",
			"-module-cache-path",
			"/tmp/mygletv-swift-cache",
			"-parse-as-library",
			srcFile,
			"-framework",
			"Foundation",
			"-framework",
			"AppKit",
			"-framework",
			"CoreGraphics",
			"-framework",
			"CoreMedia",
			"-framework",
			"AudioToolbox",
			"-framework",
			"ScreenCaptureKit",
			"-o",
			outFile,
		],
		{ stdio: "inherit" },
	);
	fs.chmodSync(outFile, 0o755);
	console.log("[build:helper] built bin/macos-audio-helper successfully.");
}
