// Tests for the room protocol.
//
// These run against the pure functions, with no Workers runtime and no sockets,
// so the behaviour is checked directly rather than inferred from a running
// server. The Node server implements the same protocol, so anything asserted
// here describes both.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	cleanName,
	describeJoin,
	describeLeave,
	describeMessage,
	MAX_MESSAGE_BYTES,
	toPeer,
} from "../src/protocol.js";

const member = (id, extra = {}) => ({
	id,
	name: id,
	sharing: false,
	joined: true,
	...extra,
});

test("a joined member can kick a specific joined peer even with duplicate names", () => {
	const members = [member("p1", { name: "Same" }), member("p2", { name: "Same" }), member("p3")];
	assert.deepEqual(describeMessage(members, "p1", { t: "kick", to: "p2" }), { effects: [{ type: "kick", to: "p2", from: "p1" }] });
});

test("kick rejects self, unknown and unjoined targets", () => {
	const members = [member("p1"), member("p2", { joined: false })];
	for (const to of ["p1", "p2", "another-room-id", null, {}]) {
		const result = describeMessage(members, "p1", { t: "kick", to });
		assert.equal(result.effects[0].type, "reply");
		assert.equal(result.effects[0].message.t, "error");
	}
});

test("unjoined and removed senders cannot kick", () => {
	const members = [member("p1", { joined: false }), member("p2")];
	for (const id of ["p1", "missing"]) assert.deepEqual(describeMessage(members, id, { t: "kick", to: "p2" }), { effects: [] });
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test("cleanName strips control characters, collapses space and caps length", () => {
	assert.equal(cleanName("  Alice  "), "Alice");
	assert.equal(cleanName("Alice\u0000\u001fBob"), "AliceBob");
	assert.equal(cleanName("Alice    Bob"), "Alice Bob");
	assert.equal(cleanName("x".repeat(80)).length, 32);
});

test("cleanName rejects anything that is not a string", () => {
	for (const value of [null, undefined, 42, {}, []]) {
		assert.equal(cleanName(value), "");
	}
});

test("toPeer exposes only what a peer needs", () => {
	assert.deepEqual(toPeer({ id: "p1", name: "Alice", sharing: true, joined: true }), {
		id: "p1",
		name: "Alice",
		sharing: true,
	});
});

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

test("a newcomer is welcomed with the peers already present", () => {
	const members = [member("p1", { name: "Alice", sharing: true })];
	const { name, effects } = describeJoin(members, "p2", "Bob");

	assert.equal(name, "Bob");
	assert.deepEqual(effects[0], {
		type: "reply",
		to: "p2",
		message: { t: "welcome", id: "p2", peers: [{ id: "p1", name: "Alice", sharing: true }] },
	});
});

test("the welcome never includes the newcomer or anyone who has not joined", () => {
	const members = [member("p1"), { id: "p9", name: "", sharing: false, joined: false }];
	const { effects } = describeJoin(members, "p2", "Bob");

	const welcome = effects.find((e) => e.type === "reply");
	assert.deepEqual(
		welcome.message.peers.map((p) => p.id),
		["p1"],
	);
});

test("everyone else is told about the newcomer", () => {
	const { effects } = describeJoin([member("p1")], "p2", "Bob");
	assert.deepEqual(effects[1], {
		type: "broadcast",
		except: "p2",
		message: { t: "peer-join", id: "p2", name: "Bob", sharing: false },
	});
});

test("an empty name becomes Guest rather than a blank roster row", () => {
	assert.equal(describeJoin([], "p1", "").name, "Guest");
	assert.equal(describeJoin([], "p1", "   ").name, "Guest");
	assert.equal(describeJoin([], "p1", 42).name, "Guest");
});

// ---------------------------------------------------------------------------
// Relaying
// ---------------------------------------------------------------------------

test("signal payloads are relayed untouched and attributed to the sender", () => {
	const members = [member("p1"), member("p2")];
	const payload = { description: { type: "offer", sdp: "v=0\r\n" } };

	const { effects } = describeMessage(members, "p1", { t: "signal", to: "p2", data: payload });

	assert.deepEqual(effects, [
		{ type: "send", to: "p2", message: { t: "signal", from: "p1", data: payload } },
	]);
});

test("signal to an unknown or departed peer is dropped", () => {
	const members = [member("p1")];
	for (const target of ["ghost", "", undefined, null, 42]) {
		const { effects } = describeMessage(members, "p1", { t: "signal", to: target, data: {} });
		assert.deepEqual(effects, [], `target ${String(target)} should not be routable`);
	}
});

test("signal to a peer who has not joined is dropped", () => {
	const members = [member("p1"), { id: "p2", name: "", sharing: false, joined: false }];
	const { effects } = describeMessage(members, "p1", { t: "signal", to: "p2", data: {} });
	assert.deepEqual(effects, []);
});

// ---------------------------------------------------------------------------
// Name and sharing state
// ---------------------------------------------------------------------------

test("a rename is broadcast and patched", () => {
	const members = [member("p1", { name: "Alice" }), member("p2")];
	const { patch, effects } = describeMessage(members, "p1", { t: "name", name: "Alicia" });

	assert.deepEqual(patch, { name: "Alicia" });
	assert.deepEqual(effects, [
		{ type: "broadcast", except: "p1", message: { t: "peer-name", id: "p1", name: "Alicia" } },
	]);
});

test("a rename to the same name is not broadcast", () => {
	const members = [member("p1", { name: "Alice" })];
	assert.deepEqual(describeMessage(members, "p1", { t: "name", name: "Alice" }).effects, []);
});

test("a rename to nothing is refused", () => {
	const members = [member("p1", { name: "Alice" })];
	assert.deepEqual(describeMessage(members, "p1", { t: "name", name: "   " }).effects, []);
	assert.equal(describeMessage(members, "p1", { t: "name", name: "" }).patch, undefined);
});

test("sharing toggles are broadcast and patched", () => {
	const members = [member("p1"), member("p2")];
	const on = describeMessage(members, "p1", { t: "sharing", on: true });

	assert.deepEqual(on.patch, { sharing: true });
	assert.deepEqual(on.effects, [
		{ type: "broadcast", except: "p1", message: { t: "peer-sharing", id: "p1", on: true } },
	]);
});

test("a sharing change that changes nothing is not broadcast", () => {
	const members = [member("p1", { sharing: true })];
	assert.deepEqual(describeMessage(members, "p1", { t: "sharing", on: true }).effects, []);
	assert.equal(describeMessage(members, "p1", { t: "sharing", on: true }).patch, undefined);
});

test("anything but an explicit true counts as not sharing", () => {
	const members = [member("p1", { sharing: true })];
	for (const value of [false, "false", 0, null, undefined, "yes"]) {
		const { patch } = describeMessage(members, "p1", { t: "sharing", on: value });
		if (patch) assert.equal(patch.sharing, false, `${String(value)} should mean off`);
	}
});

// ---------------------------------------------------------------------------
// Membership gates
// ---------------------------------------------------------------------------

test("a member who has not joined cannot signal, rename or share", () => {
	const members = [{ id: "p1", name: "", sharing: false, joined: false }];
	for (const msg of [
		{ t: "signal", to: "p1", data: {} },
		{ t: "name", name: "Sneaky" },
		{ t: "sharing", on: true },
	]) {
		assert.deepEqual(describeMessage(members, "p1", msg).effects, []);
	}
});

test("a message from an unknown socket is ignored", () => {
	const members = [member("p1")];
	assert.deepEqual(describeMessage(members, "ghost", { t: "sharing", on: true }).effects, []);
});

test("unknown message types produce nothing", () => {
	const members = [member("p1")];
	for (const msg of [{ t: "nonsense" }, { t: "join" }, { t: "" }]) {
		assert.deepEqual(describeMessage(members, "p1", msg).effects, []);
	}
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

test("a departing member is announced to the room", () => {
	const { effects } = describeLeave(member("p1"));
	assert.deepEqual(effects, [
		{ type: "broadcast", except: "p1", message: { t: "peer-leave", id: "p1" } },
	]);
});

test("a socket that never joined does not produce a departure", () => {
	assert.deepEqual(describeLeave({ id: "p1", joined: false }).effects, []);
	assert.deepEqual(describeLeave(null).effects, []);
	assert.deepEqual(describeLeave(undefined).effects, []);
});

test("the message size cap is a sane bound for an SDP blob", () => {
	assert.ok(MAX_MESSAGE_BYTES >= 64 * 1024, "must comfortably fit an offer");
	assert.ok(MAX_MESSAGE_BYTES <= 1024 * 1024, "must not be a proxy for unlimited");
});
