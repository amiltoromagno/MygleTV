import { DEFAULT_ROOM, DISPLAY_CONSTRAINTS } from "./config.js";
import { connectSignaling } from "./signaling.js";
import { Peer } from "./peers.js";
import {
	captureNativeAudio,
	hasNative,
	listNativeApps,
	startNativeCapture,
	stopNativeCapture,
} from "./audio-source.js";

const $ = (id) => document.getElementById(id);

const SELF_KEY = "self";
const tileKey = (peerId) => "peer:" + peerId;
const NAME_STORAGE_KEY = "screenroom.name";

// ---------------------------------------------------------------------------
// Room name, taken from the link. That link is the only access control there is.
// ---------------------------------------------------------------------------

function readRoom() {
	const fromQuery = new URLSearchParams(location.search).get("room");
	if (fromQuery) return fromQuery.trim();

	const fromHash = location.hash.replace(/^#\/?/, "").trim();
	if (fromHash) {
		try {
			return decodeURIComponent(fromHash);
		} catch {
			return fromHash;
		}
	}
	return DEFAULT_ROOM;
}

const ROOM = readRoom();
const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
	selfId: null,
	name: "",
	signaling: null,
	sharing: false,
	localStream: null,
	/** Streams beyond the display capture that need stopping (mic, native audio). */
	extraStreams: [],
	focused: null,
	/** @type {Map<string, Peer>} */
	peers: new Map(),
	/** @type {Map<string, {name: string, sharing: boolean, connection: string}>} */
	info: new Map(),
	/** @type {Map<string, MediaStream>} */
	streams: new Map(),
};

/** @type {Map<string, {root: HTMLElement, video: HTMLVideoElement, overlay: HTMLElement, nameEl: HTMLElement, mute: HTMLButtonElement}>} */
const tiles = new Map();

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function ensureTile(key, label, isSelf) {
	const existing = tiles.get(key);
	if (existing) {
		if (existing.nameEl.textContent !== label) existing.nameEl.textContent = label;
		return existing;
	}

	const root = document.createElement("figure");
	root.className = "tile";
	root.tabIndex = 0;

	const video = document.createElement("video");
	video.autoplay = true;
	video.playsInline = true;
	if (isSelf) video.muted = true; // never play our own audio back at us

	const overlay = document.createElement("div");
	overlay.className = "tile-overlay";
	overlay.textContent = isSelf ? "Your screen" : "Connecting…";

	const bar = document.createElement("figcaption");
	bar.className = "tile-bar";

	const nameEl = document.createElement("span");
	nameEl.className = "tile-name";
	nameEl.textContent = label;

	const badge = document.createElement("span");
	badge.className = "tile-badge";
	if (isSelf) badge.textContent = "You";

	const mute = document.createElement("button");
	mute.type = "button";
	mute.className = "tile-mute";
	mute.textContent = isSelf ? "🔇" : "🔊";
	mute.title = isSelf ? "Your own screen is always muted here" : "Mute this stream";
	if (isSelf) mute.disabled = true;

	bar.append(nameEl, badge, mute);
	root.append(video, overlay, bar);

	if (!isSelf) {
		mute.addEventListener("click", (event) => {
			event.stopPropagation();
			video.muted = !video.muted;
			mute.textContent = video.muted ? "🔇" : "🔊";
		});
		root.addEventListener("click", () => toggleFocus(key));
		root.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				toggleFocus(key);
			}
		});
	}

	video.addEventListener("playing", () => {
		overlay.hidden = true;
	});

	const tile = { root, video, overlay, nameEl, mute };
	tiles.set(key, tile);
	return tile;
}

function playTile(tile) {
	const attempt = tile.video.play();
	if (!attempt || !attempt.catch) return;
	attempt.catch(() => {
		// Sound was blocked. Start muted rather than showing a frozen frame, and
		// tell the user how to get audio back.
		tile.video.muted = true;
		tile.mute.textContent = "🔇";
		tile.video.play().catch(() => {});
		toast("Audio was blocked by the browser — press the speaker icon on a tile.");
	});
}

function renderStage() {
	const stage = $("stage");
	const wanted = new Set();

	if (state.sharing) wanted.add(SELF_KEY);
	for (const [id, info] of state.info) {
		if (info.sharing) wanted.add(tileKey(id));
	}

	for (const key of wanted) {
		const isSelf = key === SELF_KEY;
		const peerId = isSelf ? null : key.slice("peer:".length);
		const label = isSelf ? state.name : state.info.get(peerId)?.name || "Guest";
		const tile = ensureTile(key, label, isSelf);

		const stream = isSelf ? state.localStream : state.streams.get(peerId);
		if (stream && tile.video.srcObject !== stream) {
			tile.video.srcObject = stream;
			if (isSelf) {
				tile.overlay.hidden = true;
			} else {
				playTile(tile);
			}
		}
	}

	// Drop tiles for people who stopped sharing or left.
	for (const [key, tile] of [...tiles]) {
		if (wanted.has(key)) continue;
		tile.video.srcObject = null;
		tile.root.remove();
		tiles.delete(key);
		if (state.focused === key) state.focused = null;
	}

	// Reorder only when it actually differs, so we never move a live <video>
	// element for no reason.
	const desired = [...wanted].sort((a, b) => {
		if (a === SELF_KEY) return -1;
		if (b === SELF_KEY) return 1;
		const an = state.info.get(a.slice("peer:".length))?.name || "";
		const bn = state.info.get(b.slice("peer:".length))?.name || "";
		return an.localeCompare(bn);
	});

	const desiredRoots = desired.map((key) => tiles.get(key)?.root).filter(Boolean);
	const currentRoots = [...stage.children];
	const outOfOrder =
		desiredRoots.length !== currentRoots.length ||
		desiredRoots.some((root, index) => root !== currentRoots[index]);

	if (outOfOrder) {
		for (const root of desiredRoots) stage.append(root);
	}

	$("empty").hidden = wanted.size > 0;
	applyFocus();
}

function toggleFocus(key) {
	state.focused = state.focused === key ? null : key;
	applyFocus();
}

function applyFocus() {
	$("stage").classList.toggle("focus", Boolean(state.focused));
	for (const [key, tile] of tiles) {
		tile.root.classList.toggle("focused", key === state.focused);
	}
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

function renderRoster() {
	const list = $("rosterList");
	const entries = [{ name: state.name, sharing: state.sharing, self: true }];
	for (const info of state.info.values()) {
		entries.push({ name: info.name, sharing: info.sharing, self: false });
	}

	list.textContent = "";
	for (const entry of entries) {
		const item = document.createElement("li");
		item.className = "roster-item" + (entry.sharing ? " sharing" : "");

		const dot = document.createElement("span");
		dot.className = "roster-dot";

		const name = document.createElement("span");
		name.className = "roster-name";
		name.textContent = entry.self ? `${entry.name} (you)` : entry.name;

		item.append(dot, name);

		if (entry.sharing) {
			const tag = document.createElement("span");
			tag.className = "roster-tag";
			tag.textContent = "sharing";
			item.append(tag);
		}

		list.append(item);
	}

	$("rosterCount").textContent = entries.length ? `(${entries.length})` : "";
	renderStage();
}

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

function makePeer(id, name, sharing) {
	const existing = state.peers.get(id);
	if (existing) return existing;

	const peer = new Peer({
		id,
		// Both ends must agree who yields. They do: each knows both IDs.
		polite: state.selfId > id,
		send: (data) => state.signaling.sendSignal(id, data),
		onStream: (peerId, stream) => {
			state.streams.set(peerId, stream);
			const tile = tiles.get(tileKey(peerId));
			if (tile && tile.video.srcObject !== stream) {
				tile.video.srcObject = stream;
				playTile(tile);
			}
		},
		onStateChange: (peerId, connection) => {
			const info = state.info.get(peerId);
			if (info) info.connection = connection;
		},
	});

	state.peers.set(id, peer);
	state.info.set(id, {
		name: name || "Guest",
		sharing: sharing === true,
		connection: "new",
	});

	// If we are already sharing, the new peer should start receiving immediately.
	if (state.sharing && state.localStream) {
		peer.setScreen(
			state.localStream.getVideoTracks()[0] || null,
			state.localStream.getAudioTracks()[0] || null,
		);
	}

	return peer;
}

function removePeer(id) {
	const peer = state.peers.get(id);
	if (peer) peer.close();
	state.peers.delete(id);
	state.info.delete(id);
	state.streams.delete(id);

	const key = tileKey(id);
	const tile = tiles.get(key);
	if (tile) {
		tile.video.srcObject = null;
		tile.root.remove();
		tiles.delete(key);
		if (state.focused === key) state.focused = null;
	}
}

// Peer connections cannot survive a signaling reconnect: the IDs on the other
// end are new. Tear everything down and rebuild from the next welcome.
function resetPeers() {
	for (const peer of state.peers.values()) peer.close();
	state.peers.clear();
	state.info.clear();
	state.streams.clear();

	for (const [key, tile] of [...tiles]) {
		if (key === SELF_KEY) continue;
		tile.video.srcObject = null;
		tile.root.remove();
		tiles.delete(key);
	}
	if (state.focused && state.focused !== SELF_KEY) state.focused = null;
	renderRoster();
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

const AUDIO_STORAGE_KEY = "screenroom.audio";

/**
 * The audio picker only exists in the desktop shell. In a browser `hasNative`
 * is false, the select stays hidden, and the share flow behaves exactly as it
 * always did -- the display stream's own audio.
 */
function storedAudioChoice() {
	try {
		return localStorage.getItem(AUDIO_STORAGE_KEY) || "display";
	} catch {
		return "display";
	}
}

async function refreshAudioOptions() {
	const select = $("audioSource");
	if (!select) return;

	const previous = select.value || storedAudioChoice();

	// Two things a person actually wants: one application, or everything.
	// Anything else is noise.
	const options = [
		{ value: "none", label: "No audio" },
		{ value: "system", label: "All system audio" },
	];

	try {
		for (const entry of await listNativeApps()) {
			const suffix = entry.streams > 1 ? ` (${entry.streams} streams)` : "";
			options.push({ value: `app:${entry.app}`, label: `Only ${entry.app}${suffix}` });
		}
	} catch {
		// Listing fails when nothing is playing; the other options still work.
	}

	select.textContent = "";
	for (const option of options) {
		const element = document.createElement("option");
		element.value = option.value;
		element.textContent = option.label;
		select.append(element);
	}

	// Keep the previous pick if it is still on offer; otherwise start silent
	// rather than quietly sending more than the user expects.
	select.value = options.some((option) => option.value === previous) ? previous : "none";
}

function setupAudioPicker() {
	if (!hasNative) return;
	const select = $("audioSource");
	if (!select) return;

	select.hidden = false;
	select.value = storedAudioChoice();

	// The set of playing applications changes constantly, so refresh whenever the
	// user reaches for the picker.
	select.addEventListener("focus", () => {
		refreshAudioOptions();
	});
	select.addEventListener("change", () => {
		try {
			localStorage.setItem(AUDIO_STORAGE_KEY, select.value);
		} catch {
			/* private mode; not important */
		}
	});

	refreshAudioOptions();
}

function updateShareButton() {
	const button = $("shareBtn");
	button.textContent = state.sharing ? "Stop sharing" : "Share screen";
	button.classList.toggle("is-live", state.sharing);
}

async function startShare() {
	if (state.sharing) return;

	// In the desktop shell the picker decides; in a browser we keep the display
	// stream's own audio, exactly as before.
	const choice = hasNative ? $("audioSource")?.value || "none" : "display";

	let target = null;
	if (choice === "system") target = { mode: "system" };
	else if (choice.startsWith("app:")) target = { mode: "app", app: choice.slice("app:".length) };

	// Native capture must be set up *before* getUserMedia, so the source exists
	// by the time we go looking for it.
	let nativeStream = null;
	let audioWarning = null;
	if (target) {
		try {
			const started = await startNativeCapture(target);
			nativeStream = await captureNativeAudio(started.deviceLabel);
			state.extraStreams.push(nativeStream);
		} catch (err) {
			// A failed audio source must never stop the screen from being shared.
			// Losing the picture as well is a far worse outcome than sharing
			// silently, and it hides the real problem behind an unrelated symptom.
			nativeStream = null;
			audioWarning =
				target.mode === "system"
					? `System audio unavailable (${err.message}). Sharing without sound.`
					: `Could not capture ${target.app} (${err.message}). Sharing without sound.`;
			await stopNativeCapture();
		}
	}

	// When the audio comes from somewhere else, don't also grab the display's.
	const constraints =
		choice === "display"
			? DISPLAY_CONSTRAINTS
			: Object.assign({}, DISPLAY_CONSTRAINTS, { audio: false });

	/** Undo the native audio setup when a share cannot proceed. */
	async function abandonShare() {
		if (!nativeStream) return;
		for (const track of nativeStream.getTracks()) {
			try {
				track.stop();
			} catch {
				/* already ended */
			}
		}
		await stopNativeCapture();
	}

	let stream;
	try {
		stream = await navigator.mediaDevices.getDisplayMedia(constraints);
	} catch (err) {
		await abandonShare();
		if (err && err.name === "NotAllowedError") {
			// In a browser this is just the picker being closed, which deserves
			// silence. The desktop shell has no browser picker to close, so it
			// almost always means the screen picker never opened -- and saying
			// nothing there leaves the user with no idea what happened.
			if (hasNative) toast("The screen picker did not open. Try again, or restart the app.");
			return;
		}
		toast("Could not start sharing: " + (err?.message || err));
		return;
	}

	const videoTrack = stream.getVideoTracks()[0] || null;

	// A capture that is already finished -- the portal session ending at once, for
	// instance -- is otherwise indistinguishable from a working share until the
	// user notices nothing is moving.
	if (!videoTrack || videoTrack.readyState === "ended") {
		for (const track of stream.getTracks()) {
			try {
				track.stop();
			} catch {
				/* already ended */
			}
		}
		await abandonShare();
		toast("Screen capture ended immediately. Try again, or restart the app.");
		return;
	}
	let audioTrack = stream.getAudioTracks()[0] || null;

	if (nativeStream) {
		audioTrack = nativeStream.getAudioTracks()[0] || null;
	} else if (choice === "none") {
		audioTrack = null;
	}

	// Tell the encoder this is text/UI, not motion. This is the single biggest
	// factor in whether shared text is readable.
	if (videoTrack && "contentHint" in videoTrack) videoTrack.contentHint = "detail";

	// The browser's own "Stop sharing" bar ends the track behind our back.
	if (videoTrack) videoTrack.addEventListener("ended", () => stopShare());

	state.localStream = stream;
	state.sharing = true;
	state.signaling.setSharing(true);

	await Promise.all(
		[...state.peers.values()].map((peer) => peer.setScreen(videoTrack, audioTrack)),
	);

	updateShareButton();
	renderRoster();

	// Said after the share starts, so it reads as "this is running, but quietly"
	// rather than as a failure.
	if (audioWarning) toast(audioWarning);
}

async function stopShare() {
	if (!state.sharing) return;
	state.sharing = false;
	state.signaling.setSharing(false);

	await Promise.all([...state.peers.values()].map((peer) => peer.setScreen(null, null)));

	for (const stream of [state.localStream, ...state.extraStreams]) {
		if (!stream) continue;
		for (const track of stream.getTracks()) {
			try {
				track.stop();
			} catch {
				/* already ended */
			}
		}
	}
	state.localStream = null;
	state.extraStreams = [];

	// Puts the application's audio back on the real output.
	await stopNativeCapture();

	updateShareButton();
	renderRoster();
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function setStatus(status) {
	$("statusDot").dataset.state = status;
	$("statusText").textContent =
		status === "connected" ? "Connected" : status === "reconnecting" ? "Reconnecting…" : "Connecting…";
}

let toastTimer = null;
function toast(message) {
	const el = $("toast");
	el.textContent = message;
	el.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.hidden = true;
	}, 6000);
}

async function copyInviteLink() {
	const url = new URL(location.href);
	url.searchParams.set("room", ROOM);
	url.hash = "";
	try {
		await navigator.clipboard.writeText(url.toString());
		toast("Invite link copied.");
	} catch {
		// The clipboard API needs a secure context; fall back to showing it.
		window.prompt("Copy this invite link:", url.toString());
	}
}

// ---------------------------------------------------------------------------
// Signaling handlers
// ---------------------------------------------------------------------------

const handlers = {
	onStatus: setStatus,

	onWelcome({ id, peers }) {
		state.selfId = id;
		resetPeers();
		for (const peer of peers) makePeer(peer.id, peer.name, peer.sharing);
		renderRoster();
	},

	onPeerJoin({ id, name, sharing }) {
		makePeer(id, name, sharing);
		renderRoster();
	},

	onPeerLeave(id) {
		removePeer(id);
		renderRoster();
	},

	onPeerName(id, name) {
		const info = state.info.get(id);
		if (!info) return;
		info.name = name;
		renderRoster();
	},

	onPeerSharing(id, sharing) {
		const info = state.info.get(id);
		if (!info) return;
		info.sharing = sharing;
		renderRoster();
	},

	onSignal(from, data) {
		const peer = state.peers.get(from);
		if (peer) peer.accept(data);
	},

	onDropped() {
		resetPeers();
	},

	onError(message) {
		toast(message);
	},
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function enterRoom(name) {
	state.name = name;

	$("gate").hidden = true;
	$("app").hidden = false;
	$("roomLabel").textContent = ROOM;
	document.title = `#${ROOM} — Screen Room`;

	state.signaling = connectSignaling({ room: ROOM, name, handlers });

	$("shareBtn").addEventListener("click", () => {
		if (state.sharing) stopShare();
		else startShare();
	});
	$("copyBtn").addEventListener("click", copyInviteLink);

	// Only does anything inside the desktop shell.
	setupAudioPicker();

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && state.focused) {
			state.focused = null;
			applyFocus();
		}
	});

	window.addEventListener("beforeunload", () => {
		state.signaling?.close();
		// The shell also restores on quit; this just makes it prompt.
		stopNativeCapture();
	});

	updateShareButton();
	renderRoster();
}

function init() {
	$("gateRoom").textContent = ROOM;

	if (!ROOM_PATTERN.test(ROOM)) {
		const note = $("gateNote");
		note.hidden = false;
		note.textContent = "That room name is not valid. Use letters, numbers, dashes or underscores.";
	}

	const savedName = localStorage.getItem(NAME_STORAGE_KEY);
	if (savedName) $("nameInput").value = savedName;

	$("gateForm").addEventListener("submit", (event) => {
		event.preventDefault();
		if (!ROOM_PATTERN.test(ROOM)) return;
		const name = $("nameInput").value.trim().slice(0, 32);
		if (!name) return;
		try {
			localStorage.setItem(NAME_STORAGE_KEY, name);
		} catch {
			/* private browsing; not important */
		}
		enterRoom(name);
	});

	$("nameInput").focus();
}

init();
