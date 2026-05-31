import type {
	ExtensionAPI,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

type SessionReader = Pick<
	SessionManager,
	"getLeafId" | "getBranch" | "getEntries"
>;
import {
	getMarkdownTheme,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// ── Pin = label convention ────────────────────────────────────────────────
// A pin is a pi label with a reserved emoji prefix. Untitled pins are the bare
// prefix; titled pins carry free text after it. Persistence, session-scoping,
// and survival across restarts/forks all come from pi's label system.
const PIN_PREFIX = "📌";
const PINNED_FILTER_MODE = "pinned-only";

function isPin(label: string | undefined): label is string {
	return label != null && label.startsWith(PIN_PREFIX);
}

function titleOf(label: string): string {
	return label.slice(PIN_PREFIX.length).trim();
}

function pinLabel(title: string): string {
	const t = title.trim();
	return t.length > 0 ? `${PIN_PREFIX} ${t}` : PIN_PREFIX;
}

// ── Message content extraction ──────────────────────────────────────────────
type Role = "user" | "assistant";

interface PinnableEntry {
	id: string;
	role: Role;
	timestamp: string;
	preview: string;
	markdown: string;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as { type?: string; text?: string };
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			else if (b.type === "image") parts.push("🖼 [image]");
		}
	}
	return parts.join("\n\n");
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

// Build a pinnable view of a message entry, or null if it is not a
// user/assistant message with visible text. Assistant messages that only
// carry thinking/toolCall blocks (no text) are not pin targets.
function toPinnable(entry: SessionEntry): PinnableEntry | null {
	if (entry.type !== "message") return null;
	const msg = entry.message as { role?: string; content?: unknown };
	if (msg.role !== "user" && msg.role !== "assistant") return null;
	const text = extractText(msg.content).trim();
	if (text.length === 0) return null;
	return {
		id: entry.id,
		role: msg.role,
		timestamp: entry.timestamp,
		preview: oneLine(text),
		markdown: text,
	};
}

function relativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.round(hrs / 24);
	return `${days}d ago`;
}

// ── Session queries ──────────────────────────────────────────────────────────


function lastAssistantOnBranch(sm: SessionReader): string | null {
	const leaf = sm.getLeafId();
	// getBranch returns root→leaf; walk from the end to find the most recent.
	const branch = leaf ? sm.getBranch(leaf) : sm.getEntries();
	for (let i = branch.length - 1; i >= 0; i--) {
		const p = toPinnable(branch[i]!);
		if (p && p.role === "assistant") return p.id;
	}
	return null;
}

// Raw SGR helper (theme-independent attribute the Theme API does not expose).
const ITALIC = (s: string): string => `\x1b[3m${s}\x1b[23m`;

// ── Patch the built-in /tree to add a one-key pin toggle ───────────────────
// The TreeSelectorComponent we import is the *same class object* the host news
// up for /tree (extension imports are aliased to the host module), so a single
// prototype patch makes the real /tree — and the esc-esc tree — gain Shift+P pin
// toggling on the highlighted row, matching native Shift+L label editing.
// Every host-internal access is feature-detected so a future refactor degrades
// to "no toggle" instead of crashing.
interface TreeListInternals {
	getSelectedNode?: () => { entry: SessionEntry; label?: string } | undefined;
	updateNodeLabel?: (id: string, label: string | undefined) => void;
	searchQuery?: string;
	filterMode?: string;
	applyFilter?: () => void;
	getFilterLabel?: () => string;
	recalculateVisualStructure?: () => void;
	filteredNodes?: Array<{ node: { entry: SessionEntry; label?: string } }>;
	selectedIndex?: number;
	__pinnedFilterPatched?: boolean;
}

interface TreeDetailState {
	entry: PinnableEntry;
	scroll: number;
	lines?: string[];
	width?: number;
	pendingG?: boolean;
	title: string; // pin title ("" when untitled)
	pinned: boolean; // entry carries a 📌 label
}

interface TreeSelectorInternals {
	handleInput?: (data: string) => void;
	render?: (width: number) => string[];
	children?: Array<{ text?: string; invalidate?: () => void }>;
	__pinTogglePatched?: boolean;
	__messageDetail?: TreeDetailState;
	getTreeList?: () => TreeListInternals | undefined;
	// `labelInput` is private in the host; truthy while the Shift+L editor is open.
	labelInput?: unknown;
}

// The /tree detail view is rendered from a prototype patch and a free function,
// neither of which receives a Theme (ExtensionAPI exposes none, and the live
// `theme` proxy isn't a package export). We capture it from a handler ctx so the
// box can use the same `border` token as /tree; absent a capture it degrades to
// the raw/default foreground.
let liveTheme: Theme | undefined;

function treeBorder(s: string): string {
	return liveTheme ? liveTheme.fg("border", s) : s;
}

function treeMuted(s: string): string {
	return liveTheme ? liveTheme.fg("muted", s) : s;
}

const TREE_DETAIL_BODY_HEIGHT = 20;

function clampTreeDetailScroll(state: TreeDetailState, offset: number): number {
	const total = state.lines?.length ?? 0;
	return Math.max(0, Math.min(offset, total - TREE_DETAIL_BODY_HEIGHT));
}

function treeDetailRow(width: number, content: string): string {
	const innerW = Math.max(0, width - 2);
	return treeBorder("│") + truncateToWidth(` ${content}`, innerW, "…", true) + treeBorder("│");
}

function renderTreeDetail(state: TreeDetailState, width: number): string[] {
	const lines: string[] = [];
	// Same title rules as pins: pin title when present, else role · time.
	const heading = state.title || `${state.entry.role} · ${relativeTime(state.entry.timestamp)}`;
	const titleText = ` ${state.pinned ? "📌 " : ""}${heading} `;
	const innerW = Math.max(0, width - 2);
	const fill = Math.max(0, innerW - visibleWidth(titleText));
	const left = Math.floor(fill / 2);
	const right = fill - left;
	const styledTitle = liveTheme
		? liveTheme.fg("accent", liveTheme.bold(truncateToWidth(titleText, innerW)))
		: truncateToWidth(titleText, innerW);
	lines.push(treeBorder(`╭${"─".repeat(left)}`) + styledTitle + treeBorder(`${"─".repeat(right)}╮`));
	lines.push(treeDetailRow(width, ""));

	if (!state.lines || state.width !== width) {
		state.lines = new Markdown(state.entry.markdown, 0, 0, getMarkdownTheme()).render(Math.max(1, width - 3));
		state.width = width;
	}
	const detailLines = state.lines!;
	state.scroll = clampTreeDetailScroll(state, state.scroll);
	const total = detailLines.length;
	const slice = detailLines.slice(state.scroll, state.scroll + TREE_DETAIL_BODY_HEIGHT);
	for (const md of slice) lines.push(treeDetailRow(width, md));
	for (let i = slice.length; i < TREE_DETAIL_BODY_HEIGHT; i++) lines.push(treeDetailRow(width, ""));

	if (total > TREE_DETAIL_BODY_HEIGHT) {
		const first = state.scroll + 1;
		const last = Math.min(total, state.scroll + TREE_DETAIL_BODY_HEIGHT);
		const up = state.scroll > 0 ? "▴" : " ";
		const down = last < total ? "▾" : " ";
		lines.push(treeDetailRow(width, `${up}${down} ${first}–${last}/${total} lines`));
	} else {
		lines.push(treeDetailRow(width, ""));
	}

	lines.push(treeBorder(`├${"─".repeat(Math.max(0, width - 2))}┤`));
	lines.push(treeDetailRow(width, `${ITALIC("↑↓/PgUp/PgDn")} scroll  ${ITALIC("Home/End")} ends  ${ITALIC("esc")} tree`));
	lines.push(treeBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	return lines;
}

function handleTreeDetailInput(state: TreeDetailState, data: string): boolean {
	if (data === "g") {
		if (state.pendingG) state.scroll = 0;
		state.pendingG = !state.pendingG;
		return true;
	}
	state.pendingG = false;
	if (matchesKey(data, Key.up) || data === "k") state.scroll = Math.max(0, state.scroll - 1);
	else if (matchesKey(data, Key.down) || data === "j") state.scroll = clampTreeDetailScroll(state, state.scroll + 1);
	else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) state.scroll = clampTreeDetailScroll(state, state.scroll + TREE_DETAIL_BODY_HEIGHT);
	else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) state.scroll = Math.max(0, state.scroll - TREE_DETAIL_BODY_HEIGHT);
	else if (matchesKey(data, Key.home)) state.scroll = 0;
	else if (matchesKey(data, Key.end) || data === "G") state.scroll = clampTreeDetailScroll(state, Number.MAX_SAFE_INTEGER);
	else return false;
	return true;
}

function patchTreeHelpText(selector: TreeSelectorInternals): void {
	// Original runtime text:
	// "  ↑/↓: move. ←/→: page. ctrl+left/option+left/ctrl+right/option+right: fold/branch. shift+l: label. ctrl+d/ctrl+t/ctrl+u/ctrl+l/ctrl+a: filters (ctrl+o/shift+ctrl+o cycle). ctrl+r: label time"
	const help = selector.children?.find((child) => {
		if (typeof child.text !== "string") return false;
		const text = child.text.toLowerCase();
		return text.includes("session tree") === false && text.includes("label") && text.includes("filter");
	});
	if (!help) return;
	help.text = treeMuted(
		"  ↑/↓: move. ←/→: page. Shift+L: label. Shift+P: pin. Ctrl+P: pinned. Ctrl+O/Shift+Ctrl+O: filters.",
	);
	help.invalidate?.();
}

function installPinnedFilter(list: TreeListInternals): void {
	if (list.__pinnedFilterPatched || typeof list.applyFilter !== "function") return;
	const nativeApplyFilter = list.applyFilter;
	const nativeGetFilterLabel = list.getFilterLabel;
	list.applyFilter = function (this: TreeListInternals): void {
		if (this.filterMode !== PINNED_FILTER_MODE) {
			nativeApplyFilter.call(this);
			return;
		}
		this.filterMode = "labeled-only";
		nativeApplyFilter.call(this);
		this.filterMode = PINNED_FILTER_MODE;
		this.filteredNodes = this.filteredNodes?.filter((node) => isPin(node.node.label));
		this.recalculateVisualStructure?.();
		if (this.filteredNodes && typeof this.selectedIndex === "number") {
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filteredNodes.length - 1));
		}
	};
	list.getFilterLabel = function (this: TreeListInternals): string {
		return this.filterMode === PINNED_FILTER_MODE ? " [pinned]" : (nativeGetFilterLabel?.call(this) ?? "");
	};
	list.__pinnedFilterPatched = true;
}

function cycleTreeFilter(list: TreeListInternals, direction: 1 | -1): void {
	installPinnedFilter(list);
	const modes = ["default", "no-tools", "user-only", "labeled-only", PINNED_FILTER_MODE, "all"];
	const current = modes.indexOf(list.filterMode ?? "default");
	list.filterMode = modes[(current + direction + modes.length) % modes.length];
	list.applyFilter?.();
}

function installTreePinToggle(pi: ExtensionAPI): void {
	const proto = TreeSelectorComponent.prototype as unknown as TreeSelectorInternals;
	if (proto.__pinTogglePatched) return;
	const originalInput = proto.handleInput;
	const originalRender = proto.render;
	if (typeof originalInput !== "function" || typeof originalRender !== "function") return; // host shape changed — bail safely
	proto.handleInput = function (this: TreeSelectorInternals, data: string): void {
		const list = this.getTreeList?.();
		if (list) installPinnedFilter(list);

		if (this.__messageDetail) {
			if (matchesKey(data, Key.escape)) this.__messageDetail = undefined;
			else handleTreeDetailInput(this.__messageDetail, data);
			return;
		}

		// Don't steal keys while the Shift+L label editor is focused.
		if (!this.labelInput && list && matchesKey(data, "shift+ctrl+o")) {
			cycleTreeFilter(list, -1);
			return;
		}
		if (!this.labelInput && list && matchesKey(data, "ctrl+o")) {
			cycleTreeFilter(list, 1);
			return;
		}
		if (!this.labelInput && list && matchesKey(data, Key.ctrl("p"))) {
			list.filterMode = PINNED_FILTER_MODE;
			list.applyFilter?.();
			return;
		}
		if (!this.labelInput && matchesKey(data, Key.ctrl("v"))) {
			const node = this.getTreeList?.()?.getSelectedNode?.();
			const entry = node ? toPinnable(node.entry) : null;
			if (entry) {
				const pinned = isPin(node!.label);
				const title = pinned ? titleOf(node!.label as string) : (node!.label ?? "");
				this.__messageDetail = { entry, scroll: 0, title, pinned };
				return;
			}
		}
		if (!this.labelInput && matchesKey(data, "shift+p")) {
			const node = list?.getSelectedNode?.();
			if (node && list?.updateNodeLabel) {
				const next = isPin(node.label) ? undefined : pinLabel("");
				pi.setLabel(node.entry.id, next); // persist to the session
				list.updateNodeLabel(node.entry.id, next); // sync the visible [label]
				list.applyFilter?.();
				return; // consume
			}
		}
		originalInput.call(this, data);
	};
	proto.render = function (this: TreeSelectorInternals, width: number): string[] {
		patchTreeHelpText(this);
		return this.__messageDetail ? renderTreeDetail(this.__messageDetail, width) : originalRender.call(this, width);
	};
	proto.__pinTogglePatched = true;
}

export default function (pi: ExtensionAPI) {
	// Make the native /tree pin-aware (Shift+P toggles a 📌 label on the selection).
	installTreePinToggle(pi);

	// Capture the live theme so the /tree detail patch can use the `border` token.
	pi.on("session_start", (_e, ctx) => {
		if (ctx.hasUI) liveTheme = ctx.ui.theme;
	});

	// /pin [title] — quick-pin the most recent assistant message on the branch.
	pi.registerCommand("pin", {
		description: "Pin the last assistant message (optional title)",
		handler: async (args, ctx) => {
			const id = lastAssistantOnBranch(ctx.sessionManager);
			if (!id) {
				ctx.ui.notify("No assistant message to pin", "warning");
				return;
			}
			pi.setLabel(id, pinLabel(args));
			ctx.ui.notify(args.trim() ? `Pinned: ${args.trim()}` : "Pinned", "info");
		},
	});

	// Quick-pin shortcut — pin the most recent assistant message, no title.
	pi.registerShortcut(Key.ctrlShift("p"), {
		description: "Pin the last assistant message",
		handler: (ctx) => {
			const id = lastAssistantOnBranch(ctx.sessionManager);
			if (!id) {
				ctx.ui.notify("No assistant message to pin", "warning");
				return;
			}
			pi.setLabel(id, pinLabel(""));
			ctx.ui.notify("Pinned", "info");
		},
	});

}
