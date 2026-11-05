// Where a normal launch connects.

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
	if (flag !== undefined) return flag.slice("--url=".length);
	return env.SCREENROOM_URL || fallback;
}

