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

// What to ask getDisplayMedia for. Screen content is text-heavy, so we cap the
// frame rate rather than the resolution: sharp beats smooth for reading.
export const DISPLAY_CONSTRAINTS = {
	video: {
		frameRate: { ideal: 30, max: 30 },
	},
	audio: true,
};

// Ceiling for a single screen share, per viewer. Raise for high-motion video
// (watching a film together), lower on weak uplinks.
export const SHARE_MAX_BITRATE = 4_000_000;
