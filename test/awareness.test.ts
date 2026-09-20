import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOST_AWARENESS, withAwareness } from "../src/awareness.ts";

test("the awareness block is appended to the system prompt", () => {
	const result = withAwareness("You are pi.");
	assert.ok(result.startsWith("You are pi."));
	assert.ok(result.includes(BOOST_AWARENESS));
});

test("it is not appended twice when handlers chain", () => {
	const once = withAwareness("You are pi.");
	assert.equal(withAwareness(once), once);
});

test("it tells the model how to recover compacted output", () => {
	assert.ok(BOOST_AWARENESS.includes("boost retrieve <id>"));
	assert.ok(BOOST_AWARENESS.includes("DISABLE_BOOST=1"));
});

test("it stays small enough to pay for on every turn", () => {
	assert.ok(BOOST_AWARENESS.length < 1500, `${BOOST_AWARENESS.length} characters`);
});
