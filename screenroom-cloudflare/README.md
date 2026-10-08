# screenroom-cloudflare

MygleTV's signaling relay as a Cloudflare Worker with one Durable Object per
room, plus the static frontend.

This replaces `screenroom/server.js` for the no-server deployment. It is a port,
not a rewrite: the protocol is identical, and `test/relay-conformance.mjs` holds
both implementations to the same expectations.

## Why the worker is still called `screenroom`

The product is MygleTV, but `wrangler.jsonc` keeps `"name": "screenroom"` on
purpose. That name determines the deployed hostname, so renaming it would move
the relay to a new URL and break every link already shared. The directory and the
worker name were left alone when the product was renamed; only comments and this
document changed.

If you do want the new name, it is a one-line change plus a redeploy, and you
accept that `screenroom.<subdomain>.workers.dev` stops being the address you
hand out.

The Worker only does two things, so there is very little to go wrong:

| Path | Handled by |
| --- | --- |
| `/ws?room=NAME` | the room's Durable Object — the signaling relay |
| `/healthz` | a plain `ok`, matching the Node server |
| everything else | the static frontend |

**It never sees audio or video.** Media is peer-to-peer; this forwards a few
kilobytes of signaling text and then goes quiet.

## Deploying

Wrangler needs your Cloudflare account. Pick one:

```sh
npx wrangler login          # opens a browser
# or, for CI / headless:
export CLOUDFLARE_API_TOKEN=...   # Workers + Durable Objects edit permission
```

Then:

```sh
cd screenroom-cloudflare
npm install
npm run deploy
```

The first deploy creates the Durable Object class (the `migrations` entry in
`wrangler.jsonc`) and prints your URL:

```
https://screenroom.YOUR-SUBDOMAIN.workers.dev
```

Check it answered:

```sh
curl https://screenroom.YOUR-SUBDOMAIN.workers.dev/healthz   # -> ok
```

`.workers.dev` is HTTPS by default, which matters: `navigator.mediaDevices` does
not exist on insecure origins, so plain HTTP would break screen sharing for
everyone.

### Pointing your own client at it

```sh
cd ../screenroom-desktop
SCREENROOM_URL=https://screenroom.YOUR-SUBDOMAIN.workers.dev/ npm start
```

Then send this to whoever you are testing with — they only need a browser:

```
https://screenroom.YOUR-SUBDOMAIN.workers.dev/?room=movie
```

### A custom domain

Add to `wrangler.jsonc` and re-deploy, or bind it in the Cloudflare dashboard
under Workers → your Worker → Settings → Domains & Routes:

```jsonc
"routes": [{ "pattern": "screens.example.com", "custom_domain": true }]
```

Note: Workers custom domains require the domain to be **on Cloudflare's
nameservers**. Cloudflare lists "custom domains outside Cloudflare zones" as
unsupported on Workers (it is supported on Pages). If the domain lives elsewhere,
move its DNS to Cloudflare first, or put the frontend on Vercel and keep this
Worker behind the scenes.

## Deploying automatically on push

The `kick` signaling message removes another joined session in the same room,
not a display name or a participant in another room. Any member may kick another
member. The removed client receives `kicked` and close code 4003; the room receives
`peer-leave` once. Removal is persisted in the socket attachment before closing,
so hibernation or queued messages cannot restore that connection. Updated clients
stop media capture and do not automatically reconnect. This is session removal,
not a permanent ban. Deploy the updated Worker as well as the frontend.

Cloudflare's own Git integration is called **Workers Builds**. There is nothing
to add to this repository — it is configured in the dashboard:

1. Cloudflare dashboard → **Workers & Pages** → select the `screenroom` Worker
2. **Settings** → **Builds** → **Connect**
3. Authorise GitHub and choose `amiltoromagno/MygleTV`
4. Set:

   | Setting | Value |
   | --- | --- |
   | Git branch | `main` |
   | **Root directory** | `/screenroom-cloudflare/` |
   | Build command | `npm test` |
   | Deploy command | `npx wrangler deploy` (the default) |

5. Save, then push a commit to trigger the first build.

### Who can trigger a deploy

Anyone with **push access to the repository**. The trigger is GitHub's push
event, so Cloudflare neither knows nor cares who authored the commit.

The repository is private, so a collaborator has to be added first
(GitHub → the repository → **Settings** → **Collaborators** → add their
username). A contributor does **not** need a Cloudflare account, dashboard
access, or any secret: the build runs under the account that connected it, using
an API token Workers Builds generates.

**A fork will not work.** A fork is a separate repository, so Cloudflare never
sees the push and the Worker is never rebuilt. Contributions have to happen on
this repository.

Two consequences worth stating plainly:

- Pushing to any branch other than `main` produces a Preview URL and leaves
  production alone, so "branch, check the preview, merge" is available for free.
- Push access to `main` is deploy access to the Worker. For a small group of
  friends that is the right trade; branch protection with required pull requests
  is the lever if it ever needs tightening.

### Why those values

**Root directory must be `/screenroom-cloudflare/`** — the directory holding
`wrangler.jsonc`. This repository is a monorepo, so Workers Builds needs to be
told which project to build.

**The build command runs the tests.** This is the point of having one. Nothing
deploys if the 22 protocol tests fail, so a broken commit cannot reach the live
relay. Leave it empty if you would rather deploy unconditionally.

It is deliberately `npm test` and not `npm ci && npm test`. Workers Builds
already installs dependencies before running the build command, so an explicit
install is duplicated work — and worse, `npm ci` hard-fails when there is no
lockfile in the directory being built. The protocol tests import nothing but
`node:test`, `node:assert` and `src/protocol.js`, so they need no dependencies at
all and cannot fail for that reason.

**The Worker name must match.** Cloudflare requires the Worker name in the
dashboard to equal `name` in `wrangler.jsonc` — both are `screenroom`. Renaming
one without the other makes every build fail. This is also why the product
rename to MygleTV left `wrangler.jsonc` alone.

### The asset path is safe

`assets.directory` is `../screenroom/public` — outside the root directory, which
looks like it might break a CI checkout. It does not: wrangler resolves asset
paths **relative to the config file**, not the working directory.

Verified rather than assumed — a dry run from the repository root with
`--config screenroom-cloudflare/wrangler.jsonc` succeeds, while pointing
`assets.directory` at a non-existent path fails with a non-zero exit. Since
Workers Builds checks out the whole repository, `../screenroom/public` resolves
correctly.

### If a build fails immediately

Two error signatures both mean the same thing: **the Root directory setting is
wrong or unset**, so the build is running at the repository root rather than in
`screenroom-cloudflare/`.

```
Installing project dependencies: bun install
No packages! Deleted empty lockfile
npm error The `npm ci` command can only install with an existing package-lock.json
```

```
ERROR Missing entry-point to Worker script or to assets directory
```

The root `package.json` exists only as a convenience test runner. It has no
dependencies and deliberately no lockfile, so "No packages!" is the giveaway that
the build is not where it should be. In the right directory there are `wrangler`
and `ws` to install, and a `wrangler.jsonc` for the deploy command to find.

Both messages are really "wrong directory", which is why the build command is
`npm test` rather than `npm ci && npm test` — the protocol tests import nothing
but Node built-ins, so they behave the same wherever they run, and the wrong
directory surfaces at the deploy step with an unmistakable error rather than as
an npm complaint about lockfiles.

### Cost and branches

Free plan: **3,000 build minutes/month, 1 concurrent build, 20 minute timeout**.
Builds here take seconds. Pushes to branches other than `main` produce Preview
URLs instead of touching production.

Optionally set **Build watch paths** (for example `screenroom/**` and
`screenroom-cloudflare/**`) so a documentation-only change does not redeploy.

### The alternative: GitHub Actions

`cloudflare/wrangler-action` in a workflow does the same job, with the config
versioned in the repository instead of the dashboard, and the ability to run the
*whole* test suite (including the browser checks) before deploying. It needs a
`CLOUDFLARE_API_TOKEN` repository secret.

There is no workflow file here on purpose: adding one that runs on every push
would fail loudly on every commit until that secret exists. Workers Builds needs
no secret handling at all, which is why it is the recommendation.

## Cost

Durable Objects are on the Workers **free** plan (SQLite-backed, which is what
`new_sqlite_classes` declares). Free tier is 100,000 requests/day and
13,000 GB-s/day. Outgoing WebSocket messages are free; incoming ones bill at a
20:1 ratio. Because the object accepts sockets with the **Hibernation API**, an
idle room is evicted and costs nothing — which is the whole reason `src/room.js`
keeps member state on the socket attachments instead of in instance fields.
Exceeding a free-tier limit fails requests rather than billing you.

## Local development

```sh
npm run dev                        # wrangler dev, no account needed
npm test                           # protocol unit tests, no runtime needed
node test/relay-conformance.mjs ws://127.0.0.1:8787/ws
node test/browser-check.mjs http://127.0.0.1:8787
npm run tail                       # live logs from the deployed Worker
```

## Layout

```
src/worker.js      entry: routes /ws to the room, /healthz, else assets
src/room.js        the Durable Object: sockets, hibernation, effect wiring
src/protocol.js    the protocol as pure functions -- no I/O, easily tested
test/protocol.test.mjs     22 unit tests over that pure core
test/relay-conformance.mjs runnable against Cloudflare *or* Node
test/browser-check.mjs     the real app, real browsers, against either
```

`assets.directory` points at `../screenroom/public`, so the frontend is
referenced in place rather than copied. One copy of the app, shared with the
Node server and the desktop shell.

## Why the room is in the URL

`/ws?room=NAME` rather than sending the room in the first message: the Durable
Object has to be chosen before a single message is read, so routing on the join
message would be too late. `signaling.js` puts the room in the URL, and the Node
server ignores the query and reads it from the join — so the same client works
against both.
