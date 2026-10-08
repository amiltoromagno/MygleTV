// Where a normal launch connects.
//
// One module for both shells, because two copies of a URL is exactly the kind of
// thing that drifts. The Windows shell previously held its own copy; it now
// delegates here.

/**
 * The deployed relay a normal launch uses.
 *
 * A desktop launcher has nowhere to put an environment variable, so for
 * click-to-run to reach anyone the default has to live in the app. This is the
 * same address the Windows build has always shipped.
 */
export const DEFAULT_APP_URL = "https://screenroom.amiltoromagno.workers.dev/";

/**
 * Resolve the relay to use.
 *
 *   1. `--url=<relay>` wins. An empty `--url=` selects local mode, which is how
 *      a developer runs the bundled server instead of the deployed one.
 *   2. `SCREENROOM_URL`, for a shell or a service file.
 *   3. The deployed relay.
 *
 * @param {{args?: string[], env?: Record<string, string|undefined>, fallback?: string}} [options]
 */
export function resolveAppUrl({
	args = process.argv,
	env = process.env,
	fallback = DEFAULT_APP_URL,
} = {}) {
	const flag = args.find((arg) => arg.startsWith("--url="));
	// Checked against undefined, not truthiness: `--url=` with nothing after it is
	// a deliberate request for local mode, not a missing value.
	if (flag !== undefined) return flag.slice("--url=".length);
	return env.SCREENROOM_URL || fallback;
}
