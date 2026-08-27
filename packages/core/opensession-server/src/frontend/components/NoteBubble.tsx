import React, { useEffect, useRef, useState } from "react";
import type { SessionNote } from "../lib/types";
import { Menu } from "../ui/menu";
import { toast } from "../ui/toast";
import { deleteSessionNoteApi, editSessionNoteApi } from "../lib/api";
import { IconDotsHorizontal, IconPencil, IconTrash } from "./icons";
import { MentionText } from "./MentionText";
import { UserAvatar } from "./UserAvatar";
import { getCurrentUser } from "./UserPicker";
import { openLightbox } from "./MediaLightbox";
import { noAutofill } from "../lib/composer-autofill";
import { noteSurface } from "../lib/tinted-surface";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	relative: {
			position: "relative"
	},
	mxAuto: {
			marginInline: "auto"
	},
	mb6: {
			marginBottom: "24px"
	},
	mt2: {
			marginTop: "8px"
	},
	wFull: {
			width: "100%"
	},
	maxWVarSessionCol: {
			maxWidth: "var(--session-col)"
	},
	rounded2xl: {
			borderRadius: "calc(22px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px4: {
			paddingInline: "16px"
	},
	py35: {
			paddingBlock: "14px"
	},
	mb1: {
			marginBottom: "4px"
	},
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	textRed: {
			color: "var(--red)"
	},
	flexCol: {
			flexDirection: "column"
	},
	resizeNone: {
			resize: "none"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	px25: {
			paddingInline: "10px"
	},
	py2: {
			paddingBlock: "8px"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgAccent: {
			backgroundColor: "var(--accent)"
	},
	py1: {
			paddingBlock: "4px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textOnAccent: {
			color: "var(--on-accent)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	block: {
			display: "block"
	},
	cursorZoomIn: {
			cursor: "zoom-in"
	},
	leading0: {
			lineHeight: "0"
	},
	maxH60: {
			maxHeight: "240px"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	borderLineStrong: {
			borderColor: "var(--border-strong)"
	},
	objectContain: { objectFit: "contain" },
	mlAuto: { marginLeft: "auto" },
	size7: { width: "28px", height: "28px" },
	shrink0: { flexShrink: 0 },
	justifyCenter: { justifyContent: "center" },
	border0: { borderStyle: "solid", borderWidth: 0 },
	bgTransparent: { backgroundColor: "transparent" },
	opacity0: { opacity: 0 },
	transitionOpacity: { transitionProperty: "opacity" },
	menuInteractive: {
		":hover": { "@media (hover: hover)": { backgroundColor: "var(--hover)", color: "var(--text)" } },
		":focusVisible": { opacity: 1 },
	},

	borderColorColorMixInSrgbVarYellowTint45Transparent: {
		"borderColor": "var(--yellow-tint)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--yellow-tint) 45%,transparent)"
		}
	},
	focusVisibleBorderColorVarYellow: {
		":focusVisible": {
			"borderColor": "var(--yellow)"
		}
	},
	enabledHoverBgAccentHover: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"backgroundColor": "var(--accent-hover)"
				}
			}
		}
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledOpacity50: {
		":disabled": {
			"opacity": ".5"
		}
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
});

/**
 * A team note interleaved into the session transcript — a human-to-human
 * message the agent never sees (Plain's "internal note" concept, for our own
 * sessions). Backed by src/server/session-notes.ts; rendered with a
 * deliberate yellow tint so it can't be mistaken for a prompt or an answer.
 *
 * A note is one person speaking, so only its author can edit or delete it —
 * the menu is hidden for everyone else, and the server enforces the same rule
 * rather than trusting that (403 for anyone who asks anyway).
 */

function noteTime(ts: number): string {
	const d = new Date(ts);
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === new Date().toDateString()) return time;
	return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function NoteBubble({
	note,
	sessionId,
}: {
	note: SessionNote;
	/** Absent in read-only hosts (the sub-agent pane); no session, no menu. */
	sessionId?: string;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(note.text);
	const [busy, setBusy] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const mine = note.user.trim().toLowerCase() === getCurrentUser().trim().toLowerCase();

	useEffect(() => {
		if (!editing) return;
		const el = textareaRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
		el.style.height = "";
		el.style.height = `${el.scrollHeight}px`;
	}, [editing]);

	async function save() {
		const text = draft.trim();
		if (!sessionId || !text || busy) return;
		if (text === note.text) {
			setEditing(false);
			return;
		}
		setBusy(true);
		await (async () => {
// The broadcast puts the stored note back into the transcript, so
			// there's nothing to write locally.
			await editSessionNoteApi(sessionId, note.id, text, getCurrentUser());
			setEditing(false);
})().catch(async (e: any) => {
toast(e?.message || "Failed to edit note");
}).finally(async () => {
setBusy(false);
});
	}

	async function remove() {
		if (!sessionId || busy) return;
		setBusy(true);
		await (async () => {
await deleteSessionNoteApi(sessionId, note.id, getCurrentUser());
})().catch(async (e: any) => {
toast(e?.message || "Failed to delete note");
}).finally(async () => {
setBusy(false);
});
	}

	return (
		<div {...mergeStylexProps("group", sx.relative, sx.mxAuto, sx.mb6, sx.mt2, sx.wFull, sx.maxWVarSessionCol, sx.rounded2xl, sx.px4, sx.py35)}
			style={{ background: noteSurface("transparent") }}
		>
			<div {...stylex.props(sx.mb1, sx.flex, sx.itemsCenter, sx.gap2)}>
				<UserAvatar name={note.user} size={18} />
				<span {...stylex.props(sx.fontSemibold, sx.textFg, typography.supporting)}>{note.user}</span>
				<span
					{...stylex.props(sx.fontSemibold, typography.meta)}
					style={{ color: "var(--yellow)" }}
					title="Only the team sees this note"
				>
					Note
				</span>
				<span {...stylex.props(sx.textFaint, typography.meta)}>
					{noteTime(note.ts)}
					{note.editedAt ? " · edited" : ""}
				</span>
				{mine && sessionId && !editing && (
					<Menu.Root>
						<Menu.Trigger
							aria-label="Note actions"
							{...mergeStylexProps("group-hover:opacity-100 data-[popup-open]:bg-hover data-[popup-open]:text-fg data-[popup-open]:opacity-100", sx.mlAuto, sx.flex, sx.size7, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.border0, sx.bgTransparent, sx.textDim, sx.opacity0, sx.transitionOpacity, sx.menuInteractive)}
						>
							<IconDotsHorizontal size={16} />
						</Menu.Trigger>
						<Menu.Popup align="end">
							<Menu.Item
								onClick={() => {
									setDraft(note.text);
									setEditing(true);
								}}
							>
								<IconPencil size={18} className={mergeStylexOverrideClassName("", sx.textFaint)} />
								Edit
							</Menu.Item>
							<Menu.Separator />
							<Menu.Item onClick={remove} className={mergeStylexOverrideClassName("", sx.textRed)}>
								<IconTrash size={18} />
								Delete
							</Menu.Item>
						</Menu.Popup>
					</Menu.Root>
				)}
			</div>
			{editing ? (
				<div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
					<textarea
						ref={textareaRef}
						value={draft}
						disabled={busy}
						{...noAutofill}
						onChange={(e) => {
							setDraft(e.target.value);
							e.target.style.height = "";
							e.target.style.height = `${e.target.scrollHeight}px`;
						}}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								setEditing(false);
								setDraft(note.text);
							}
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								void save();
							}
						}} {...mergeStylexProps("", sx.borderColorColorMixInSrgbVarYellowTint45Transparent, sx.focusVisibleBorderColorVarYellow, sx.wFull, sx.resizeNone, sx.roundedLg, sx.border, sx.bgSurface, sx.px25, sx.py2, sx.leadingRelaxed, sx.textFg, sx.outlineNone, typography.body)}
					/>
					<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
						<button
							type="button"
							onClick={() => void save()}
							disabled={busy || !draft.trim()} {...mergeStylexProps("", sx.enabledHoverBgAccentHover, sx.disabledCursorDefault, sx.disabledOpacity50, sx.roundedControl, sx.bgAccent, sx.px25, sx.py1, sx.fontMedium, sx.textOnAccent, typography.label)}
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => {
								setEditing(false);
								setDraft(note.text);
							}}
							disabled={busy} {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.roundedControl, sx.px25, sx.py1, sx.fontMedium, sx.textDim, typography.label)}
						>
							Cancel
						</button>
						<span {...stylex.props(sx.textFaint, typography.meta)}>⌘↵ to save · Esc to cancel</span>
					</div>
				</div>
			) : (
				<>
					{note.text && (
						<div {...stylex.props(sx.whitespacePreWrap, sx.leadingRelaxed, sx.textFg, typography.body)}>
							<MentionText text={note.text} />
						</div>
					)}
					{!!note.images?.length && (
						<div {...stylex.props(sx.mt2, sx.flex, sx.flexWrap, sx.gap2)}>
							{note.images.map((src, index) => (
								<button
									key={src}
									type="button"
									{...stylex.props(sx.focusRing, sx.block, sx.cursorZoomIn, sx.roundedLg, sx.leading0)}
									onClick={(event) =>
										openLightbox(
											note.images!.map((image) => ({ kind: "image", src: image })),
											index,
											event.currentTarget,
										)
									}
									aria-label="Open note image"
								>
									<img
										src={src}
										alt=""
										loading="lazy"
										{...stylex.props(sx.maxH60, sx.maxWFull, sx.roundedLg, sx.border, sx.borderLineStrong, sx.objectContain)}
									/>
								</button>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
