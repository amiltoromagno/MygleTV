# Screen Room

Private screen sharing with **per-application audio**. Open a link, type a name,
share your screen; everyone else watches in a grid. No accounts, no database.

The reason this exists instead of just using an existing service: sharing a
game's audio with friends **without also sending Discord**. No browser can do
that, so there is a desktop client that can.

→ **[HANDOFF.md](HANDOFF.md)** — architecture, the platform interface, hard-won
pitfalls, and the plan for Windows. Read this first.

## Three ways to run it

| | What it is | Status |
| --- | --- | --- |
| [`screenroom/`](screenroom) | The web app + a Node signaling server | Works |
| [`screenroom-desktop/`](screenroom-desktop) | Electron client with per-app audio | **Linux works**, Windows not started |
| [`screenroom-cloudflare/`](screenroom-cloudflare) | The relay as a Worker + Durable Object | Works, deployed |

The frontend is shared, not copied: the Cloudflare config serves
`screenroom/public` directly, and the desktop client loads a Screen Room origin.
One copy of the app.

## Quick start

**Viewer (anything with a browser).** Open the shared link. That is the whole
setup.

**Host with per-app audio (Linux):**

```sh
cd screenroom-desktop
npm install
SCREENROOM_URL=https://your-worker.workers.dev/ npm start
```

`Copy invite link` in the app gives the others their URL.

**Your own relay:**

```sh
cd screenroom-cloudflare
npm install
npm run login      # opens a browser
npm run deploy
```

Or self-host the Node server instead:

```sh
cd screenroom
node server.js     # http://127.0.0.1:8080
```

**Local development without a deployed relay:** run `npm start` in
`screenroom-desktop` with no `SCREENROOM_URL`. It starts a bundled server on
port 8080. Note that a local server only reaches clients on the same machine —
the window title always names the relay in use, because two relays can both hold
a room called `main` and the result looks exactly like a broken app.

## Requirements

- **Hosting with per-app audio: Linux or Windows.** macOS is out of scope; no
  browser can capture per-app audio there.
- **Windows needs 10 build 2004+** for WASAPI process loopback.
- **HTTPS is mandatory in production.** `navigator.mediaDevices` does not exist
  on insecure origins, so plain HTTP breaks screen sharing. `.workers.dev` and
  any tunnel satisfy this; `localhost` counts too.

## Tests

```sh
cd screenroom            && npm run test:all    # signaling, WebRTC, two-browser e2e
cd screenroom-desktop    && npm test            # unit tests
cd screenroom-desktop    && npm run check:shell # frontend <-> bridge, real Chrome
cd screenroom-cloudflare && npm test            # protocol conformance
```

Checks needing real hardware (a sound server, Chrome) are separate from
`npm test` so the unit suites run anywhere.

## Licensing

The code here is original work. It deliberately does **not** fork or vendor
[VDO.Ninja](https://github.com/steveseguin/vdo.ninja), which is AGPL-3.0 and
whose author has asked that modified copies not touch his infrastructure. Some
techniques were learned by reading it — ICE candidate buffering, single-offerer
negotiation — but no code was copied.

No licence file is included yet. Add one before making this public; without it
the default is all rights reserved.
