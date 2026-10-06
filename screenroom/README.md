# MygleTV

A private, deliberately small screen-sharing app for a handful of people. Open
the link, type a name, and share your screen. Everyone else sees it in a grid,
side by side, and you can watch several people at once.

- **No accounts, no auth.** The link *is* the access control. Anyone with it gets in.
- **Peer-to-peer media.** Video never touches the server.
- **Dark only, no settings.** There is no options page, by design.
- **No build step.** Plain ES modules; edit a file and reload.

## Quick start (local)

```sh
npm install
npm start
```

Then open <http://127.0.0.1:8080/?room=test>.

Two people is the minimum for anything interesting, so open a second browser
window (or a private window) and join the same room with a different name. Note
that `getDisplayMedia` needs a **secure context**: `localhost` counts, but
`http://192.168.x.x` does not. For LAN testing use the tunnel or TLS setup below.

```sh
PORT=9000 npm start      # different port
npm test                 # signaling protocol (8 checks)
npm run test:browser     # WebRTC negotiation + media flow in headless Chrome
npm run test:e2e         # the full user flow in two real browsers (18 checks)
npm run test:all         # everything
```

`test:e2e` drives the real UI end to end: both browsers go through the name
gate, join from the link, see each other in the roster, one shares, the other
receives playing video, a second person shares alongside, and stopping removes
the tile for everyone. The only thing stubbed is `getDisplayMedia`, because a
headless browser has no screen picker to offer.

## Testing with someone else

Two people need a server they can both reach, and it **must be HTTPS**:
`navigator.mediaDevices` does not exist on insecure origins, so over plain
`http://your-ip:8080` nobody can capture anything — it is not "less secure", it
is broken. Every option below is therefore a TLS proxy in front of the same Node
server, a shape the app is verified to work behind (`npm run check:proxy`).

### Fastest: a Cloudflare quick tunnel

```sh
# terminal 1 -- the app and its signaling server
cd screenroom && npm start

# terminal 2 -- a public HTTPS address for it
cloudflared tunnel --url http://127.0.0.1:8080
```

`cloudflared` prints a URL like `https://random-words.trycloudflare.com`. Send
`https://random-words.trycloudflare.com/?room=movie` to the other person, and
point your own desktop client at the same origin:

```sh
cd screenroom-desktop
SCREENROOM_URL=https://random-words.trycloudflare.com/ npm start
```

The quick tunnel is ephemeral (a new URL each run) and rate-limited. Perfect for
trying it out; not a permanent link.

### Permanent, nothing to maintain: Cloudflare Pages + a Durable Object

Cloudflare Tunnel with your own domain gives a stable hostname but still needs a
machine running. The no-server option is to move the signaling relay into a
[Durable Object](https://developers.cloudflare.com/durable-objects/) — one per
room, which maps almost line-for-line onto `server.js`'s in-memory registry.
Durable Objects are on the Workers free tier, and the
[hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
means idle rooms cost nothing. This is a port rather than a config change.

### A VPS you already own

See [Deploying to a VPS](#deploying-to-a-vps) below: systemd plus nginx
terminating TLS.

Whichever route you take, the other person only needs a browser. Your desktop
client points at the same origin with `SCREENROOM_URL`, so you keep
per-application audio and they keep Firefox.

## Deploying to a VPS

One Node process serves both the static files and the WebSocket. Put nginx in
front of it to terminate TLS.

**1. Get the code onto the box**

```sh
sudo mkdir -p /opt/screenroom
sudo chown "$USER" /opt/screenroom
# copy this directory's contents (excluding node_modules) into /opt/screenroom
cd /opt/screenroom && npm install --omit=dev
```

**2. Run it under systemd** — `/etc/systemd/system/screenroom.service`

```ini
[Unit]
Description=MygleTV
After=network.target

[Service]
Type=simple
User=screenroom
WorkingDirectory=/opt/screenroom
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Environment=MAX_ROOM_SIZE=12
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --home /opt/screenroom --shell /usr/sbin/nologin screenroom
sudo chown -R screenroom:screenroom /opt/screenroom
sudo systemctl enable --now screenroom
curl -s localhost:8080/healthz   # -> ok
```

**3. TLS with nginx** — the WebSocket needs the upgrade headers, so give `/ws`
its own block.

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name screens.example.com;

    ssl_certificate     /etc/letsencrypt/live/screens.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/screens.example.com/privkey.pem;

    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # let idle rooms stay connected
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

`certbot --nginx -d screens.example.com` will fill in the certificate paths.

**4. Share the link**

```
https://screens.example.com/?room=whatever-you-like
```

Letters, numbers, `-` and `_` only, up to 64 characters. No room in the URL
means the room is `main`. The **Copy invite link** button gives you exactly this
URL, so you can just paste it into a group chat.

## Adding a TURN relay later

Screen sharing is peer-to-peer, so it fails on symmetric NAT and strict
corporate firewalls. Adding a relay is a two-part change and nothing else in
the app moves.

Run [coturn](https://github.com/coturn/coturn) on a box with a public IP, then
uncomment the TURN entry in [`public/config.js`](public/config.js):

```js
export const ICE_SERVERS = [
	{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
	{ urls: ["turn:turn.example.com:3478"], username: "user", credential: "pass" },
];
```

The relay sees only encrypted DTLS traffic, but it does carry your bandwidth,
so keep it off the same box as the signaling server if you can.

Tuning knobs also live in `config.js`: `SHARE_MAX_BITRATE` (raise it to watch
video together, lower it on weak uplinks) and `DISPLAY_CONSTRAINTS`.

## How it works

```
browser A ──┐                          ┌── browser B
            ├── WebSocket (signaling) ──┤
            │   rooms, names, SDP/ICE   │
            └───────────┬───────────────┘
                        │
              direct WebRTC media
         (never passes through the server)
```

| File | Role |
| --- | --- |
| [`server.js`](server.js) | Static hosting + room-based signaling relay. No database |
| [`public/app.js`](public/app.js) | UI orchestration: gate, grid, roster, share toggle |
| [`public/peers.js`](public/peers.js) | The WebRTC mesh: one connection per participant |
| [`public/signaling.js`](public/signaling.js) | WebSocket wrapper with reconnect/backoff |
| [`public/config.js`](public/config.js) | Every network setting, in one place |

Three implementation details are worth knowing before you change anything.
All three came out of a real intermittent bug, so they are load-bearing rather
than stylistic.

**Transceivers are created up front.** Both sides add video and audio
transceivers when a connection opens, so the m-lines are negotiated exactly
once. Starting or stopping a share is then just `replaceTrack()` on an existing
sender — no renegotiation, no flicker, and it takes effect immediately. If you
change this to add tracks on demand, you reintroduce renegotiation races.

**Only one side opens the negotiation.** Because both ends add their
transceivers at the same moment, both would otherwise fire
`negotiationneeded` and offer simultaneously. Resolving that collision with a
rollback can leave the answering side's ICE agent wedged: it gathers *zero*
candidates and the connection sits at `connectionState: "new"` forever. So the
peer with the lower ID offers and the other waits for it. Both ends derive this
from the same ID comparison, so no extra signaling is needed, and the
answering side still contributes its transceivers through the answer.
Perfect negotiation is still in place as the safety net for *later*
renegotiation, such as an ICE restart.

**ICE candidates are buffered until a remote description exists.** Candidates
routinely win the race against the description that gives them meaning, and
`addIceCandidate()` throws in that window. Dropping them leaves the connection
half-built, so they are queued (bounded to 200) and drained once the remote
description lands. Without this, connections fail intermittently under load on
slower networks — the symptom is a share that never appears.

## Limits

- **Full mesh.** Each sharer uploads one copy per viewer. With five people all
  sharing 1080p that is roughly 12 Mbps up *per person*. Comfortable to about
  6–8 participants; beyond that you want an SFU, which is a much larger project.
- **One share per person.** Each participant can put up one screen at a time.
- **Multiple simultaneous shares are not mixed** — they are shown as separate
  tiles. Clicking a tile focuses it; `Esc` returns to the grid.
- **No chat, no recording, no moderation.** Deliberately out of scope.
- **Signaling restart drops calls.** Existing peer connections survive, but
  room membership does not, so everyone renegotiates.
