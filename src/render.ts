/**
 * The transcript badge (spec §10.3): one dim line under a tool result that
 * Boost changed, e.g. `boost −3.1k tokens (86%) · boost retrieve 147`.
 *
 * pi ≥ 1.0.1 lets an extension wrap how any tool's rows are drawn with
 * `pi.registerToolRenderer((name, next) => …)`; on 0.86.1 there is no such
 * call and nothing is registered (feature detection, `compat.canRenderTools`).
 *
 * The wrapper never draws the result itself. It asks the next renderer —
 * pi's built-in one, another extension's, or the tool's own — for its
 * component and adds a line after whatever that renders. Everything the
 * badge says comes from `details.jfrogBoost`, which holds numbers and labels
 * only (content.ts `BoostDetails`), so no tool output is ever re-rendered or
 * re-parsed here. A tool without a result renderer is returned unchanged:
 * pi then draws its plain-text fallback, and wrapping nothing would replace
 * that fallback with an empty row.
 *
 * Only types are used from pi, and only structurally: `ToolRenderers` and
 * the resolver type do not exist in 0.86.1's typings, which this file must
 * still typecheck against.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canRenderTools } from "./compat.ts";
import { isPlainObject } from "./content.ts";
import { percent } from "./stats.ts";
import { tokensOf } from "./status.ts";
import { LEGACY_OFFICE } from "./tools.ts";

/** pi-tui's `Component`, as much of it as the wrapper touches. */
export interface RenderComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	handleMouse?(event: unknown): unknown;
	wantsKeyRelease?: boolean;
}

interface ThemeLike {
	fg(color: string, text: string): string;
}

interface RenderContextLike {
	lastComponent?: unknown;
	[key: string]: unknown;
}

type RenderResult = (
	result: { content: unknown; details?: unknown },
	options: unknown,
	theme: ThemeLike,
	context: RenderContextLike,
) => RenderComponent;

interface ToolRenderersLike {
	renderResult?: RenderResult;
	[key: string]: unknown;
}

type Resolver = (
	toolName: string,
	next: () => ToolRenderersLike | undefined,
) => ToolRenderersLike | undefined;

/** `PDF` from `.pdf`. */
const label = (ext: unknown) =>
	typeof ext === "string" && ext ? ext.replace(/^\./, "").toUpperCase() : "file";
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** `−3.1k tokens (86%)`, or undefined when there is no saving to show. */
function saving(boost: Record<string, unknown>): string | undefined {
	const before = num(boost.before);
	const after = num(boost.after);
	if (before === undefined || after === undefined || before <= after) return undefined;
	const removed = before - after;
	return `−${tokensOf(removed)} tokens (${percent(removed, before)}%)`;
}

const retrieve = (boost: Record<string, unknown>) => {
	const id = boost.retrieveId;
	return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? ` · boost retrieve ${id}` : "";
};

/**
 * The badge text for a result's details, or undefined when Boost did not
 * change it (or the details are not what this extension writes).
 */
export function badgeFor(details: unknown): string | undefined {
	if (!isPlainObject(details)) return undefined;
	const boost = details.jfrogBoost;
	if (!isPlainObject(boost)) return undefined;
	switch (boost.kind) {
		case "compacted": {
			const saved = saving(boost);
			return saved ? `boost ${saved}${retrieve(boost)}` : undefined;
		}
		case "mcp": {
			const saved = saving(boost);
			return saved ? `boost mcp ${saved}${retrieve(boost)}` : undefined;
		}
		case "converted": {
			const name = label(boost.ext);
			if (boost.error === true) {
				return typeof boost.ext === "string" && LEGACY_OFFICE.has(boost.ext)
					? `boost: legacy ${name} cannot be converted`
					: `boost converted ${name} → text (offset past the end)`;
			}
			const lines = Array.isArray(boost.lines) ? boost.lines.map(num) : [];
			const [a, b, n] = lines;
			const range = a !== undefined && b !== undefined && n !== undefined ? ` (lines ${a}-${b} of ${n})` : "";
			return `boost converted ${name} → text${range}`;
		}
		default:
			return undefined;
	}
}

/** Cut plain text to `width` columns. The badge is ASCII plus `−` and `→`, each one column wide. */
function fit(text: string, width: number): string {
	const chars = [...text];
	if (chars.length <= width) return text;
	return width > 1 ? `${chars.slice(0, width - 1).join("")}…` : chars.slice(0, Math.max(0, width)).join("");
}

/** Wrapper → the component it wraps, so the next render can hand the inner one back. */
const innerOf = new WeakMap<object, RenderComponent>();

/**
 * The wrapped component. `render` falls back to the inner lines alone if
 * adding the badge throws (a theme without `dim`, say): a badge is never
 * worth a row that does not draw. The badge is cut to the width, because
 * pi-tui stops the whole UI on a line wider than the terminal.
 */
export function withBadge(inner: RenderComponent, badge: string, theme: ThemeLike): RenderComponent {
	const wrapper: RenderComponent = {
		render(width) {
			// The spec's shape (§10.3): anything that throws on the way — the
			// badge's styling, or an inner render that fails once on state the
			// first attempt has since settled — ends in a plain inner render.
			try {
				const lines = inner.render(width);
				return width >= 1 ? [...lines, theme.fg("dim", fit(badge, width))] : lines;
			} catch {
				return inner.render(width);
			}
		},
		invalidate() {
			inner.invalidate?.();
		},
	};
	if (typeof inner.handleInput === "function") wrapper.handleInput = inner.handleInput.bind(inner);
	if (typeof inner.handleMouse === "function") wrapper.handleMouse = inner.handleMouse.bind(inner);
	if (inner.wantsKeyRelease !== undefined) wrapper.wantsKeyRelease = inner.wantsKeyRelease;
	innerOf.set(wrapper, inner);
	return wrapper;
}

const safely = (enabled: () => boolean): boolean => {
	try {
		return enabled();
	} catch {
		return false;
	}
};

/**
 * The resolver: wraps `renderResult` of whatever renders the tool next.
 *
 * pi hands each render the component it returned last time as
 * `context.lastComponent`, and pi's own renderers reuse it (`bash` calls
 * `rebuild…(context.lastComponent ?? new Container())`). That would be this
 * wrapper, which they do not know, so the inner component is put back in its
 * place before the inner renderer runs.
 */
export function badgeResolver(enabled: () => boolean): Resolver {
	return (_toolName, next) => {
		const renderers = next();
		const inner = renderers?.renderResult;
		if (!renderers || typeof inner !== "function") return renderers;
		// Off when the row is created: pi's own renderers, untouched. Checked
		// again on each render below, for rows created while it was on.
		if (!safely(enabled)) return renderers;
		const renderResult: RenderResult = (result, options, theme, context) => {
			const last = context?.lastComponent;
			const unwrapped = typeof last === "object" && last !== null ? innerOf.get(last) : undefined;
			const component = inner(
				result,
				options,
				theme,
				unwrapped ? { ...context, lastComponent: unwrapped } : context,
			);
			let badge: string | undefined;
			try {
				badge = safely(enabled) ? badgeFor(result?.details) : undefined;
			} catch {
				badge = undefined;
			}
			return badge && component ? withBadge(component, badge, theme) : component;
		};
		return { ...renderers, renderResult };
	};
}

/**
 * Register the badge renderer on a pi that supports it. `enabled` is read on
 * every render, so turning `badges` off in `/boost settings` takes effect on
 * the next redraw without a restart. Returns whether one was registered.
 */
export function registerBadges(pi: ExtensionAPI, enabled: () => boolean): boolean {
	if (!canRenderTools(pi)) return false;
	try {
		(pi as unknown as { registerToolRenderer(resolver: Resolver): void }).registerToolRenderer(
			badgeResolver(enabled),
		);
		return true;
	} catch {
		return false;
	}
}
