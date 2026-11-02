/**
 * The transcript badge (spec §10.3): badge texts from `details.jfrogBoost`
 * only, the wrapper's behaviour around the inner renderer, and registration
 * gated on `registerToolRenderer` existing (pi ≥ 1.0.1).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeFor, badgeResolver, type RenderComponent, registerBadges, withBadge } from "../src/render.ts";
import { createPiStub } from "./helpers/harness.ts";

const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

test("badge forms per §10.3", () => {
	assert.equal(
		badgeFor({ jfrogBoost: { kind: "compacted", before: 14_400, after: 2_000, retrieveId: 147 } }),
		"boost −3.1k tokens (86%) · boost retrieve 147",
	);
	assert.equal(
		badgeFor({ jfrogBoost: { kind: "compacted", before: 4_000, after: 1_000 } }),
		"boost −750 tokens (75%)",
	);
	assert.equal(
		badgeFor({ jfrogBoost: { kind: "converted", ext: ".pdf", lines: [1, 2000, 5400] } }),
		"boost converted PDF → text (lines 1-2000 of 5400)",
	);
	assert.equal(
		badgeFor({ jfrogBoost: { kind: "mcp", before: 19_063, after: 8_237 } }),
		"boost mcp −2.7k tokens (57%)",
	);
	assert.equal(
		badgeFor({ jfrogBoost: { kind: "converted", ext: ".doc", error: true } }),
		"boost: legacy DOC cannot be converted",
	);
});

test("no badge without Boost's details, or with details it did not write", () => {
	for (const details of [
		undefined,
		null,
		"text",
		[],
		{},
		{ truncation: {} },
		{ jfrogBoost: "compacted" },
		{ jfrogBoost: { kind: "other" } },
		{ jfrogBoost: { kind: "compacted", before: 10, after: 10 } },
		{ jfrogBoost: { kind: "compacted", before: "a lot", after: 1 } },
	]) {
		assert.equal(badgeFor(details), undefined, JSON.stringify(details));
	}
});

/** A component like pi-tui's, recording what happened to it. */
function component(lines: string[], options: { throwOnce?: boolean } = {}) {
	let throws = options.throwOnce ?? false;
	const record = { renders: 0, invalidations: 0, inputs: [] as string[] };
	const c: RenderComponent = {
		render(_width) {
			record.renders++;
			if (throws) {
				throws = false;
				throw new Error("not yet");
			}
			return lines;
		},
		invalidate() {
			record.invalidations++;
		},
		handleInput(data) {
			record.inputs.push(data);
		},
	};
	return { c, record };
}

test("the wrapper adds one dim line under the inner lines, and passes the rest through", () => {
	const { c, record } = component(["$ npm test", "3 failures"]);
	const wrapped = withBadge(c, "boost −3.1k tokens (86%)", theme);
	assert.deepEqual(wrapped.render(80), ["$ npm test", "3 failures", "<dim>boost −3.1k tokens (86%)</dim>"]);
	wrapped.invalidate();
	wrapped.handleInput?.("x");
	assert.equal(record.invalidations, 1);
	assert.deepEqual(record.inputs, ["x"]);
});

test("a badge wider than the row is cut to fit: pi-tui stops on an overlong line", () => {
	const wrapped = withBadge(component([]).c, "boost −3.1k tokens (86%) · boost retrieve 147", theme);
	const [line] = wrapped.render(12);
	assert.equal(line, "<dim>boost −3.1k…</dim>");
});

test("an inner render that throws still renders the inner lines", () => {
	const { c } = component(["inner"], { throwOnce: true });
	assert.deepEqual(withBadge(c, "boost x", theme).render(80), ["inner"]);
	const throwingTheme = {
		fg: () => {
			throw new Error("no such colour");
		},
	};
	assert.deepEqual(withBadge(component(["inner"]).c, "boost x", throwingTheme).render(80), ["inner"]);
});

const details = { jfrogBoost: { kind: "compacted", before: 8_000, after: 1_000 } };

test("the resolver wraps renderResult, and gives the inner renderer its own last component back", () => {
	const seenLast: unknown[] = [];
	const inner = component(["inner"]).c;
	const renderers = {
		renderCall: () => inner,
		renderResult: (_r: unknown, _o: unknown, _t: unknown, context: { lastComponent?: unknown }) => {
			seenLast.push(context.lastComponent);
			return inner;
		},
	};
	const resolved = badgeResolver(() => true)("bash", () => renderers);
	assert.ok(resolved?.renderResult);
	assert.equal(resolved.renderCall, renderers.renderCall, "only renderResult is wrapped");
	const first = resolved.renderResult({ content: [], details }, {}, theme, { lastComponent: undefined });
	assert.deepEqual(first.render(80), ["inner", "<dim>boost −1.8k tokens (88%)</dim>"]);
	resolved.renderResult({ content: [], details }, {}, theme, { lastComponent: first });
	assert.deepEqual(seenLast, [undefined, inner], "pi's renderers reuse lastComponent; they get theirs");
});

test("a result Boost did not change is drawn by the inner renderer alone", () => {
	const inner = component(["inner"]).c;
	const resolved = badgeResolver(() => true)("bash", () => ({ renderResult: () => inner }));
	assert.equal(resolved?.renderResult?.({ content: [] }, {}, theme, {}), inner);
});

test("without a result renderer, or with badges off, next() is returned unchanged", () => {
	const none = { renderCall: () => component([]).c };
	assert.equal(
		badgeResolver(() => true)("custom", () => none),
		none,
	);
	assert.equal(
		badgeResolver(() => true)("custom", () => undefined),
		undefined,
	);
	const renderers = { renderResult: () => component(["inner"]).c };
	assert.equal(
		badgeResolver(() => false)("bash", () => renderers),
		renderers,
	);
	// Turned off after the row was created: no badge on the next render.
	let on = true;
	const resolved = badgeResolver(() => on)("bash", () => renderers);
	on = false;
	assert.deepEqual(resolved?.renderResult?.({ content: [], details }, {}, theme, {}).render(80), ["inner"]);
});

test("two copies of the extension draw one badge, not two", () => {
	// pi chains resolvers in load order: copy A's next() is copy B's result.
	// Each copy is its own module (own innerOf), so only the global mark tells.
	const copyA = badgeResolver(() => true);
	const copyB = badgeResolver(() => true);
	const base = { renderResult: () => component(["out"]).c };
	const fromB = copyB("bash", () => base);
	const fromA = copyA("bash", () => fromB);
	assert.equal(fromA, fromB, "the outer copy leaves the inner copy's renderers alone");
	assert.deepEqual(fromA?.renderResult?.({ content: [], details }, {}, theme, {}).render(80), [
		"out",
		"<dim>boost −1.8k tokens (88%)</dim>",
	]);
	// Inner copy off: the outer one still badges.
	const fromOff = badgeResolver(() => false)("bash", () => base);
	const outer = copyA("bash", () => fromOff);
	assert.deepEqual(outer?.renderResult?.({ content: [], details }, {}, theme, {}).render(80), [
		"out",
		"<dim>boost −1.8k tokens (88%)</dim>",
	]);
});

test("a badge appears through a fake registerToolRenderer", () => {
	const stub = createPiStub({ line: "1.2" });
	assert.equal(
		registerBadges(stub.pi, () => true),
		true,
	);
	assert.equal(stub.renderers.length, 1);
	const resolver = stub.renderers[0] as ReturnType<typeof badgeResolver>;
	const resolved = resolver("bash", () => ({ renderResult: () => component(["out"]).c }));
	assert.deepEqual(resolved?.renderResult?.({ content: [], details }, {}, theme, {}).render(80), [
		"out",
		"<dim>boost −1.8k tokens (88%)</dim>",
	]);
});

test("no renderer is registered on a 0.86-shaped pi", () => {
	const stub = createPiStub({ line: "0.86" });
	assert.equal(
		registerBadges(stub.pi, () => true),
		false,
	);
	assert.deepEqual(stub.renderers, []);
});
