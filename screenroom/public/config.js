// All network configuration for the app lives in this one file.
//
// STUN is only used to discover your public address. It is a free, stateless
// lookup service: it never carries your media. Public STUN is enough for most
// home networks.
//
// TURN is the fallback for when a direct connection is impossible (symmetric
// NAT, strict corporate firewalls, some mobile carriers). Without it, those
// pairs simply fail to connect. When you want that reliability, run coturn and
// uncomment the entry below -- nothing else in the app needs to change.
export const ICE_SERVERS = [
	{
		urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
	},
	// {
	// 	urls: ["turn:turn.example.com:3478"],
	// 	username: "user",
	// 	credential: "pass",
	// },
];

// Used when the URL has no ?room= or #room-name.
export const DEFAULT_ROOM = "main";

// What to ask getDisplayMedia for, and the bitrate ceiling per viewer, now come
// from the shared quality profile in share-quality.js. Its defaults (4 Mbps,
// 30 FPS, native resolution) match what used to be hardcoded here, so the fixed
// constants were replaced rather than tuned.
