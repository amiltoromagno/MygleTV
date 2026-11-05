const path = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function afterSign(context) {
	if (process.platform !== "darwin") return;
	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	console.log(`  • ad-hoc signing macOS bundle  app=${appPath}`);
	try {
		execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
	} catch {
		/* xattr is best-effort */
	}
	execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
	execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
};

