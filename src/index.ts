import type {
	ExtensionAPI,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

type SessionReader = Pick<
	SessionManager,
	"getLeafId" | "getBranch" | "getEntries" | "getLabel"
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
	type Component,
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

interface PinView extends PinnableEntry {
	title: string; // "" when untitled
}

// All pins across the entire session tree (not just the current branch),
// chronological by the pinned message's timestamp.
function allPins(sm: SessionReader): PinView[] {
	const pins: PinView[] = [];
	for (const entry of sm.getEntries()) {
		const label = sm.getLabel(entry.id);
		if (!isPin(label)) continue;
		const p = toPinnable(entry);
		if (!p) continue;
		pins.push({ ...p, title: titleOf(label) });
	}
	pins.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
	return pins;
}

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

// ── Filter helpers ────────────────────────────────────────────────────────────
function matchesSearch(haystack: string, search: string): boolean {
	if (search.length === 0) return true;
	return haystack.toLowerCase().includes(search.toLowerCase());
}

// Translate raw key data into a printable character for inline text capture,
// or null if it is not a plain printable key.
function printableChar(data: string): string | null {
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 32 && code !== 127) return data;
	}
	return null;
}

// Raw SGR helpers (theme-independent attributes the Theme API doesn't expose).
const ITALIC = (s: string): string => `\x1b[3m${s}\x1b[23m`;
const STRIKE = (s: string): string => `\x1b[9m${s}\x1b[29m`;

// ── Pin browser: list / detail / edit, with staged unpin ───────────────────────
type Mode = "list" | "detail" | "edit";

class PinBrowser implements Component {
	private mode: Mode = "list";
	private search = "";
	private selected: number;
	private editBuffer = "";
	private readonly maxVisible = 12;
	private readonly pendingUnpin = new Set<string>();
	// Detail view is self-scrolling: the message is flattened to lines once, then
	// a window of them is shown. (Overlays have no native scroll; maxHeight only
	// hard-clips the bottom, so the component must page itself.)
	private detailLines?: string[];
	private detailWidth?: number;
	private detailScroll = 0;
	private pendingG = false; // armed by a bare "g", consumed by the second (gg)

	constructor(
		private readonly pins: PinView[],
		private readonly theme: Theme,
		private readonly viewportRows: () => number,
		private readonly commitUnpin: (id: string) => void,
		private readonly retitle: (id: string, title: string) => void,
		private readonly onClose: () => void,
	) {
		// Start selection on the most recent pin (bottom of the chronological list).
		this.selected = Math.max(0, pins.length - 1);
	}

	private visiblePins(): PinView[] {
		return this.pins.filter((p) =>
			matchesSearch(`${p.title} ${p.preview}`, this.search),
		);
	}

	private current(): PinView | undefined {
		return this.visiblePins()[this.selected];
	}

	private close(): void {
		// Commit point: apply all staged unpins in one pass on close.
		for (const id of this.pendingUnpin) this.commitUnpin(id);
		this.onClose();
	}

	handleInput(data: string): void {
		if (this.mode === "edit") return this.handleEditInput(data);
		if (this.mode === "detail") return this.handleDetailInput(data);
		return this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		const rows = this.visiblePins();
		if (matchesKey(data, Key.up)) {
			this.selected = this.selected <= 0 ? rows.length - 1 : this.selected - 1;
		} else if (matchesKey(data, Key.down)) {
			this.selected = this.selected >= rows.length - 1 ? 0 : this.selected + 1;
		} else if (matchesKey(data, Key.enter)) {
			if (this.current()) {
				this.enterDetail();
			}
		} else if (matchesKey(data, "shift+p")) {
			this.togglePending();
		} else if (matchesKey(data, Key.ctrl("e"))) {
			this.beginEdit();
		} else if (matchesKey(data, Key.escape)) {
			this.close();
		} else if (matchesKey(data, Key.backspace)) {
			this.search = this.search.slice(0, -1);
			this.selected = 0;
		} else {
			const ch = printableChar(data);
			if (ch !== null) {
				this.search += ch;
				this.selected = 0;
			}
		}
	}

	// Detail is a pure reader (no fuzzy search), so vim motions are safe here:
	// j/k line, ctrl+d/ctrl+u page, gg/G ends — alongside the arrow/Page/Home keys.
	private handleDetailInput(data: string): void {
		// gg: a bare "g" arms; the next "g" jumps to the top.
		if (data === "g") {
			if (this.pendingG) this.detailScroll = 0;
			this.pendingG = !this.pendingG;
			return;
		}
		this.pendingG = false;

		if (matchesKey(data, Key.escape)) {
			this.mode = "list";
		} else if (matchesKey(data, "shift+p")) {
			this.togglePending();
			this.mode = "list"; // mark-and-return, per design
		} else if (matchesKey(data, Key.ctrl("e"))) {
			this.beginEdit();
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.detailScroll = Math.max(0, this.detailScroll - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.detailScroll = this.clampScroll(this.detailScroll + 1);
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			this.detailScroll = this.clampScroll(this.detailScroll + this.detailBodyHeight());
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			this.detailScroll = Math.max(0, this.detailScroll - this.detailBodyHeight());
		} else if (matchesKey(data, Key.home)) {
			this.detailScroll = 0;
		} else if (matchesKey(data, Key.end) || data === "G") {
			this.detailScroll = this.clampScroll(Number.MAX_SAFE_INTEGER);
		}
	}

	// Reset and enter the scrollable detail view for the current pin.
	private enterDetail(): void {
		this.detailLines = undefined;
		this.detailScroll = 0;
		this.pendingG = false;
		this.mode = "detail";
	}

	// Visible body rows for the detail message, derived from the terminal height
	// minus the box chrome (borders, title, padding, footer, scroll indicator).
	private detailBodyHeight(): number {
		return Math.max(3, this.viewportRows() - 9);
	}

	private clampScroll(offset: number): number {
		const total = this.detailLines?.length ?? 0;
		return Math.max(0, Math.min(offset, total - this.detailBodyHeight()));
	}

	private handleEditInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			const pin = this.current();
			if (pin) {
				this.retitle(pin.id, this.editBuffer); // retitle commits immediately
				pin.title = this.editBuffer.trim();
			}
			this.mode = "list";
		} else if (matchesKey(data, Key.escape)) {
			this.mode = "list";
		} else if (matchesKey(data, Key.backspace)) {
			this.editBuffer = this.editBuffer.slice(0, -1);
		} else {
			const ch = printableChar(data);
			if (ch !== null) this.editBuffer += ch;
		}
	}

	private togglePending(): void {
		const pin = this.current();
		if (!pin) return;
		if (this.pendingUnpin.has(pin.id)) this.pendingUnpin.delete(pin.id);
		else this.pendingUnpin.add(pin.id);
	}

	private beginEdit(): void {
		const pin = this.current();
		if (!pin) return;
		this.editBuffer = pin.title;
		this.mode = "edit";
	}

	invalidate(): void {
		this.detailLines = undefined;
	}

	render(width: number): string[] {
		if (this.mode === "detail") return this.renderDetail(width);
		if (this.mode === "edit") return this.renderEdit(width);
		return this.renderList(width);
	}

	// ── Bordered-box chrome (skill-toggle inspired) ────────────────────────────
	// A rounded panel: ╭─ title ─╮ / │ rows │ / ├─ divider ─┤ / ╰────╯. Every
	// interior line is exactly `width` columns so the side borders stay aligned.
	private border(s: string): string {
		return this.theme.fg("border", s);
	}

	private topBorder(width: number, title: string): string {
		const innerW = Math.max(0, width - 2);
		const titleText = ` ${title} `;
		const fill = Math.max(0, innerW - visibleWidth(titleText));
		const left = Math.floor(fill / 2);
		const right = fill - left;
		return (
			this.border(`╭${"─".repeat(left)}`) +
			this.theme.fg("accent", this.theme.bold(truncateToWidth(titleText, innerW))) +
			this.border(`${"─".repeat(right)}╮`)
		);
	}

	private divider(width: number): string {
		return this.border(`├${"─".repeat(Math.max(0, width - 2))}┤`);
	}

	private bottomBorder(width: number): string {
		return this.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	private emptyRow(width: number): string {
		return this.border("│") + " ".repeat(Math.max(0, width - 2)) + this.border("│");
	}

	// One interior row, left-padded by a space and right-padded to fill the box.
	private row(width: number, content: string): string {
		const innerW = Math.max(0, width - 2);
		return this.border("│") + truncateToWidth(` ${content}`, innerW, "…", true) + this.border("│");
	}

	// A row with left text and right-aligned metadata inside the box interior.
	private splitRow(width: number, left: string, meta: string): string {
		const avail = Math.max(0, width - 3); // 2 borders + 1 leading space
		const metaW = visibleWidth(meta);
		const leftMax = Math.max(0, avail - metaW - 1);
		const leftTrunc = truncateToWidth(left, leftMax, "…");
		const pad = " ".repeat(Math.max(1, avail - visibleWidth(leftTrunc) - metaW));
		return this.row(width, `${leftTrunc}${pad}${meta}`);
	}

	private searchRow(width: number): string {
		const t = this.theme;
		const cursor = t.fg("accent", "│");
		const query = this.search
			? `${this.search}${cursor}`
			: `${cursor}${t.fg("dim", ITALIC("type to filter…"))}`;
		return this.row(width, `${t.fg("accent", "◎")}  ${query}`);
	}

	private renderList(width: number): string[] {
		const t = this.theme;
		const rows = this.visiblePins();
		if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);

		const lines: string[] = [];
		lines.push(this.topBorder(width, `📌 Pinned messages (${this.pins.length})`));
		lines.push(this.emptyRow(width));
		lines.push(this.searchRow(width));
		lines.push(this.emptyRow(width));

		if (this.pendingUnpin.size > 0) {
			const n = this.pendingUnpin.size;
			lines.push(
				this.row(width, t.fg("warning", `⚠ ${n} to unpin on close · esc applies · shift+p undoes`)),
			);
			lines.push(this.emptyRow(width));
		}

		lines.push(this.divider(width));
		lines.push(this.emptyRow(width));

		if (this.pins.length === 0) {
			lines.push(this.row(width, t.fg("muted", ITALIC("No pinned messages — pin from /tree with shift+p"))));
			lines.push(this.emptyRow(width));
		} else if (rows.length === 0) {
			lines.push(this.row(width, t.fg("warning", ITALIC("No matching pins"))));
			lines.push(this.emptyRow(width));
		} else {
			const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), rows.length - this.maxVisible));
			const from = Math.max(0, start);
			const end = Math.min(rows.length, from + this.maxVisible);
			for (let i = from; i < end; i++) {
				const pin = rows[i]!;
				const sel = i === this.selected;
				const pending = this.pendingUnpin.has(pin.id);
				const prefix = sel ? t.fg("accent", "▸") : this.border("·");
				let label = `${pending ? "✗ " : ""}${pin.title || pin.preview}`;
				if (pending) label = t.fg("dim", STRIKE(label)); // staged for removal
				else if (sel) label = t.fg("accent", t.bold(label));
				const meta = t.fg("dim", `${pin.role} · ${relativeTime(pin.timestamp)}`);
				lines.push(this.splitRow(width, `${prefix} ${label}`, meta));
			}
			lines.push(this.emptyRow(width));
			if (rows.length > this.maxVisible) {
				lines.push(this.row(width, t.fg("dim", `${this.selected + 1}/${rows.length}`)));
				lines.push(this.emptyRow(width));
			}
		}

		lines.push(this.divider(width));
		lines.push(this.emptyRow(width));
		lines.push(this.row(width, t.fg("dim",
			`${ITALIC("↑↓")} navigate  ${ITALIC("enter")} reveal  ${ITALIC("shift+p")} unpin  ${ITALIC("ctrl+e")} title  ${ITALIC("esc")} close`)));
		lines.push(this.bottomBorder(width));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const t = this.theme;
		const pin = this.current();
		const lines: string[] = [];
		if (!pin) {
			lines.push(this.topBorder(width, "📌 Pin not found"));
			lines.push(this.emptyRow(width));
			lines.push(this.bottomBorder(width));
			return lines;
		}
		const heading = pin.title || `${pin.role} · ${relativeTime(pin.timestamp)}`;
		const pendingTag = this.pendingUnpin.has(pin.id) ? "  ✗ will unpin" : "";
		lines.push(this.topBorder(width, `📌 ${heading}${pendingTag}`));
		lines.push(this.emptyRow(width));

		// Flatten the message to lines once per width, then window it.
		if (!this.detailLines || this.detailWidth !== width) {
			this.detailLines = new Markdown(pin.markdown, 0, 0, getMarkdownTheme()).render(Math.max(1, width - 3));
			this.detailWidth = width;
		}
		const total = this.detailLines.length;
		const bodyHeight = this.detailBodyHeight();
		if (this.detailScroll > 0) this.detailScroll = this.clampScroll(this.detailScroll);
		const slice = this.detailLines.slice(this.detailScroll, this.detailScroll + bodyHeight);
		for (const md of slice) lines.push(this.row(width, md));
		// Pad short messages so the box keeps a stable height.
		for (let i = slice.length; i < bodyHeight; i++) lines.push(this.emptyRow(width));
		if (total > bodyHeight) {
			const first = this.detailScroll + 1;
			const last = Math.min(total, this.detailScroll + bodyHeight);
			const up = this.detailScroll > 0 ? "▴" : " ";
			const down = last < total ? "▾" : " ";
			lines.push(this.row(width, t.fg("dim", `${up}${down} ${first}–${last}/${total} lines`)));
		} else {
			lines.push(this.emptyRow(width));
		}

		lines.push(this.divider(width));
		lines.push(this.emptyRow(width));
		lines.push(this.row(width, t.fg("dim",
			`${ITALIC("↑↓/PgUp/PgDn")} scroll  ${ITALIC("shift+p")} unpin  ${ITALIC("ctrl+e")} title  ${ITALIC("esc")} back`)));
		lines.push(this.bottomBorder(width));
		return lines;
	}

	private renderEdit(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		lines.push(this.topBorder(width, "✎ Set pin title"));
		lines.push(this.emptyRow(width));
		lines.push(this.row(width, `${t.fg("accent", "›")} ${this.editBuffer}${t.fg("accent", "│")}`));
		lines.push(this.emptyRow(width));
		lines.push(this.divider(width));
		lines.push(this.emptyRow(width));
		lines.push(this.row(width, t.fg("dim",
			`${ITALIC("enter")} save  ${ITALIC("esc")} cancel  ${ITALIC("empty")} clears title`)));
		lines.push(this.bottomBorder(width));
		return lines;
	}
}

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
	title: string; // pin title ("" when untitled), used like /pins
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
// box can use the same `border` token as /pins; absent a capture it degrades to
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
	// Same title rules as /pins: pin title when present, else role · time.
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

	// /pins — reuse native /tree, starting in pinned-only mode.
	pi.registerCommand("pins", {
		description: "Browse pinned messages",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				liveTheme = theme; // keep the /tree detail in sync after theme switches
				const tree = ctx.sessionManager.getTree();
				const leaf = ctx.sessionManager.getLeafId();
				let selector!: TreeSelectorComponent;
				const revealSelected = (): void => {
					const internals = selector as unknown as TreeSelectorInternals;
					const node = internals.getTreeList?.()?.getSelectedNode?.();
					const entry = node ? toPinnable(node.entry) : null;
					if (!entry || !node) return;
					const pinned = isPin(node.label);
					const title = pinned ? titleOf(node.label as string) : (node.label ?? "");
					internals.__messageDetail = { entry, scroll: 0, title, pinned };
					tui.requestRender();
				};
				selector = new (TreeSelectorComponent as unknown as new (
					tree: ReturnType<typeof ctx.sessionManager.getTree>,
					currentLeafId: string | null,
					terminalHeight: number,
					onSelect: (entryId: string) => void,
					onCancel: () => void,
					onLabelChange: (entryId: string, label: string | undefined) => void,
					initialSelectedId?: string,
					initialFilterMode?: string,
				) => TreeSelectorComponent)(
					tree,
					leaf,
					tui.terminal.rows,
					revealSelected,
					() => done(),
					(id, label) => pi.setLabel(id, label),
					undefined,
					"labeled-only",
				);
				const list = (selector as unknown as TreeSelectorInternals).getTreeList?.();
				if (list) {
					installPinnedFilter(list);
					list.filterMode = PINNED_FILTER_MODE;
					list.searchQuery = "";
					list.applyFilter?.();
				}
				const originalHandleInput = selector.handleInput.bind(selector);
				selector.handleInput = (data: string): void => {
					if (matchesKey(data, Key.ctrl("c"))) {
						done();
						return;
					}
					originalHandleInput(data);
					tui.requestRender();
				};
				return selector;
			});
		},
	});
}
