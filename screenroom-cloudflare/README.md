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
