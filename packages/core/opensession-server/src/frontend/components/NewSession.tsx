import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { fetchWorktrees, fetchModels, fetchToolAccounts, fetchSandboxStatus, requestSandboxPrewarm, suggestBranch, configuredNewSessionRepo, fetchProviderAccounts, fetchRepos, cachedRepos, type RepoInfo, createWorkspaceApi, updateWorkspaceApi, deleteWorkspaceApi, ApiError, type ProviderAccountOption, type ModelOption, type SandboxStatusInfo } from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { type FileAttachment } from "../lib/images";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  onDraftsChanged,
  NEW_SESSION_DRAFT_KEY as DRAFT_KEY,
  workspaceDraftKey,
} from "../lib/drafts";
import {
  attachToDraft,
  dropStagingAttachments,
  isStaging,
  removeDraftFile,
  removeDraftImage,
  sameFiles,
  sameImages,
} from "../lib/attachments";
import { useAttachmentUploads } from "../hooks/useAttachmentUploads";
import { resolveNewSessionModel } from "../lib/default-model-pref";
import { projectComposerSessions } from "../lib/composer-session-projection";
import { baseModelId, modelEngine } from "./ModelEffortSelect";
import { getSendKeyPref, onSendKeyChanged } from "../lib/send-key-pref";
import { effectiveSendKey, MOD_ENTER_GLYPH } from "../lib/send-key";
import { isApple } from "../lib/platform";
import { NO_REPO } from "../lib/session-repo";
import { getDefaultRepoPref, setDefaultRepoPref } from "../lib/default-repo-pref";
import { repoSelectionHint, toggleRepoSelection } from "../lib/repo-selection";
import { fallbackBranchName } from "../lib/workspace-draft";
import { newSessionDefaultRepo } from "../lib/new-session-repo";
import {
  NewSessionPrompt,
  type NewSessionPromptHandle,
} from "./NewSessionPrompt";
import { ComposerContextChip } from "./ComposerContextChip";
import {
  IconPaperclip,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconConnections,
  IconDotsHorizontal,
  IconEye,
  IconReturn,
  IconBox,
  IconMessage,
  IconStack,
  IconNewBranch,
  IconX,
} from "./icons";
import type { WSClientMessage, WSServerMessage } from "../lib/types";
import { newClientSessionId } from "../lib/session-id";
import { errorMatchesPendingCreate } from "../lib/new-session-navigation";
import {
  consumeNewSessionWorkspaceDraft,
  forgetParkedNewSessionWorkspace,
  getParkedNewSessionWorkspaceId,
  rememberParkedNewSessionWorkspace,
} from "../lib/new-session-workspace-draft";
import { VoiceInput } from "./VoiceInput";
import { useIsPhone } from "../hooks/useIsPhone";
import { handOffSoftKeyboard } from "../lib/soft-keyboard";
import { PaletteSelect } from "./PaletteSelect";
import { RepoTile } from "./RepoTile";
import { ModelEffortSelect } from "./ModelEffortSelect";
import { Menu } from "../ui/menu";
import { displayName } from "../brand-logos";
import { IconTile } from "./BrandTile";
import { Tooltip } from "../ui/tooltip";
import { Modal, useEnterOnMount } from "../ui/modal";
import { composerMorph } from "../ui/motion";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { matchesShortcut } from "../lib/shortcuts";
import {
	composerBox,
	composerSend,
	composerSendDefault,
} from "../lib/composer-classes";
import {
  foregroundFileComposerOwns,
  hasDraggedFiles,
} from "../lib/file-drag";
import { FullPageFileDropOverlay } from "./FullPageFileDropOverlay";
import { askSurface } from "../lib/tinted-surface";
import { toast } from "../ui/toast";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { PhoneTopBar, PhoneTopBarAction } from "../ui/top-bar";
import {
	paletteIconBtn,
	paletteIconBtnOn,
	palettePill,
} from "../lib/palette-classes";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	srOnly: {
			clipPath: "inset(50%)",
			whiteSpace: "nowrap",
			borderWidth: "0",
			width: "1px",
			height: "1px",
			margin: "-1px",
			padding: "0",
			position: "absolute",
			overflow: "hidden"
	},
	shrink0: {
			flexShrink: "0"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},
	Absolute: {
			position: "absolute!important"
	},
	inset0: {
			inset: "0"
	},
	Z6: {
			zIndex: "6!important"
	},
	flex: {
			display: "flex"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	gapX1: {
			columnGap: "4px"
	},
	px4: {
			paddingInline: "16px"
	},
	mr1: {
			marginRight: "4px"
	},
	selfCenter: {
			alignSelf: "center"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	minW260px: {
			minWidth: "260px"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap3: {
			gap: "12px"
	},
	flexNone: {
			flex: "none"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	minW0: {
			minWidth: "0"
	},
	gap1: {
			gap: "4px"
	},
	mt05: {
			marginTop: "2px"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap05: {
			gap: "2px"
	},
	whitespaceNormal: {
			whiteSpace: "normal"
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	maxW300px: {
			maxWidth: "300px"
	},
	px2: {
			paddingInline: "8px"
	},
	pb1: {
			paddingBottom: "4px"
	},
	gap25: {
			gap: "10px"
	},
	pt15: {
			paddingTop: "6px"
	},
	mtPx: {
			marginTop: "1px"
	},
	gapPx: {
			gap: "1px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},

	phoneSize11: {
		"@media (max-width: 720px)": {
			"width": "44px",
			"height": "44px"
		}
	},
	phoneRounded999px: {
		"@media (max-width: 720px)": {
			"borderRadius": "999px"
		}
	},
	phoneBeforeRounded999px: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"borderRadius": "999px"
			}
		}
	},
	shrink: {
		"flexShrink": "1"
	},
	maxWNone: {
		"maxWidth": "none"
	},
	phoneMlAuto: {
		"@media (max-width: 720px)": {
			"marginLeft": "auto"
		}
	},
	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},
	max560pxPx9px: {
		"@media not all and (min-width: 560px)": {
			"paddingInline": "9px"
		}
	},
	relative: {
		"position": "relative"
	},
	wFull: {
		"width": "100%"
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	rounded2xl: {
		"borderRadius": "calc(22px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	invisible: {
		"visibility": "hidden"
	},
	minH0: {
		"minHeight": "0"
	},
	flex1: {
		"flex": "1"
	},
	bgHover: {
		"backgroundColor": "var(--hover)"
	},
	mx0: {
		"marginInline": "0"
	},
	phoneHidden: {
		"@media (max-width: 720px)": {
			"display": "none"
		}
	},
	textXs: {
		"fontSize": "var(--type-label)",
		"lineHeight": "var(--tw-leading,var(--text-xs--line-height))"
	},
	Mx3px: {
		"marginInline": "-3px"
	},
	transitionTransform: {
		"transitionProperty": "transform,translate,scale,rotate",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	beforeOpacity100: {
		"::before": {
			"content": "var(--tw-content)",
			"opacity": "1"
		}
	},
	afterOpacity100: {
		"::after": {
			"content": "var(--tw-content)",
			"opacity": "1"
		}
	},
	maxHCalc89dvh1rem: {
		"maxHeight": "calc(89dvh - 1rem)"
	},
	phoneMaxHCalc100dvh12px: {
		"@media (max-width: 720px)": {
			"maxHeight": "calc(100dvh - 12px)"
		}
	},
	phoneRoundedTCalc40pxVarRf: {
		"@media (max-width: 720px)": {
			"borderTopLeftRadius": "calc(40px * var(--rf))",
			"borderTopRightRadius": "calc(40px * var(--rf))"
		}
	},
	phoneRoundedBNone: {
		"@media (max-width: 720px)": {
			"borderBottomRightRadius": "0",
			"borderBottomLeftRadius": "0"
		}
	},

	rotate180: {
		"rotate": "180deg"
	},

	maxHMin560px68dvh: {
		"maxHeight": "min(560px,68dvh)"
	},
	maxWMin340pxCalc100vw1rem: {
		"maxWidth": "min(340px,100vw - 1rem)"
	},
	maxWMin360pxCalc100vw1rem: {
		"maxWidth": "min(360px,100vw - 1rem)"
	},

	borderB: {
		"borderBottomStyle": "var(--tw-border-style)",
		"borderBottomWidth": "1px"
	},
	borderTransparent: {
		"borderColor": "transparent"
	},
	pt4: {
		"paddingTop": "16px"
	},
	pb11px: {
		"paddingBottom": "11px"
	},
	phoneHAuto: {
		"@media (max-width: 720px)": {
			"height": "auto"
		}
	},
	phonePx18px: {
		"@media (max-width: 720px)": {
			"paddingInline": "18px"
		}
	},
	phonePb3: {
		"@media (max-width: 720px)": {
			"paddingBottom": "12px"
		}
	},
	phonePt18px: {
		"@media (max-width: 720px)": {
			"paddingTop": "18px"
		}
	},
	borderLine: {
		"borderColor": "var(--border)"
	},
	desktopContents: {
		"@media (min-width: 721px)": {
			"display": "contents"
		}
	},
	phoneFlex: {
		"@media (max-width: 720px)": {
			"display": "flex"
		}
	},
	phoneMinW0: {
		"@media (max-width: 720px)": {
			"minWidth": "0"
		}
	},
	phoneFlex1: {
		"@media (max-width: 720px)": {
			"flex": "1"
		}
	},
	phoneJustifyCenter: {
		"@media (max-width: 720px)": {
			"justifyContent": "center"
		}
	},
	inlineFlex: {
		"display": "inline-flex"
	},
	maxWFull: {
		"maxWidth": "100%"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	gap15: {
		"gap": "6px"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	py5px: {
		"paddingBlock": "5px"
	},
	textFg: {
		"color": "var(--text)"
	},
	transitionColors: {
		"transitionProperty": "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledOpacity55: {
		":disabled": {
			"opacity": ".55"
		}
	},
	phoneGap1: {
		"@media (max-width: 720px)": {
			"gap": "4px"
		}
	},
	phonePx25: {
		"@media (max-width: 720px)": {
			"paddingInline": "10px"
		}
	},
	phonePy15: {
		"@media (max-width: 720px)": {
			"paddingBlock": "6px"
		}
	},
	phoneTextLabel: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-label)"
		}
	},
	phoneFontMedium: {
		"@media (max-width: 720px)": {
			"--tw-font-weight": "var(--font-weight-medium)",
			"fontWeight": "var(--font-weight-medium)"
		}
	},
	Ml05: {
		"marginLeft": "-2px"
	},
	phoneSize4: {
		"@media (max-width: 720px)": {
			"width": "16px",
			"height": "16px"
		}
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phonePt1: {
		"@media (max-width: 720px)": {
			"paddingTop": "4px"
		}
	},
	phoneBlock: {
		"@media (max-width: 720px)": {
			"display": "block"
		}
	},
	desktopHidden: {
		"@media (min-width: 721px)": {
			"display": "none"
		}
	},
	mx4: {
		"marginInline": "16px"
	},
	mb2: {
		"marginBottom": "8px"
	},
	roundedMd: {
		"borderRadius": "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgRedSoft: {
		"backgroundColor": "var(--red-soft)"
	},
	px25: {
		"paddingInline": "10px"
	},
	py7px: {
		"paddingBlock": "7px"
	},
	textRed: {
		"color": "var(--red)"
	},
	gapX2: {
		"columnGap": "8px"
	},
	gapY2: {
		"rowGap": "8px"
	},
	borderT: {
		"borderTopStyle": "var(--tw-border-style)",
		"borderTopWidth": "1px"
	},
	pt9px: {
		"paddingTop": "9px"
	},
	pb35: {
		"paddingBottom": "14px"
	},
	phoneFlexWrap: {
		"@media (max-width: 720px)": {
			"flexWrap": "wrap"
		}
	},
	phonePbCalc075remEnvSafeAreaInsetBottom: {
		"@media (max-width: 720px)": {
			"paddingBottom": "calc(.75rem + env(safe-area-inset-bottom))"
		}
	},
	max560pxGapX15: {
		"@media not all and (min-width: 560px)": {
			"columnGap": "6px"
		}
	},
	max560pxGap1: {
		"@media not all and (min-width: 560px)": {
			"gap": "4px"
		}
	},
	minH8: {
		"minHeight": "32px"
	},
	phonePx35: {
		"@media (max-width: 720px)": {
			"paddingInline": "14px"
		}
	},
	bgColorMixInSrgbVarGreen18Transparent: {
		"backgroundColor": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--green) 18%,transparent)"
		}
	},
	textGreen: {
		"color": "var(--green)"
	},
	hoverBgColorMixInSrgbVarGreen26Transparent: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--green)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in srgb,var(--green) 26%,transparent)"
				}
			}
		}
	},
	disabledOpacity50: {
		":disabled": {
			"opacity": ".5"
		}
	},
	phoneContents: {
		"@media (max-width: 720px)": {
			"display": "contents"
		}
	},
	itemsStretch: {
		"alignItems": "stretch"
	},
	phoneOrder2: {
		"@media (max-width: 720px)": {
			"order": "2"
		}
	},
	phoneMt05: {
		"@media (max-width: 720px)": {
			"marginTop": "2px"
		}
	},
	phoneWFull: {
		"@media (max-width: 720px)": {
			"width": "100%"
		}
	},
	gap7px: {
		"gap": "7px"
	},
	borderNone: {
		"--tw-border-style": "none",
		"borderStyle": "none"
	},
	bgAccent: {
		"backgroundColor": "var(--accent)"
	},
	px35: {
		"paddingInline": "14px"
	},
	textOnAccent: {
		"color": "var(--on-accent)"
	},
	transitionBackgroundColorOpacity: {
		"transitionProperty": "background-color,opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
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
	disabledOpacity40: {
		":disabled": {
			"opacity": ".4"
		}
	},
	max560pxPx3: {
		"@media not all and (min-width: 560px)": {
			"paddingInline": "12px"
		}
	},
	desktopRoundedControl: {
		"@media (min-width: 721px)": {
			"borderRadius": "calc(12px * var(--rf))"
		}
	},
	desktopRoundedLControl: {
		"@media (min-width: 721px)": {
			"borderTopLeftRadius": "calc(12px * var(--rf))",
			"borderBottomLeftRadius": "calc(12px * var(--rf))"
		}
	},
	phoneRoundedL999px: {
		"@media (max-width: 720px)": {
			"borderTopLeftRadius": "999px",
			"borderBottomLeftRadius": "999px"
		}
	},
	phoneRoundedRNone: {
		"@media (max-width: 720px)": {
			"borderTopRightRadius": "0",
			"borderBottomRightRadius": "0"
		}
	},
	opacity70: {
		"opacity": ".7"
	},
	roundedRControl: {
		"borderTopRightRadius": "calc(12px * var(--rf))",
		"borderBottomRightRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	phoneMinW11: {
		"@media (max-width: 720px)": {
			"minWidth": "44px"
		}
	},
	phoneRoundedR999px: {
		"@media (max-width: 720px)": {
			"borderTopRightRadius": "999px",
			"borderBottomRightRadius": "999px"
		}
	},
	p7px: {
		"padding": "7px"
	},
	shadowInset1px00Rgba000014: {
		"--tw-shadow": "inset 1px 0 0 var(--tw-shadow-color,color-mix(in srgb, var(--color-black) 14%, transparent))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	absolute: {
		"position": "absolute"
	},
	bottomCalc1006px: {
		"bottom": "calc(100% + 6px)"
	},
	right0: {
		"right": "0"
	},
	z20: {
		"zIndex": "20"
	},
	minW208px: {
		"minWidth": "208px"
	},
	bgPopupGlass: {
		"backgroundColor": "var(--popup-glass)"
	},
	BackdropFilterVarPopupBlur: {
		"WebkitBackdropFilter": "var(--popup-blur)",
		"backdropFilter": "var(--popup-blur)"
	},
	SmoothRingColorVarPopupRing: {
		"--smooth-ring-color": "var(--popup-ring)"
	},
	p5px: {
		"padding": "5px"
	},
	gap9px: {
		"gap": "9px"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	px9px: {
		"paddingInline": "9px"
	},
	textLeft: {
		"textAlign": "left"
	},
	isolate: {
		"isolation": "isolate"
	},
	beforePointerEventsNone: {
		"::before": {
			"content": "var(--tw-content)",
			"pointerEvents": "none"
		}
	},
	beforeAbsolute: {
		"::before": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	beforeInset0: {
		"::before": {
			"content": "var(--tw-content)",
			"inset": "0"
		}
	},
	beforeZ0: {
		"::before": {
			"content": "var(--tw-content)",
			"zIndex": "0"
		}
	},
	beforeRoundedInherit: {
		"::before": {
			"content": "var(--tw-content)",
			"borderRadius": "inherit"
		}
	},
	beforeCornerShapeInherit: {
		"::before": {
			"content": "var(--tw-content)",
			"cornerShape": "inherit"
		}
	},
	beforeBgVarPaletteAskBg: {
		"::before": {
			"content": "var(--tw-content)",
			"backgroundColor": "var(--palette-ask-bg)"
		}
	},
	beforeOpacity0: {
		"::before": {
			"content": "var(--tw-content)",
			"opacity": "0"
		}
	},
	beforeTransitionOpacity: {
		"::before": {
			"content": "var(--tw-content)",
			"transitionProperty": "opacity",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
	beforeDuration150: {
		"::before": {
			"content": "var(--tw-content)",
			"--tw-duration": ".15s",
			"transitionDuration": ".15s"
		}
	},
	beforeEaseCubicBezier03207201: {
		"::before": {
			"content": "var(--tw-content)",
			"--tw-ease": "cubic-bezier(.32,.72,0,1)",
			"transitionTimingFunction": "cubic-bezier(.32,.72,0,1)"
		}
	},
});

interface Props {
  /** Close the palette (Esc, backdrop click, or after a create without "Create more"). */
  onBack: () => void;
  /**
   * Render the same card on the page instead of over a backdrop: the empty
   * state's session input. There is no view behind it to dismiss back to, so
   * the create options collapse to the one that means anything (open what you
   * just made) and `onBack` is only the reset after a create.
   */
  inline?: boolean;
  /** Inline only: bumping this puts the caret back in the prompt. The sidebar's
      draft row points at this field. */
  focusSeq?: number;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
  /** Prefill the prompt (e.g. from the Home "New session" box). */
  prefillPrompt?: string;
  /** Services selected before the palette opens, such as from a command-menu
   *  shortcut. They use the same chips and create payload as manual picks. */
  initialMcpServers?: string[];
  forceMode?: "ask" | "code" | "scratch";
  /** When starting a session inside a workspace, the session joins that workspace… */
  workspaceId?: string;
  /** Workspace whose model combinations this new, independent session can use. */
  modelWorkspaceId?: string;
  /** …and defaults to the workspace's shared repo + worktree (a sibling's branch). */
  forceRepo?: string;
  forceBranch?: string;
  /** Lets App render the pending session shell before the created session appears
      in the polled session list. */
  onCreateStarted?: (draft: NewSessionCreateDraft) => void;
}

export interface NewSessionCreateDraft {
  /** The client-minted id the server persists for this session. */
  id: string;
  prompt: string;
  mode: "ask" | "code" | "scratch";
  repo: string;
  branch: string | null;
  workspaceId?: string;
  model?: string;
  images?: string[];
  files?: FileAttachment[];
  /** Open the optimistic session as soon as the create message is sent. */
  openImmediately?: boolean;
  /** Start the session without following it. */
  background?: boolean;
}

interface Worktree {
  branch: string;
  path: string;
}

interface RepoOption {
  id: string;
  label: string;
  default?: boolean;
  /** A repo whose sessions share one live checkout can be the session's own
   *  repo, but never a second one: there is no isolated worktree to attach. */
  sharedCheckout?: boolean;
}

const LAST_REPO_KEY = "opensession-new-session-repo";

/* ── Palette chrome ───────────────────────────────────────────────────────
   Every class is written out in full: Tailwind scans source TEXT, so a name
   assembled from a variable compiles to nothing. Variants that differ in
   colour or corner carry a COMPLETE string rather than stacking a second
   colour utility onto a shared base — two competing colour utilities on one
   element don't compose, the compiled sheet's order picks the winner.

   The icon button and the model pill are shared with the composer toolbar, so
   they live in lib/palette-classes.ts rather than being restated here. */

/** The hairline is a cutoff for content passing under the header, so it stays
 *  transparent until the prompt has actually scrolled beneath it. The border
 *  itself is always present: switching the colour keeps the height steady,
 *  where toggling `border-b` would jog the layout by a pixel.
 *
 *  Padding is asymmetric for the same reason the footer's is: the top is the
 *  card's own edge, the bottom only a hairline. The picker is a 32px box that
 *  fills on hover, so 16px above it matches the 16px beside it.
 *
 *  One control wide on a desktop, since the branch moved into the footer's
 *  overflow menu. On a phone this row IS the sheet's title bar: dismiss on the
 *  left, the project in the middle, commit on the right. It used to be a
 *  second row under that bar, and the two rows together pushed the sheet taller
 *  than the strip a keyboard leaves visible, which cut the bar off the top of
 *  the screen as soon as an attachment took its own space. */
const HEADER =
	mergeStylexClassName("", sx.flex, sx.itemsCenter, sx.gap2, sx.borderB, sx.borderTransparent, sx.px4, sx.pt4, sx.pb11px, sx.phoneHAuto, sx.phonePx18px, sx.phonePb3, sx.phonePt18px);
/** Merged onto HEADER/FOOTER by `cn()`, which drops the transparent colour. */
const EDGE_DIVIDER = mergeStylexClassName("", sx.borderLine);
/** The header's picker, which doubles as the palette's title: bigger, solid,
 *  heavier than a footer control.
 *
 *  `relative` is load-bearing — PaletteSelect's phone branch stacks an
 *  invisible native <select> over the trigger. So is `min-w-0`: the label
 *  already truncates, but a flex item whose own overflow is visible cannot be
 *  sized below its content, so a long repo name would push the row wider than
 *  the card instead of ellipsizing. */
const TRIGGER_STRONG =
	mergeStylexClassName("", sx.relative, sx.inlineFlex, sx.minW0, sx.maxWFull, sx.cursorPointer, sx.itemsCenter, sx.gap15, sx.roundedControl, sx.px2, sx.py5px, typography.itemTitle, sx.fontSemibold, sx.textFg, sx.transitionColors, sx.hoverBgHover, sx.disabledCursorDefault, sx.disabledOpacity55);
const CHEVRON = mergeStylexClassName("", sx.Ml05, sx.shrink0, sx.textFaint, sx.phoneSize4);
/** A pass-through on a desktop, where the picker is the header's one control.
 *  On a phone it is the middle slot of the title bar: it takes the space the
 *  two discs leave and centres the title inside it, so the row reads as one
 *  balanced bar rather than a label pushed against the close button. */
const MOBILE_PICKER =
	mergeStylexClassName("", sx.desktopContents, sx.phoneFlex, sx.phoneMinW0, sx.phoneFlex1, sx.phoneJustifyCenter);
/** On a phone the trigger is the sheet's title: the row's name, centred
 *  between the two discs that dismiss and commit. It carries no fill and no
 *  edge of its own. Those discs are the bar's only surfaces, and a third one
 *  between them read as an empty field rather than as the heading it is. The
 *  label and its chevron are the whole control; pressing it still paints the
 *  shared hover wash from `TRIGGER_STRONG`.
 *
 *  Smaller than the header's desktop title: between two 44px discs it is the
 *  quiet one of the three, so it drops to the label size and medium weight the
 *  rest of the chrome's chips wear. It keeps the full 44px height as a touch
 *  target, and it has to fit the row it shares, which is what `max-w-full`
 *  plus the label's own truncation buy. */
const MOBILE_TRIGGER =
	mergeStylexClassName("phone:[&_svg:first-child]:size-4", sx.phoneMinH11, sx.phoneGap1, sx.phoneRounded999px, sx.phonePx25, sx.phonePy15, sx.phoneTextLabel, sx.phoneFontMedium);
/** The composer's own send disc, so the gesture that commits a prompt looks the
 *  same in the palette as it does in a session. Sized up to the 44px target the
 *  rest of this bar keeps. */
const PHONE_SEND = cn(composerSend, composerSendDefault, mergeStylexClassName("", sx.phoneSize11));

/* (The prompt's own surface — the scroller and the field — moved to
   NewSessionPrompt, with the draft state it belongs to.) */
const ERROR = mergeStylexClassName("", sx.mx4, sx.mb2, sx.roundedMd, sx.bgRedSoft, sx.px25, sx.py7px, typography.supporting, sx.textRed);

/* Single-line footer: the model pill is the only flexible item — it gives way
   (its label ellipsizes) while the icon buttons and Create keep their size.
   Phones let the row wrap instead of crushing every pill to one letter.

   The bottom pad is deeper than the top one because it is measured against a
   different thing: the top is a hairline, the bottom is the card's own edge,
   rounded at ~30px. Create is a 36px plate inside a 40px row, so 14px here
   leaves it the same 16px clearance the side padding gives it. The safe-area
   inset clears the home indicator at rest, but the keyboard covers that edge
   while a field is focused, so the ordinary 12px pad takes over then. */
const FOOTER =
	mergeStylexClassName("phone:[body.kb-open_&]:pb-3", sx.flex, sx.itemsCenter, sx.justifyBetween, sx.gapX2, sx.gapY2, sx.borderT, sx.borderTransparent, sx.px4, sx.pt9px, sx.pb35, sx.phoneFlexWrap, sx.phonePx3, sx.phonePbCalc075remEnvSafeAreaInsetBottom, sx.max560pxGapX15);
const FOOTER_LEFT = mergeStylexClassName("", sx.flex, sx.minW0, sx.itemsCenter, sx.gap15, sx.phoneFlex1, sx.max560pxGap1);
const FOOTER_RIGHT = mergeStylexClassName("", sx.flex, sx.minW0, sx.itemsCenter, sx.gap15, sx.phoneContents, sx.max560pxGap1);
/** Round on a phone, where the bar's two controls are discs and the repo is a
 *  pill: a 12px corner among them is the one square thing on the card. The
 *  hover wash rides a pseudo-element, so it has to be rounded with them. */
const FOOTER_ICON_BTN = cn(
	paletteIconBtn,
	mergeStylexClassName("", sx.shrink0, sx.phoneSize11, sx.phoneRounded999px, sx.phoneBeforeRounded999px),
);
/** Ask mode's toggle. Off, it is one of the footer's quiet icon tools. On, it
 *  wears the same green marker the session composer's toolbar shows for the
 *  same mode, so one mode reads identically in both places — and it names
 *  itself, because the mode governs the whole session and an unlabelled glyph
 *  would leave read-only running silently.
 *
 *  A complete string rather than a variant stacked on FOOTER_ICON_BTN: the two
 *  states differ in width, height and colour, and the icon button's square
 *  `size-11` would crush the labelled chip on phones. 32px tall on a desktop,
 *  the size the icon buttons' hover wash paints, so the row keeps one rhythm;
 *  44px on a phone, where the whole row is thumb-sized. */
const ASK_BTN_ON =
	mergeStylexClassName("", sx.inlineFlex, sx.minH8, sx.shrink0, sx.itemsCenter, sx.gap15, sx.roundedControl, sx.px25, typography.label, sx.fontMedium, sx.transitionColors, sx.phoneMinH11, sx.phoneRounded999px, sx.phonePx35, sx.bgColorMixInSrgbVarGreen18Transparent, sx.textGreen, sx.hoverBgColorMixInSrgbVarGreen26Transparent, sx.disabledCursorDefault, sx.disabledOpacity50);
/** Ask mode paints the whole card, not just its toggle — the same thing the
 *  session composer does for ask and for note mode, because the mode governs
 *  everything you are about to type rather than one control in the corner.
 *
 *  A pseudo-element rather than a background on the card, because the palette
 *  is glass over a dimmed page: the tint has to sit ON the blur and fade in and
 *  out with it intact. Children are lifted above it, and the shell's own
 *  `overflow-hidden` clips it to the rounded corner. */
const ASK_SURFACE =
	mergeStylexClassName("", sx.isolate) +
	" " + mergeStylexClassName("", sx.beforePointerEventsNone, sx.beforeAbsolute, sx.beforeInset0, sx.beforeZ0, sx.beforeRoundedInherit, sx.beforeCornerShapeInherit, sx.beforeBgVarPaletteAskBg, sx.beforeOpacity0, sx.beforeTransitionOpacity, sx.beforeDuration150, sx.beforeEaseCubicBezier03207201) +
	" " + "[&>*]:relative [&>*]:z-[1]";
/** The one flexible footer item. The palette has room for the model's full
 *  name, so it opts out of palettePill's generic 180px cap. On phones the
 *  effort suffix steps aside first and leaves that room to the model. */
const MODEL_PILL = cn(
	palettePill,
	mergeStylexClassName("phone:[&_[data-effort]]:hidden", sx.shrink, sx.minW0, sx.maxWNone, sx.phoneMlAuto, sx.phoneMinH11, sx.max560pxPx9px),
);

/* What a create does with the view behind the palette: "open" follows the new
   session, "background" leaves you where you were, and "more" keeps the palette
   up for the next task. The order is the dropdown's, so the cycle shortcut and
   the menu step the same way. */
const CREATE_ACTIONS = ["open", "background", "more"] as const;
type CreateAction = (typeof CREATE_ACTIONS)[number];

// A dropped socket is recoverable: the same idempotent create is replayed as
// soon as the connection returns. "failed" is reserved for a server response.
type CreateStatus =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "reconnecting" }
  | { kind: "failed"; message: string };
/** ⌘⌥↓ / ⌘⌥↑ (Ctrl+Alt elsewhere). Vertical rather than horizontal because
 *  Chrome and Safari own ⌘⌥← / ⌘⌥→ for tab switching. */
const CYCLE_SHORTCUT = isApple ? ["⌘", "⌥", "↓"] : ["Ctrl", "Alt", "↓"];
/** Held while picking a repo, it adds one instead of replacing the choice. */
const MULTI_MODIFIER = isApple ? "⌘" : "Ctrl";

const CREATE_LABELS: Record<CreateAction, string> = {
	open: "Create",
	background: "Create in background",
	more: "Create more",
};

/* Split button: primary Create action + a caret that opens a mode dropdown.
   The two halves' corners are scoped to mutually exclusive media queries, so
   no two radius utilities ever race: phones drop the caret and round the main
   button out to a full pill.

   Desktop rounds on `rounded-control`, the corner every other button in the
   chrome shares (the Button primitive, the header CTAs). It used to be
   `rounded-md` — one step down, 9.45px against 13.5px — which on a 36px-tall
   plate read visibly square next to its neighbours. */
const CREATE_SPLIT =
	mergeStylexClassName("", sx.relative, sx.inlineFlex, sx.shrink0, sx.itemsStretch, sx.phoneOrder2, sx.phoneMt05, sx.phoneWFull);
const CREATE_MAIN =
	mergeStylexClassName("", sx.inlineFlex, sx.cursorPointer, sx.itemsCenter, sx.gap7px, sx.borderNone, sx.bgAccent, sx.px35, sx.py7px, typography.label, sx.fontSemibold, sx.textOnAccent, sx.transitionBackgroundColorOpacity, sx.enabledHoverBgAccentHover, sx.disabledCursorDefault, sx.disabledOpacity40, sx.phoneMinH11, sx.phoneFlex1, sx.phoneJustifyCenter, sx.max560pxPx3);
/** The desktop corner, split between the two shapes the button takes: half of
 *  a split button beside its caret, or the whole button when there is no caret
 *  (inline). Written as two whole classes rather than one plus an override,
 *  because both set `border-top-left-radius`, and which one wins is decided by
 *  the compiled sheet's order rather than the order they are listed here.
 *
 *  The phone overlay moves Create into its title bar and does not render this
 *  pair. Only the inline card reaches these phone classes, where it has no
 *  caret and rounds the whole button. */
const CREATE_MAIN_SPLIT = mergeStylexClassName("", sx.desktopRoundedLControl, sx.phoneRoundedL999px, sx.phoneRoundedRNone);
const CREATE_MAIN_WHOLE = mergeStylexClassName("", sx.desktopRoundedControl, sx.phoneRounded999px);
const CREATE_CARET =
	mergeStylexClassName("", sx.inlineFlex, sx.cursorPointer, sx.itemsCenter, sx.gap7px, sx.roundedRControl, sx.phoneMinW11, sx.phoneJustifyCenter, sx.phoneRoundedR999px, sx.borderNone, sx.bgAccent, sx.p7px, typography.label, sx.fontSemibold, sx.textOnAccent, sx.shadowInset1px00Rgba000014, sx.transitionBackgroundColorOpacity, sx.enabledHoverBgAccentHover, sx.disabledCursorDefault, sx.disabledOpacity40);
const CREATE_KBD = mergeStylexClassName("", sx.opacity70);
const CREATE_MENU =
	mergeStylexClassName("smooth-shadow-ring-md", sx.absolute, sx.bottomCalc1006px, sx.right0, sx.z20, sx.minW208px, sx.roundedControl, sx.bgPopupGlass, sx.BackdropFilterVarPopupBlur, sx.SmoothRingColorVarPopupRing, sx.p5px);
const CREATE_MENU_ITEM =
	mergeStylexClassName("", sx.flex, sx.wFull, sx.cursorPointer, sx.itemsStart, sx.gap9px, sx.roundedMd, sx.borderNone, sx.bgTransparent, sx.px9px, sx.py7px, sx.textLeft, sx.textFg, sx.transitionColors, sx.hoverBgHover);

/**
 * The same card rendered on the page rather than over a dimmed one: what the
 * empty state shows when there is no session to open yet.
 *
 * Not the palette's glass: `--palette-glass` is mixed to composite over a
 * backdrop, and on the pane's own surface there is little behind it to blur
 * (nothing at all under the mac shell's vibrancy, where the app's layers go
 * transparent). So it takes the composer's lift instead, the tokens for the
 * surface you type into, which is also what the workspace home's first-session
 * composer already wears.
 *
 * The layout half is the palette's and is load-bearing, not decoration: BODY is
 * `min-h-0 flex-1` and only scrolls inside a bounded column, and the header and
 * footer hairlines are keyed off that scroll. `relative` anchors the dictation
 * HUD; `overflow-hidden` keeps the rows' dividers inside the rounded shell.
 */
const INLINE_CARD = cn(
	mergeStylexClassName("", sx.relative, sx.flex, sx.wFull, sx.flexCol, sx.overflowHidden, sx.rounded2xl),
	mergeStylexClassName("", sx.maxHMin560px68dvh),
	composerBox,
);

/**
 * The repo a fresh palette starts on, for someone who hasn't set a preference.
 *
 * This used to be stickiness: whatever you picked last was silently pinned as
 * your default. Carry that value into the real preference once, then retire the
 * old key.
 */
function migratedRepoPref(): string {
  const preferred = getDefaultRepoPref();
  if (preferred) return preferred;
  try {
    const sticky = localStorage.getItem(LAST_REPO_KEY);
    if (!sticky) return "";
    localStorage.removeItem(LAST_REPO_KEY);
    if (sticky === "auto") return "";
    setDefaultRepoPref(sticky);
    return sticky;
  } catch {
    return "";
  }
}

// The repo the sidebar is currently filtered to (persisted by Sidebar.tsx under
// this key). When set to a real repo, a new session should default to it so
// creating from a repo-filtered view lands on that repo.
function filteredRepo(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem("opensession-sidebar-filter") || "{}");
    return typeof v.repo === "string" ? v.repo : null;
  } catch {
    return null;
  }
}

/** Deep-link prefill: <base>/new?mode=ask|code&prompt=…&branch=…&repo= */
function readPrefill() {
  const params = new URLSearchParams(location.search);
  // An explicit ?repo= wins (legacy ?project= still honored); otherwise keep
  // the user's last picker choice across closes/reloads, then use the sidebar
  // filter. The configured default is applied once `/repos` resolves.
  const rawRepoParam = params.get("repo") ?? params.get("project");
  // "auto" was a short-lived picker sentinel, never a repository id.
  const repoParam = rawRepoParam === "auto" ? "" : rawRepoParam;
  const mode = params.get("mode") === "ask" ? ("ask" as const) : ("code" as const);
  // `?repo=none` is honored in either mode: Ask with no repo reads nothing,
  // Code with no repo is a scratch session. Ask defaults to no repo, matching
  // the toggle — otherwise an Ask deep link would silently inherit whichever
  // repo the last code session used.
  const repo =
    repoParam ||
    (mode === "ask" ? NO_REPO : migratedRepoPref() || filteredRepo() || "");
  return {
    mode,
    prompt: params.get("prompt") || "",
    branch: params.get("branch") || "",
    repo,
  };
}

/** The workspace name a draft auto-follows: the prompt's first non-empty
 *  line, trimmed and capped. Mirrors the server's own follow in
 *  updateWorkspace (workspaces.ts). */
function firstNonEmptyLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

type PendingDraftPark = {
  text: string;
  workspaceId?: string;
  consumed: boolean;
  /** The existing workspace the create adopted. When absent, the create made
   *  another workspace and a late unscoped park can be deleted outright. */
  consumedIntoWorkspaceId?: string;
};

// A dismissed palette can be reopened while its workspace request is still in
// flight. If that prompt starts a session first, the late response must not
// leave a second, stale draft workspace behind.
const pendingDraftParks = new Set<PendingDraftPark>();

function consumePendingDraftParks(
  text: string,
  workspaceId: string | undefined,
  consumedIntoWorkspaceId?: string,
) {
  for (const operation of pendingDraftParks) {
    if (operation.text === text && operation.workspaceId === workspaceId) {
      operation.consumed = true;
      operation.consumedIntoWorkspaceId = consumedIntoWorkspaceId;
    }
  }
}

function draftParkInFlight(text: string, workspaceId?: string): boolean {
  return [...pendingDraftParks].some(
    (operation) =>
      !operation.consumed &&
      operation.text === text &&
      operation.workspaceId === workspaceId,
  );
}

export function NewSession({ onBack, inline, focusSeq, send, addHandler, connected, prefillPrompt, initialMcpServers, forceMode, workspaceId, modelWorkspaceId, forceRepo, forceBranch, onCreateStarted }: Props) {
  const [prefill] = useState(readPrefill);
  // What the session may do, and nothing else — the footer's Ask toggle. The
  // repo is a separate axis, so Scratch is not a third value here: it is what
  // Code with no repo already is (same write access, same repo-less scratch
  // dir), and `mode` below derives it rather than asking anyone to pick it.
  const [permissionState, setPermissionState] = useState<"ask" | "code">(
    (forceMode || prefill.mode) === "ask" ? "ask" : "code",
  );
  const permission = forceMode === "ask" ? "ask" : permissionState;
  // In a workspace, default to its shared repo; else the prefill/filter repo.
  // `forceMode: "scratch"` (a feed workspace) is a repo-less create, so it
  // arrives here as the repo rather than as a mode.
  const [repo, setRepo] = useState(
    forceMode === "scratch" ? NO_REPO : forceRepo || prefill.repo,
  );
  /**
   * Repos the session works in BESIDES `repo`, in the order they were added
   * (the picker's ⌘-click). Each becomes an attached worktree on the session's
   * branch, so the agent can read and edit across them from its first turn.
   * Only a Code session with a repo can carry them — see `canAddRepos`.
   */
  const [extraRepos, setExtraRepos] = useState<string[]>([]);
  /**
   * Flipping Ask moves the repo with it: Ask means "no repo" unless you go and
   * pick one, and Code goes back to the repo you were last working in. Most
   * asking is not about a checkout, and the pair that stayed pointed at a repo
   * you had chosen for a code session read as Ask silently inheriting it.
   *
   * A palette scoped to a workspace (`forceRepo`) is exempt: there the repo is
   * the whole point of the create, so Ask stays on it.
   */
  function togglePermission() {
    const next = permission === "ask" ? "code" : "ask";
    setPermissionState(next);
    // An Ask session reads one pinned checkout and cuts no worktree, so it has
    // nowhere to put a second repo. Drop them on the way in rather than
    // carrying a selection the create would have to refuse.
    if (next === "ask") setExtraRepos([]);
    if (forceRepo) return;
    if (next === "ask") setRepo(NO_REPO);
    else if (repo === NO_REPO)
      setRepo(migratedRepoPref() || configuredDefaultRepo || NO_REPO);
  }

  // The three modes the server stores, from the two axes above. Ask reads (a
  // repo, or nothing); Code writes, on a branch when it has a repo and in a
  // plain scratch dir when it doesn't.
  const mode: "ask" | "code" | "scratch" =
    permission === "ask" ? "ask" : repo === NO_REPO ? "scratch" : "code";
  // A second repo is an isolated worktree on this session's branch, which only
  // a Code session with a repo has. Ask reads one pinned checkout and Scratch
  // has no checkout at all, so neither can carry one.
  const canAddRepos = mode === "code";
  const repoOptions = (items: RepoInfo[]): RepoOption[] =>
    items.map((item) => ({
      id: item.id,
      label: item.label || item.id,
      default: item.default,
      sharedCheckout: item.sharedCheckout,
    }));
  // The workspace's configured choice is what a user with no preference of
  // their own starts on; the repo flagged `default` is the fallback behind it.
  // With no registered repos, start in Scratch instead.
  const resolveDefaultRepo = (options: RepoOption[]): string =>
    newSessionDefaultRepo(options, configuredNewSessionRepo());
  // Seeded from the repos this browser saw last (lib/repo-cache) so the picker
  // opens on the real list, and the palette settles on the right default,
  // without waiting for /repos. The fetch below still runs and corrects both.
  const [repos, setRepos] = useState<RepoOption[]>(() =>
    repoOptions(cachedRepos()),
  );
  const [configuredDefaultRepo, setConfiguredDefaultRepo] = useState(() => {
    const seeded = repoOptions(cachedRepos());
    return seeded.length ? resolveDefaultRepo(seeded) : "";
  });
  useEffect(() => {
    let live = true;
    fetchRepos().then((items) => {
      if (!live) return;
      const options = repoOptions(items);
      setRepos(options);
      setConfiguredDefaultRepo(resolveDefaultRepo(options));
    }).catch(() => {
      // A failed refresh keeps the cached rows rather than emptying the picker.
      if (!live) return;
      setRepos((current) => current);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
	setRepo((current) => {
      // "No repo" is a real choice, not an unresolved id — without this it
      // fails the `repos.some(...)` membership test below and gets replaced by
      // the configured default the moment /repos lands.
      if (forceRepo === NO_REPO || current === NO_REPO) return current;
      if (forceRepo && repos.some((item) => item.id === forceRepo)) return forceRepo;
      if (repos.some((item) => item.id === current)) return current;
      return configuredDefaultRepo;
    });
  }, [configuredDefaultRepo, forceRepo, repos]);

  /** A repo's picker label, falling back to its id before `/repos` lands. */
  const repoOptionLabel = (id: string) =>
    repos.find((item) => item.id === id)?.label || id;
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // In a workspace, default to a sibling's branch so the new session reuses its
  // worktree; the user can still switch to "New branch" to fork a fresh one.
  const [selectedWorktree, setSelectedWorktree] = useState(forceBranch || "__new__");
  const [newBranch, setNewBranch] = useState(prefill.branch);
  // An explicit prefill (Home hand-off, deep link) wins; otherwise restore the
  // stored draft so closing the palette / navigating away doesn't lose a
  // half-written task. A default create clears it as soon as the send is
  // accepted; App restores the submitted copy if creation fails.
  //
  // The draft itself belongs to NewSessionPrompt rather than to this component,
  // because typing must not re-render the palette around it. What stays here is
  // only what the palette reads: the current text in a ref, for the moment a
  // create is submitted; whether there is any text, which is the Create
  // button's gate; and the text once typing stops, which is what the branch
  // name is suggested from.
  const [initialPrompt] = useState(
    () => prefillPrompt || prefill.prompt || loadDraft(DRAFT_KEY).text,
  );
  const promptText = useRef(initialPrompt);
  const promptHandle = useRef<NewSessionPromptHandle | null>(null);
  const [hasPromptText, setHasPromptText] = useState(() =>
    /\S/.test(initialPrompt),
  );
  const [settledPrompt, setSettledPrompt] = useState(initialPrompt);
  const [mentionOpen, setMentionOpen] = useState(false);
  // Whether the user has hand-edited the branch field. Once true we stop
  // auto-suggesting so we never clobber what they typed. A prefilled branch
  // (deep link) counts as already-owned.
  const [branchEdited, setBranchEdited] = useState(!!prefill.branch);
  // Attachments live in the draft store, and this is its mirror. Staging a
  // file outlives the palette (lib/attachments.ts), so the store is what an
  // upload writes to and what a reopened palette reads back; keeping a second
  // copy authoritative here is what used to lose a screenshot pasted just
  // before the card closed.
  const [images, setImages] = useState<string[]>(() => loadDraft(DRAFT_KEY).images);
  const [files, setFiles] = useState<FileAttachment[]>(() => loadDraft(DRAFT_KEY).files);
  const uploads = useAttachmentUploads();
  const staging = uploads.staging;
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileDragWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable identity: module loader + setters only.
  const adoptDraftAttachments = useCallback(() => {
    const stored = loadDraft(DRAFT_KEY);
    setImages((prev) => (sameImages(prev, stored.images) ? prev : stored.images));
    setFiles((prev) => (sameFiles(prev, stored.files) ? prev : stored.files));
  }, []);
  // An upload that lands while this palette is open belongs on screen even
  // though it was staged by the instance that closed: the store fires on an
  // attachment change for exactly this.
  useEffect(() => onDraftsChanged(adoptDraftAttachments), [adoptDraftAttachments]);
  const [status, setStatus] = useState<CreateStatus>({ kind: "idle" });
  const busy = status.kind === "creating" || status.kind === "reconnecting";
  // Which edges of the prompt have content beyond them, and so earn a hairline.
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default
  // The shared model settings menu carries the same choices as an existing
  // session's composer. Both values persist on the new session and apply to
  // its opening turn.
  const [effort, setEffort] = useState("high");
  const [fastMode, setFastMode] = useState(false);
  // Pinned provider account for the new session ("" = auto pool pick).
  // Soft pin: the runner prefers it and falls back on exhaustion. Only
  // meaningful for Anthropic/OpenAI subscription-backed models.
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  useEffect(() => {
    fetchProviderAccounts().then(setAccounts).catch(() => {});
  }, []);
  const effectiveNewModel = model || defaultModel;
  const accountProvider = models.find(
    (item) => item.id === baseModelId(effectiveNewModel),
  )?.accountProvider;
  // A pin belongs to one provider pool. Drop it when the selected model moves
  // to another family so an opaque id is never reinterpreted.
  useEffect(() => {
    const account = accounts.find((item) => item.id === accountId);
    if (accountId && account?.provider !== accountProvider) setAccountId("");
  }, [accountProvider, accountId, accounts]);
  // What a create does with the view behind the palette. Chosen from the
  // Create split-button's dropdown; the primary button reflects the choice.
  const [chosenCreateAction, setCreateAction] = useState<CreateAction>("open");
  // Inline there is no view behind the card: "background" would leave you on an
  // empty page and "more" is what the card already does, so a create opens the
  // session it just made. The caret that picks between them is hidden too.
  const createAction: CreateAction = inline ? "open" : chosenCreateAction;
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createSplitRef = useRef<HTMLDivElement>(null);
  const isPhone = useIsPhone();
  /** The palette as a phone sheet: close and send ride in the top bar, and the
   *  footer keeps only the tools. The inline card has no bar of its own to put
   *  them in, so it keeps the footer's Create at every width. */
  const phoneBar = isPhone && !inline;
  // "Send messages with" (Settings → Preferences). The session composer honors it,
  // so this field has to as well — otherwise Enter silently does nothing here
  // while the Create button advertises ↩.
  // Resolved per client: a soft keyboard keeps ↩ for newlines (effectiveSendKey).
  const [storedSendKey, setStoredSendKey] = useState(getSendKeyPref);
  useEffect(
    () => onSendKeyChanged(() => setStoredSendKey(getSendKeyPref())),
    [],
  );
  const sendKey = effectiveSendKey(storedSendKey);
  const attachKeys = useShortcutKeys("composer-attach");

  // Sandbox provider picker: the complete model engine + workspace run in the
  // selected environment; native Codex is the sole host-only family.
  // "" = This machine (host, no sandbox); otherwise an explicit provider id
  // sent as the create's `sandbox` string. Options come from
  // /api/sandbox/status (fetched once when the palette opens) — only
  // configured providers are offered, and the whole control hides when the
  // server has no sandbox config or the kill switch is on.
  const [sandboxProvider, setSandboxProvider] = useState("");
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusInfo | null>(null);
  const sandboxSelectionTouched = useRef(false);
  useEffect(() => {
    fetchSandboxStatus(getCurrentUser())
      .then((status) => {
        setSandboxStatus(status);
		// This machine remains the clear default. Sandbox configuration belongs
		// behind the explicit Sandbox choice, never in an invisible default.
		if (!sandboxSelectionTouched.current) setSandboxProvider("");
      })
      .catch(() => {});
  }, []);
  const sandboxChoices = sandboxStatus?.connections?.length
    ? sandboxStatus.connections
        .filter((connection) => connection.state === "ready")
        .map((connection) => ({ id: connection.provider, note: undefined as string | undefined }))
    : (sandboxStatus?.providers || []).filter((p) => p.configured && p.certified);
  const selectedSandboxAvailable =
    !sandboxProvider || sandboxChoices.some((choice) => choice.id === sandboxProvider);
  const visibleSandboxChoices =
    sandboxProvider && !selectedSandboxAvailable
      ? [
          {
            id: sandboxProvider,
					note: "Unavailable. Choose This machine or a ready Sandbox before creating.",
          },
          ...sandboxChoices,
        ]
      : sandboxChoices;
  const showSandboxPicker = !!sandboxStatus;
  const sandboxLabel = (id: string) =>
		id === "" ? "This machine" : id === "docker" ? "Docker" : id === "daytona" ? "Daytona" : id === "e2b" ? "E2B" : id === "box" ? "Box" : id === "modal" ? "Modal" : id === "microvm" ? "Local MicroVM" : id === "lambda-microvm" ? "AWS Lambda MicroVM" : id;

  // Provider-independent family check, driven by the same server list the
  // create path enforces.
  const effectiveModelId = model || defaultModel;
  const effectiveModelProvider = effectiveModelId.startsWith("pi/")
    ? "pi"
    : models.find((m) => m.id === effectiveModelId)?.provider ?? "claude";
  const modelFamily = (sandboxStatus?.modelFamilies || []).find(
    (f) => f.match.provider === effectiveModelProvider,
  );
  const sandboxModelWarning = (() => {
    if (sandboxProvider && !selectedSandboxAvailable) {
		return `${sandboxLabel(sandboxProvider)} is unavailable. Choose This machine or a ready Sandbox.`;
    }
	    if (!sandboxProvider || !modelFamily) return null;
    if (modelFamily.sandboxable) return null;
    return (
		`${modelFamily.label} models can't run in a Sandbox` +
      (modelFamily.hint ? ` · ${modelFamily.hint}` : "") +
      "."
    );
  })();

  // Brain-inside remote/MicroVM sessions all adopt a full-runner prewarm.
  // Strictly fire-and-forget: failure must never surface or block typing.
  const isRemoteSandbox = sandboxProvider === "daytona" || sandboxProvider === "e2b" || sandboxProvider === "box" || sandboxProvider === "modal" || sandboxProvider === "lambda-microvm";
  const shouldPrewarm = isRemoteSandbox || sandboxProvider === "microvm";
  const [sandboxWarmed, setSandboxWarmed] = useState(false);
  const lastPrewarmAtRef = useRef(0);
  useEffect(() => {
    // Provider/repo switch: allow an immediate re-fire for the new key.
    lastPrewarmAtRef.current = 0;
    setSandboxWarmed(false);
  }, [sandboxProvider, repo]);
  useEffect(() => {
    // Whether the prompt has anything in it, not what it says: the throttle
    // below means only the first character of a draft ever fires this.
    if (!shouldPrewarm || !hasPromptText || busy) return;
    if (Date.now() - lastPrewarmAtRef.current < 60_000) return;
    lastPrewarmAtRef.current = Date.now();
    requestSandboxPrewarm(sandboxProvider, repo, getCurrentUser())
      .then((r) => setSandboxWarmed(r.state === "ready"))
      .catch(() => {});
  }, [hasPromptText, shouldPrewarm, sandboxProvider, repo, busy]);

  // An empty selection means every available service; one or more picks narrow
  // the session to those services. Command-menu shortcuts seed this same state
  // so their selection stays visible and removable before Create.
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>(
    () => initialMcpServers || [],
  );
  const [availableMcpServers, setAvailableMcpServers] = useState<string[]>([]);
  useEffect(() => {
    fetchToolAccounts()
      .then((c) => {
        setAvailableMcpServers(c.servers.map((s) => s.name));
      })
      .catch(() => {});
  }, []);
  function toggleMcpServer(name: string, on: boolean) {
    setSelectedMcpServers((prev) =>
      on ? [...prev, name] : prev.filter((m) => m !== name),
    );
  }

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const voiceOverlayRef = useRef<HTMLDivElement>(null);
  const [dictating, setDictating] = useState(false);
  const [dictationClipping, setDictationClipping] = useState(false);
  function handleDictationActive(active: boolean) {
    setDictating(active);
    if (active) setDictationClipping(true);
  }
  // Hidden <input type="file"> driven by the "Add file" button — the mobile
  // path, since there's no clipboard paste there.
  const fileInputRef = useRef<HTMLInputElement>(null);

  // (The prompt is focused on open by Modal.Content's initialFocus — a mount
  // effect here would run a frame before the dialog's popup exists.)
  //
  // Inline there is no dialog to do it, and the children mount in the same
  // commit, so an ordinary effect is enough. On a phone this raises the
  // keyboard right away, so starting a session is one tap and then typing.
  useEffect(() => {
    if (!inline) return;
    promptRef.current?.focus();
  }, [inline, focusSeq]);

  // On a phone the dialog's own initialFocus lands a frame after the tap that
  // opened it, which is too late for iOS to raise the keyboard. The tap parked
  // the keyboard on a stand-in field (lib/soft-keyboard); take it over here,
  // as soon as the real prompt exists.
  useEffect(() => {
    if (inline) return;
    handOffSoftKeyboard(() => promptRef.current);
  }, [inline]);

  // (The prompt's auto-grow, its scroll-fade and the draft store it writes
  // through all live in NewSessionPrompt now, beside the text they read.)

  // Close the Create dropdown on an outside click.
  useEffect(() => {
    if (!createMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (createSplitRef.current && !createSplitRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [createMenuOpen]);

  // Step through the Create options without leaving the prompt: the primary
  // button's label is the feedback, and an open dropdown moves its check. This
  // rides on the dialog rather than on window because Base UI's
  // popup stops keydown propagation before it leaves the card, which is also
  // why it can use a chord the rest of the app is free to bind elsewhere.
  function cycleCreateAction(e: React.KeyboardEvent) {
    if (busy) return;
    if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
    const step = e.code === "ArrowDown" ? 1 : e.code === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = CREATE_ACTIONS.indexOf(createAction);
    setCreateAction(
      CREATE_ACTIONS[(at + step + CREATE_ACTIONS.length) % CREATE_ACTIONS.length],
    );
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (!busy && matchesShortcut(e, "composer-attach")) {
      e.preventDefault();
      fileInputRef.current?.click();
      return;
    }
    cycleCreateAction(e);
  }

  useEffect(() => {
		fetchModels(modelWorkspaceId || workspaceId)
      .then(async (m) => {
        setModels(m.models);
        setDefaultModel(m.default);
        // Untouched picker: start on this person's own default model and
        // engine (Settings → Preferences); "" is no preference, which keeps
        // the workspace default.
        const preselect = await resolveNewSessionModel(m);
        setModel((current) => {
          if (current) {
            // Pi-routed ids validate against their base entry (the pi/ prefix
            // is routing, not a listed model).
            return m.models.some((item) => item.id === baseModelId(current))
              ? current
              : "";
          }
          return preselect;
        });
      })
      .catch(() => {});
	}, [modelWorkspaceId, workspaceId]);

  // Worktrees are per-repo; refetch and reset the selection when it changes.
  // Inside a workspace, snap back to the shared sibling branch, not "New branch".
  //
  // The `live` guard is what keeps a fetch from outliving the repo it was for:
  // switching to Auto before it lands used to clear the list and then have the
  // old repo's branches arrive on top of the empty one, which now decides
  // whether the branch row exists at all — the menu offered branches from a
  // repo the session was no longer pointed at.
  useEffect(() => {
    let live = true;
    setSelectedWorktree(forceBranch || "__new__");
    if (!repo || repo === NO_REPO) {
      setWorktrees([]);
      return;
    }
    fetchWorktrees(repo)
      .then((items) => {
        if (live) setWorktrees(items);
      })
      .catch(() => {
        if (live) setWorktrees([]);
      });
    return () => {
      live = false;
    };
  }, [repo, forceBranch]);

  // Auto-suggest a branch name from the prompt (a Haiku call, once typing has
  // stopped), but only while the field is "ours" — once the user types in it
  // (branchEdited) we back off. The latest-request guard drops a stale response
  // if the user starts editing the branch while a suggestion is in flight.
  //
  // The wait for typing to stop is the prompt field's, not this component's:
  // this is the one thing here that reads what the draft SAYS, so it is handed
  // the text once it has held still rather than on every character.
  const branchEditedRef = useRef(branchEdited);
  useLayoutEffect(() => {
    branchEditedRef.current = branchEdited;
  }, [branchEdited]);
  const suggestSeqRef = useRef(0);
  useEffect(() => {
    if (mode !== "code" || selectedWorktree !== "__new__" || branchEdited) return;
    if (settledPrompt.trim().length < 10) return;
    suggestSeqRef.current += 1;
    const seq = suggestSeqRef.current;
    void (async () => {
      const branch = await suggestBranch(settledPrompt.trim());
      // Drop if superseded by a newer prompt or the user grabbed the field.
      if (seq !== suggestSeqRef.current || branchEditedRef.current) return;
      if (branch) setNewBranch(branch);
    })();
  }, [settledPrompt, mode, selectedWorktree, branchEdited]);

  // Registered from mount and gated on a ref set synchronously in handleCreate:
  // session_created is announced before the worktree even boots, so it can
  // arrive before a creating-gated effect would have registered this handler.
  const creatingRef = useRef(false);
  const createSessionIdRef = useRef<string | null>(null);
  const createMessageRef = useRef<WSClientMessage | null>(null);
  const createWorkspaceIdRef = useRef<string | null>(null);
  const replayCreateRef = useRef(false);
  // A successful create replaces the surface behind this dialog. Returning
  // focus to the now-removed opener makes Base UI advance to the new session's
  // "+" button, so Enter immediately creates another session. Cancelling still
  // restores focus normally.
  const createdRef = useRef(false);
  const handleCreationMessage = useEffectEvent((msg: WSServerMessage) => {
    if (!creatingRef.current) return;
    if (
      msg.type === "error" &&
      errorMatchesPendingCreate(msg.sessionId, createSessionIdRef.current)
    ) {
      creatingRef.current = false;
      createSessionIdRef.current = null;
      createMessageRef.current = null;
      createWorkspaceIdRef.current = null;
      replayCreateRef.current = false;
      setStatus({ kind: "failed", message: msg.message });
    } else if (
      msg.type === "session_created" &&
      msg.id === createSessionIdRef.current
    ) {
      creatingRef.current = false;
      createSessionIdRef.current = null;
      createMessageRef.current = null;
      const consumedWorkspaceId = createWorkspaceIdRef.current;
      createWorkspaceIdRef.current = null;
      replayCreateRef.current = false;
      // The prompt was consumed. Drop both copies and their pending writes: the
      // global composer copy, plus the workspace copy made when it was closed.
      promptHandle.current?.dropPendingDraftWrite();
      dropStagingAttachments(DRAFT_KEY);
      clearDraft(DRAFT_KEY);
      if (consumedWorkspaceId)
        consumeNewSessionWorkspaceDraft(consumedWorkspaceId);
      // "Create more" stays in the palette and resets for the next task. The
      // other actions close it after App handles the same announcement.
      if (createAction === "more" || inline) {
        setStatus({ kind: "idle" });
        promptHandle.current?.setText("");
        setImages([]);
        setFiles([]);
        setNewBranch("");
        setBranchEdited(false);
        promptRef.current?.focus();
      } else {
        createdRef.current = createAction === "open";
        onBack();
      }
    }
  });
  useEffect(() => {
    return addHandler((msg) => handleCreationMessage(msg));
  }, [addHandler]);

  // Re-send the same client-minted id after a drop. The server deduplicates an
  // in-flight request and returns the existing session if it already persisted.
  useEffect(() => {
    if (!creatingRef.current) return;
    if (!connected) {
      replayCreateRef.current = true;
      setStatus({ kind: "reconnecting" });
      return;
    }
    if (!replayCreateRef.current || !createMessageRef.current) return;
    replayCreateRef.current = false;
    setStatus({ kind: "creating" });
    send(createMessageRef.current);
  }, [connected, send]);

  async function addAttachments(picked: FileList | File[]) {
    // The staging commits to the draft store itself, so a screenshot pasted
    // while the app is still loading survives this palette closing before
    // its upload lands. Adopt the store rather than the result: it is the
    // one place that has both these files and anything else that arrived.
    const results = await uploads.upload(picked, (file, signal) =>
      attachToDraft(DRAFT_KEY, [file], signal),
    );
    adoptDraftAttachments();
    const rejected = results.flatMap((result) => result.rejected);
    if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
  }

  const addDroppedAttachments = useEffectEvent((picked: FileList | File[]) => {
    void addAttachments(picked);
  });

  // Leaving the palette with an unsent prompt saves it, rather than asking you
  // to say so in advance. The text is parked on a workspace (a fresh one, or
  // the one this palette is scoped to) and shows up in the sidebar as a draft.
  // Nothing runs. This never sends create_session, so it is separate from
  // handleCreate's session_created wait below.
  //
  // The local composer draft is never cleared by leaving: reopening the
  // palette shows exactly what you typed, and the parked workspace draft is a
  // copy, not a move. Staged attachments are copied onto the workspace's own
  // composer, so the draft you find in the sidebar has its files too.
  const parkingDraftRef = useRef(false);
  async function parkDraftOnExit() {
    const text = promptText.current.trim();
    if (
      !text ||
      busy ||
      parkingDraftRef.current ||
      draftParkInFlight(text, workspaceId)
    ) return;
    parkingDraftRef.current = true;
    const operation: PendingDraftPark = { text, workspaceId, consumed: false };
    pendingDraftParks.add(operation);
    const draft = { text, updatedAt: new Date().toISOString(), by: getCurrentUser() };
    await (async () => {
const createWorkspace = () =>
        createWorkspaceApi({
          name: firstNonEmptyLine(text).slice(0, 80) || "Draft",
          ...(repo && repo !== NO_REPO ? { repo } : {}),
          draft: { ...draft, autoName: true },
        });
      const parkedId = getParkedNewSessionWorkspaceId();
      const workspace = workspaceId
        ? // Scoped to an existing workspace: update its draft, never rename it.
          await updateWorkspaceApi(workspaceId, { draft })
        : parkedId
          ? // Re-parking the draft this palette already saved. The name still
            // follows the text server-side while autoName holds. Only a
            // workspace that is gone earns a fresh one; any other failure is
            // reported rather than answered with a duplicate.
            await updateWorkspaceApi(parkedId, {
              draft: { ...draft, autoName: true },
            }).catch((e) => {
              if (e instanceof ApiError && e.status === 404) {
                forgetParkedNewSessionWorkspace(parkedId);
                return createWorkspace();
              }
              throw e;
            })
          : await createWorkspace();
      if (operation.consumed) {
        // The same prompt started while this request was in flight. A create
        // that adopted this workspace only needs its late draft cleared. When
        // it created elsewhere, remove the now-empty duplicate workspace.
        if (workspaceId || operation.consumedIntoWorkspaceId === workspace.id) {
          await updateWorkspaceApi(workspace.id, { draft: null });
        } else {
          forgetParkedNewSessionWorkspace(workspace.id);
          await deleteWorkspaceApi(workspace.id);
        }
      } else {
        if (!workspaceId) rememberParkedNewSessionWorkspace(workspace.id);
        // Attachments live in this browser's draft store, not on the server
        // record, so hand them to the workspace composer directly.
        const staged = loadDraft(DRAFT_KEY);
        saveDraft(workspaceDraftKey(workspace.id), {
          text,
          images: staged.images,
          files: staged.files,
        });
      }
      window.dispatchEvent(new Event("opensession:workspaces-changed"));
})().catch(async (e) => {
if (!operation.consumed) {
        toast(
          e instanceof ApiError
            ? `Couldn't save the draft: ${e.message}`
            : "Couldn't save the draft. It is still in the composer.",
        );
      }
}).finally(async () => {
pendingDraftParks.delete(operation);
      parkingDraftRef.current = false;
});
  }

  function handleCreate() {
    if (!canCreate) return;
    const prompt = promptText.current.trim();
    const createRepo = repo;
    const branch =
      selectedWorktree === "__new__"
        ? newBranch.trim() || fallbackBranchName(prompt)
        : selectedWorktree;
    const attachRepos = extraRepos.filter((id) => id !== createRepo);
    const createMode = mode;

    // With "Create more" off, App tears down the palette when the
    // session_created event arrives (and drops us into the new session).
    setStatus({ kind: "creating" });
    creatingRef.current = true;
    // Workspace linkage: scoped to an existing workspace (the tab/sidebar +),
    // the session joins it. An unscoped composer that was closed already made
    // a draft workspace, so reopening and creating adopts that same workspace
    // instead of leaving the draft beside a second, live workspace.
    const createWorkspaceId =
      workspaceId || getParkedNewSessionWorkspaceId() || undefined;
    const worktreeMode =
      createMode === "ask"
        ? "ask"
        : createMode === "code" && selectedWorktree === "__new__"
          ? "stack"
          : "share";
    const clientSessionId = newClientSessionId();
    // The server applies `defaultModel` when no personal override is sent. Carry
    // that known choice into the optimistic shell so the phone title bar does
    // not wait for its own catalog fetch before naming the model.
    const optimisticModel = model || defaultModel;
    const optimisticCreate: NewSessionCreateDraft = {
      id: clientSessionId,
      prompt,
      mode: createMode,
      // The optimistic shell is replaced once the persisted record lands.
      repo: createRepo,
      branch: createMode === "code" ? branch : null,
      ...(createWorkspaceId ? { workspaceId: createWorkspaceId } : {}),
      ...(optimisticModel ? { model: optimisticModel } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
      // The default action opens against this deterministic id without waiting
      // for workspace or model setup. The other actions keep their own surface.
      ...(createAction === "open" ? { openImmediately: true } : {}),
      ...(createAction === "background" ? { background: true } : {}),
    };
    const createMessage = {
      type: "create_session",
      clientSessionId,
      mode: createMode,
      repo: createRepo,
      // Repos to work in beside `repo`. The server cuts each an isolated
      // worktree on this session's branch before the first turn runs, so the
      // agent is told about them in the same breath as its own checkout.
      ...(attachRepos.length && canAddRepos ? { attachRepos } : {}),
      ...(createWorkspaceId
        ? { workspaceId: createWorkspaceId, worktreeMode }
        : { createWorkspace: {} }),
      ...(modelWorkspaceId ? { modelWorkspaceId } : {}),
      branch: createMode === "code" ? branch : "",
      prompt,
      titlePrompt: projectComposerSessions(prompt).displayText,
      user: getCurrentUser(),
      ...(model ? { model } : {}),
      effort,
      ...(fastMode ? { fastMode: true } : {}),
      ...(accountProvider && accountId ? { accountId } : {}),
      // Once defaults have loaded, Host is an explicit override ("local").
      // Omitting the field would make the server re-apply the user's default.
      ...(sandboxStatus ? { sandbox: sandboxProvider || "local" } : {}),
      ...(selectedMcpServers.length ? { mcpServers: selectedMcpServers } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length
        ? {
            files: files.map((f) =>
              f.path ? { name: f.name, path: f.path } : { name: f.name, dataUrl: f.dataUrl },
            ),
          }
        : {}),
    } as WSClientMessage;
    createSessionIdRef.current = clientSessionId;
    createMessageRef.current = createMessage;
    createWorkspaceIdRef.current = createWorkspaceId ?? null;
    try {
      send(createMessage);
      consumePendingDraftParks(prompt, workspaceId, createWorkspaceId);
      if (createAction === "open") {
        // The send was accepted. Consume the global composer now, before App
        // opens the optimistic session, so reopening it during workspace setup
        // starts on the next message rather than the one already queued.
        // App owns the submitted copy and restores it if creation fails.
        promptHandle.current?.dropPendingDraftWrite();
        dropStagingAttachments(DRAFT_KEY);
        clearDraft(DRAFT_KEY);
        promptHandle.current?.setText("");
      }
      onCreateStarted?.(optimisticCreate);
    } catch (error) {
      creatingRef.current = false;
      createSessionIdRef.current = null;
      createMessageRef.current = null;
      createWorkspaceIdRef.current = null;
      setStatus({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const canCreate =
    !busy &&
    // An attachment is not attached until its upload lands, and the create
    // reads the list as it stands. Creating a second earlier would send the
    // prompt without the screenshot it is about, silently.
    !isStaging(staging) &&
    connected &&
    // "No repo" is a choice, so it passes; only an unresolved picker (an
    // instance with no repositories registered yet) blocks.
    !!repo &&
    // Unsupported model × environment combo: the server would reject the
    // create with the same message (resolveRequestedSandbox). Block here
    // so the wall is discovered before submit, not after.
    !sandboxModelWarning &&
    (hasPromptText || images.length > 0 || files.length > 0) &&
    (mode === "ask" || mode === "scratch" || selectedWorktree !== "");

  /** The latest `handleCreate`, for a caller that has to wait a render before
   *  it can create. The dictation bar's ↑ is the one: it writes the transcript
   *  through the prompt's own state, so a closure captured at the moment of
   *  the press would still be looking at the draft as it was. */
  const createRef = useRef<() => void>(() => {});
  // Deliberate latest-value mirror: runs after every commit by design.
  useLayoutEffect(() => {
    createRef.current = handleCreate;
  });

  // The base a code session branches off. It sits in the footer's overflow
  // menu rather than the header: a fresh branch is what almost every session
  // gets, so the row it used to occupy was a picker nobody moved, beside the
  // one thing you do choose. Only a Code session with a repo has a branch at
  // all — Ask cuts no worktree, and Code with no repo has nothing to cut one
  // from.
  const createFromLabel = selectedWorktree === "__new__" ? "New branch" : selectedWorktree;
  const createFromOptions = [
    {
      value: "__new__",
      label: workspaceId && forceBranch
        ? `New stacked branch (off ${forceBranch})`
        : "New branch",
    },
    ...worktrees.map((wt) => ({ value: wt.branch, label: wt.branch })),
  ];
  // The branch this palette starts on: a sibling's inside a workspace, a fresh
  // one everywhere else. Anything else is a deliberate pick, and one level
  // behind a button it has to light that button up to be visible at all.
  const defaultWorktree = forceBranch || "__new__";
  const branchPicked = mode === "code" && selectedWorktree !== defaultWorktree;
  // A row worth opening needs a second thing to pick. With no sibling
  // worktrees there is only "New branch", which is what a create does anyway.
  const showBranchPicker =
    mode === "code" && (worktrees.length > 0 || selectedWorktree !== "__new__");

  // Which edges of the prompt earn a hairline. The field measures its own
  // scroller and reports; holding the previous object when nothing moved is
  // what keeps a scroll (or a keystroke) from re-rendering the card.
  function handlePromptEdges(next: { top: boolean; bottom: boolean }) {
    setEdges((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
  }

  // One frame closed so the palette animates in; App mounts us already-open.
  const open = useEnterOnMount();

  function resetFileDrag() {
    if (fileDragWatchdogRef.current) clearTimeout(fileDragWatchdogRef.current);
    fileDragWatchdogRef.current = null;
    setFileDragActive(false);
  }

  function armFileDragWatchdog() {
    if (fileDragWatchdogRef.current) clearTimeout(fileDragWatchdogRef.current);
    fileDragWatchdogRef.current = setTimeout(resetFileDrag, 500);
  }

  useEffect(() => {
    if (inline || !open) return;
    function ownsFileDrag() {
      const composer = document.querySelector<HTMLElement>(
        '[data-global-file-composer="new-session"]',
      );
      return foregroundFileComposerOwns(composer);
    }
    function handleDragEnter(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      armFileDragWatchdog();
      setFileDragActive(true);
    }
    function handleDragLeave(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      const next = event.relatedTarget;
      if (next instanceof Node && document.documentElement.contains(next)) return;
      resetFileDrag();
    }
    function handleDragOver(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      armFileDragWatchdog();
      setFileDragActive(true);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function handleDrop(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const dropped = event.dataTransfer?.files;
      resetFileDrag();
      if (dropped?.length) addDroppedAttachments(dropped);
    }
    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("drop", handleDrop, true);
    window.addEventListener("dragend", resetFileDrag, true);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("drop", handleDrop, true);
      window.removeEventListener("dragend", resetFileDrag, true);
      resetFileDrag();
    };
  }, [inline, open]);

  // Ask mode's surface, shared with the session composer so one mode is one
  // strength wherever you meet it. Only the base differs: mixed into
  // `transparent` rather than an opaque colour, because the palette is glass
  // and an opaque tint would paint the blur out.
  const askSurfaceStyle = {
    "--palette-ask-bg": askSurface("transparent"),
  } as React.CSSProperties;

  // The card itself: the same rows whether it floats over the page as a
  // palette or sits on it as the empty state's session input.
  const card = (
    <>
      {/* Header: what the session is pointed at, and nothing else. The mode
          switch sits with the tools in the footer, and the branch one level
          behind them, because a fresh branch is what almost every code
          session wants. Either mode can be pointed at nothing: Ask with no
          repo is a conversation with your tools, Code with no repo is a
          scratch dir.

          On a phone this row is also the sheet's title bar: dismiss, the
          project, commit. One row rather than two, because a sheet over an
          open keyboard has about half a screen to spend and an attachment
          takes its share of it. */}
      <PhoneTopBar className={cn(HEADER, !dictating && edges.top && EDGE_DIVIDER)}>
        {phoneBar && (
          <>
            <Modal.Close
              render={
                <PhoneTopBarAction
                  aria-label="Close"
                  icon={<IconX size={22} />}
                />
              }
            />
            {/* The sheet still has a name, it just isn't drawn: the dialog
                needs one, and a screen reader has no card to look at. */}
            <Modal.Title className={mergeStylexOverrideClassName("", sx.srOnly)}>New session</Modal.Title>
          </>
        )}
        <div className={MOBILE_PICKER}>
          <PaletteSelect
            className={cn(TRIGGER_STRONG, MOBILE_TRIGGER)}
            title="Project"
            value={repo}
            options={[
              ...repos.map((p) => ({
                value: p.id,
                label: p.label,
                icon: <RepoTile name={p.id} />,
                // A shared-checkout repo has no isolated worktree to attach,
                // so it can be the session's repo but never a second one.
                singleOnly: p.sharedCheckout,
              })),
              // Either mode can run without a repo, and the Ask toggle in the
              // footer says which one you get: Ask reads nothing, Code writes
              // in a plain scratch dir with no branch or PR flow.
              {
                value: NO_REPO,
                label: "No repo",
                icon: <IconMessage size={20} />,
                singleOnly: true,
              },
            ]}
            onChange={(nextRepo) => {
              setRepo(nextRepo);
              // A plain pick is "work here", not "and here too": it replaces
              // the whole selection, which is what it did before any of this.
              // It does NOT become your default either — that is a setting
              // now (Settings → Preferences), not a thing the picker infers.
              setExtraRepos([]);
            }}
            extraValues={extraRepos}
            onToggleExtra={
              canAddRepos
                ? (id) => {
                    const next = toggleRepoSelection(
                      { repo, extras: extraRepos },
                      id,
                    );
                    setRepo(next.repo);
                    setExtraRepos(next.extras);
                  }
                : undefined
            }
            multiHint={repoSelectionHint(extraRepos, repoOptionLabel, MULTI_MODIFIER)}
            // A feed workspace is repo-less by construction (its subject is a
            // a feed item, not a checkout), so its create doesn't offer one.
            disabled={busy || forceMode === "scratch"}
            ariaLabel="Project"
            isPhone={isPhone}
          >
            {repo === NO_REPO ? (
              <IconMessage className={mergeStylexOverrideClassName("", sx.shrink0)} size={18} />
            ) : (
              <RepoTile name={repo} />
            )}
            <span {...stylex.props(sx.truncate)}>
              {repo === NO_REPO
                ? "No repo"
                : repoOptionLabel(repo) || repo || "No repositories"}
            </span>
            {/* The trigger has room for one repo, so the rest ride as a count —
                the same shorthand the session header's repo pill uses. */}
            {extraRepos.length > 0 && (
              <span
                {...stylex.props(sx.shrink0, sx.fontMedium, sx.textDim, typography.label)}
                title={extraRepos.map(repoOptionLabel).join(", ")}
              >
                +{extraRepos.length}
              </span>
            )}
            {forceMode !== "scratch" && (
              <IconChevronDown className={CHEVRON} size={22} />
            )}
          </PaletteSelect>
        </div>
        {phoneBar && (
          <button
            type="button"
            className={cn(PHONE_SEND, dictating && mergeStylexClassName("", sx.invisible))}
            onClick={handleCreate}
            disabled={!canCreate}
            aria-label={CREATE_LABELS[createAction]}
          >
            <IconArrowUp size={22} />
          </button>
        )}
      </PhoneTopBar>

      <motion.div
        initial={false}
        animate={{ height: dictating ? (isPhone ? 64 : 62) : "auto" }}
        transition={composerMorph}
        onAnimationComplete={() => {
          if (!dictating) setDictationClipping(false);
        }}
        className={cn(
          mergeStylexClassName("", sx.relative, sx.flex, sx.minH0, sx.flexCol),
          dictationClipping && mergeStylexClassName("", sx.overflowHidden),
        )}
      >
        {/* Dictation replaces everything below Project while the card itself
            supplies the surface, border and shadow. Keeping this target inside
            the card avoids drawing a second rounded container over the first. */}
        <div
          ref={voiceOverlayRef}
          {...stylex.props(sx.pointerEventsNone, sx.Absolute, sx.inset0, sx.Z6)}
        />
        <div
          className={cn(
            mergeStylexClassName("", sx.flex, sx.minH0, sx.flex1, sx.flexCol),
            dictating && mergeStylexClassName("", sx.invisible),
          )}
        >

      {/* Picked services, above the field like every other thing attached to
          what you are about to send. The picker is two levels inside a menu,
          so without this the only trace of a pick is a count on the overflow
          button, and the pick governs the whole session rather than one
          prompt. The row stays mounted so the last chip can animate out. */}
      <div {...mergeStylexProps("", sx.phonePx3, sx.phonePt1, sx.flex, sx.flexWrap, sx.itemsStart, sx.gapX1, sx.px4)}>
        {selectedMcpServers.length > 0 && (
          <span {...mergeStylexProps("", sx.phoneBlock, sx.desktopHidden, sx.mr1, sx.selfCenter, sx.fontMedium, sx.textFaint, typography.meta)}>
            Using
          </span>
        )}
        <AnimatePresence initial={false}>
          {selectedMcpServers.map((mcp) => (
            <ComposerContextChip
              key={mcp}
              icon={<IconTile name={mcp} size={15} />}
              label={displayName(mcp)}
              title={`${displayName(mcp)} is on. A session gets only the services you pick here.`}
              onRemove={() => toggleMcpServer(mcp, false)}
              removeLabel={`Remove ${displayName(mcp)}`}
              disabled={busy}
            />
          ))}
        </AnimatePresence>
      </div>

        {/* Prompt. It owns the draft: see NewSessionPrompt for why the text
            does not live in this component. */}
        <NewSessionPrompt
          initialText={initialPrompt}
          textareaRef={promptRef}
          valueRef={promptText}
          handle={promptHandle}
          repo={repo}
          mcpServers={selectedMcpServers}
          // Ask sessions read and explain; they never touch the code. Asking
          // "what to work on" in that mode invites a prompt the session
          // cannot carry out.
          placeholder={
            mode === "ask" ? "What do you want to find out?" : "What do you want to work on?"
          }
          disabled={busy}
          images={images}
          files={files}
          staging={staging}
          onRemovePendingImage={uploads.cancelPendingImage}
          onRemovePendingFile={uploads.cancelPendingFile}
          onRemoveImage={(i) => {
            removeDraftImage(DRAFT_KEY, i);
            adoptDraftAttachments();
          }}
          onRemoveFile={(i) => {
            removeDraftFile(DRAFT_KEY, i);
            adoptDraftAttachments();
          }}
          onAddAttachments={(picked) => void addAttachments(picked)}
          sendKey={sendKey}
          canCreate={canCreate}
          onCreate={handleCreate}
          onHasTextChange={setHasPromptText}
          onDraftSettled={setSettledPrompt}
          onEdgesChange={handlePromptEdges}
          onMentionOpenChange={setMentionOpen}
        />

        {status.kind === "failed" && <div className={ERROR}>{status.message}</div>}
        {sandboxModelWarning && (
          <div className={ERROR} role="alert">
            {sandboxModelWarning}
          </div>
        )}

        {/* Footer toolbar */}
        <div className={cn(FOOTER, edges.bottom && EDGE_DIVIDER)}>
          <div className={FOOTER_LEFT}>
            <Tooltip label="Attach a file" shortcut={attachKeys ?? undefined}>
              <button
                type="button"
                className={FOOTER_ICON_BTN}
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                aria-label="Attach a file"
              >
                <IconPaperclip size={20} />
              </button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void addAttachments(e.target.files);
                e.target.value = "";
              }}
            />
            {/* Ask sits with the tools rather than in the header: Code is what
                you are almost always doing, so the header should show what you
                are working on (the repo, the branch) and this is the one
                switch that changes it. Off it is a quiet icon; on it names
                itself and wears the green the card and the composer's Ask pill
                also wear, because read-only running silently is the one state
                worth being loud about. */}
            {!forceMode && (
              <Tooltip
                label={
                  permission === "ask"
                    ? "Ask mode on · reads, changes nothing. Click to write code instead"
                    : "Ask mode · read-only, and no repo unless you pick one"
                }
              >
                <button
                  type="button"
                  className={permission === "ask" ? ASK_BTN_ON : FOOTER_ICON_BTN}
                  onClick={togglePermission}
                  disabled={busy}
                  aria-pressed={permission === "ask"}
                  aria-label="Ask mode"
                >
                  <IconEye size={permission === "ask" ? 14 : 20} />
                  {permission === "ask" && "Ask"}
                </button>
              </Tooltip>
            )}
            {/* Rarely changed execution settings stay one level behind a single
                overflow button. Their current values remain visible in the
                submenu rows, while attachment stays one tap away. */}
            <Menu.Root>
              <Tooltip label="More options">
                <Menu.Trigger
                  type="button"
                  className={cn(
                    FOOTER_ICON_BTN,
						(branchPicked || sandboxProvider || modelEngine(effectiveModelId) !== "pi" || selectedMcpServers.length > 0) &&
                      paletteIconBtnOn,
                  )}
                  disabled={busy}
                  aria-label="More options"
                >
                  <IconDotsHorizontal size={20} />
                </Menu.Trigger>
              </Tooltip>
              <Menu.Popup
                align="start"
                sideOffset={6} {...mergeStylexProps("", sx.maxWMin360pxCalc100vw1rem, sx.minW260px)}
              >
                {showBranchPicker && (
                  <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger className={mergeStylexOverrideClassName("", sx.justifyBetween, sx.gap3)}>
                      <span {...stylex.props(sx.flex, sx.flexNone, sx.itemsCenter, sx.gap2)}>
                        <IconNewBranch className={mergeStylexOverrideClassName("", sx.shrink0, sx.textDim)} size={20} />
                        <span>Branch</span>
                      </span>
                      <span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap1, sx.textDim)}>
                        <span {...stylex.props(sx.truncate)}>{createFromLabel}</span>
                        <IconChevronRight className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)} size={17} />
                      </span>
                    </Menu.SubmenuTrigger>
                    <Menu.Popup className={mergeStylexOverrideClassName("", sx.maxWMin340pxCalc100vw1rem)}>
                      {createFromOptions.map((opt) => (
                        <Menu.Item
                          key={opt.value}
                          onClick={() => setSelectedWorktree(opt.value)}
                        >
                          <Menu.Check
                            on={selectedWorktree === opt.value}
                            className={mergeStylexOverrideClassName("", sx.textDim)}
                          />
                          <span {...stylex.props(sx.minW0, sx.truncate)}>{opt.label}</span>
                        </Menu.Item>
                      ))}
                    </Menu.Popup>
                  </Menu.SubmenuRoot>
                )}
                {showSandboxPicker && (
                  <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger className={mergeStylexOverrideClassName("", sx.justifyBetween, sx.gap3)}>
                      <span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
                        <IconBox className={mergeStylexOverrideClassName("", sx.shrink0, sx.textDim)} size={20} />
                        <span {...stylex.props(sx.truncate)}>Sandbox</span>
                      </span>
                      <span {...stylex.props(sx.flex, sx.flexNone, sx.itemsCenter, sx.gap1, sx.textDim)}>
                        {sandboxLabel(sandboxProvider)}
                        {sandboxWarmed && shouldPrewarm && (
                          <span {...stylex.props(sx.textFaint)}>· ready</span>
                        )}
                        <IconChevronRight className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)} size={17} />
                      </span>
                    </Menu.SubmenuTrigger>
                    <Menu.Popup className={mergeStylexOverrideClassName("", sx.maxWMin340pxCalc100vw1rem)}>
                      {[{ id: "", note: undefined as string | undefined }, ...visibleSandboxChoices].map(
                        (opt) => {
                          const selected = sandboxProvider === opt.id;
                          return (
                            <Menu.Item
                              key={opt.id || "host"}
                              onClick={() => {
                                sandboxSelectionTouched.current = true;
                                setSandboxProvider(opt.id);
                              }}
                              className={mergeStylexOverrideClassName("", sx.itemsStart)}
                            >
                              <Menu.Check on={selected} className={mergeStylexOverrideClassName("", sx.mt05, sx.textDim)} />
                              <span {...stylex.props(sx.flex, sx.minW0, sx.flexCol, sx.gap05)}>
                                <span>
                                  {sandboxLabel(opt.id)}
                                </span>
                                {opt.note && (
                                  <span {...stylex.props(sx.whitespaceNormal, sx.leadingSnug, sx.textFaint, typography.supporting)}>
                                    {opt.note}
                                  </span>
                                )}
                              </span>
                            </Menu.Item>
                          );
                        },
                      )}
                    </Menu.Popup>
                  </Menu.SubmenuRoot>
                )}
                <Menu.SubmenuRoot>
                  <Menu.SubmenuTrigger className={mergeStylexOverrideClassName("", sx.justifyBetween, sx.gap3)}>
                    <span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
                      <IconConnections className={mergeStylexOverrideClassName("", sx.shrink0, sx.textDim)} size={20} />
                      <span {...stylex.props(sx.truncate)}>Connected services</span>
                    </span>
                    <span {...stylex.props(sx.flex, sx.flexNone, sx.itemsCenter, sx.gap1, sx.textDim)}>
                      {/* Nothing picked is not "none": an empty allowlist means
                          the run gets every service you can see
                          (filterMcpServers, scope "all"), so the readout says
                          so rather than promising a session with no tools. */}
                      {selectedMcpServers.length ? `${selectedMcpServers.length} on` : "All"}
                      <IconChevronRight className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)} size={17} />
                    </span>
                  </Menu.SubmenuTrigger>
                  <Menu.Popup className={mergeStylexOverrideClassName("", sx.maxWMin360pxCalc100vw1rem)}>
                    {availableMcpServers.length > 0 && (
                      <div {...stylex.props(sx.maxW300px, sx.px2, sx.pb1, sx.leadingSnug, sx.textFaint, typography.supporting)}>
                        Picked services are the only ones the session gets.
                      </div>
                    )}
                    {availableMcpServers.length === 0 && (
                      <Menu.Item disabled className={mergeStylexOverrideClassName("", sx.textFaint)}>
                        No services available
                      </Menu.Item>
                    )}
                    {availableMcpServers.map((mcp) => {
                      const checked = selectedMcpServers.includes(mcp);
                      return (
                        <Menu.CheckboxItem
                          key={mcp}
                          checked={checked}
                          closeOnClick={false}
                          onCheckedChange={(on) => toggleMcpServer(mcp, on)}
                          className={cn(mergeStylexClassName("", sx.justifyBetween, sx.gap3), checked && mergeStylexClassName("", sx.bgHover))}
                        >
                          <span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap25)}>
                            <IconTile name={mcp} size={20} />
                            <span {...stylex.props(sx.minW0, sx.truncate)}>{displayName(mcp)}</span>
                          </span>
                          <Menu.Check on={checked} className={mergeStylexOverrideClassName("", sx.textDim)} />
                        </Menu.CheckboxItem>
                      );
                    })}
                  </Menu.Popup>
                </Menu.SubmenuRoot>
                {/* The phone's send is one round button, so what the desktop
                    caret holds lives here instead. Flat rows rather than a
                    submenu: a submenu opens on hover, which a finger does not
                    have. A plain div rather than Menu.GroupLabel, which stops
                    the sibling submenus above from opening at all. */}
                {phoneBar && (
                  <>
                    <div {...stylex.props(sx.px2, sx.pb1, sx.pt15, sx.fontMedium, sx.textFaint, typography.meta)}>
                      On create
                    </div>
                    {CREATE_ACTIONS.map((action) => (
                      <Menu.Item
                        key={action}
                        onClick={() => setCreateAction(action)}
                      >
                        <Menu.Check
                          on={createAction === action}
                          className={mergeStylexOverrideClassName("", sx.textDim)}
                        />
                        <span {...stylex.props(sx.minW0, sx.truncate)}>
                          {CREATE_LABELS[action]}
                        </span>
                      </Menu.Item>
                    ))}
                  </>
                )}
              </Menu.Popup>
            </Menu.Root>
          </div>

          <div className={FOOTER_RIGHT}>
            {/* Always visible — on phones too, so a non-default (dumber) model
                is never silently in effect. */}
            <ModelEffortSelect
              className={MODEL_PILL}
              title="Model and reasoning effort"
              models={models}
              defaultModel={defaultModel}
              model={model}
              onModelChange={setModel}
              effort={effort}
              onEffortChange={setEffort}
              fastMode={fastMode}
              onFastModeChange={setFastMode}
              accounts={accounts}
              accountId={accountId}
              onAccountChange={setAccountId}
              disabled={busy}
            />
            <VoiceInput
              className={FOOTER_ICON_BTN}
              disabled={busy}
              editTargetRef={promptRef}
              overlayTargetRef={voiceOverlayRef}
              onActiveChange={handleDictationActive}
              onText={(t) => {
                promptHandle.current?.appendText(t);
                promptRef.current?.focus();
              }}
              onTextSend={(t) => {
                promptHandle.current?.appendText(t);
                // One turn of the loop before creating: the transcript reaches
                // the prompt through its own state, and `canCreate` only
                // catches up on the render after it. `createRef` is read then
                // rather than captured now for the same reason.
                setTimeout(() => createRef.current(), 0);
              }}
              // The parent card owns the only visible surface. This layer is
              // just controls and waveform clipped by that card's outer edge.
              overlayClassName={mergeStylexClassName("[backdrop-filter:none]", sharedClassStyles.roundedNone, sharedClassStyles.bgTransparent)}
            />

            {!phoneBar && (
            <div className={CREATE_SPLIT} ref={createSplitRef}>
              <button
                className={cn(
                  CREATE_MAIN,
                  inline ? CREATE_MAIN_WHOLE : CREATE_MAIN_SPLIT,
                )}
                onClick={handleCreate}
                disabled={!canCreate}
              >
                {status.kind === "reconnecting"
                  ? "Reconnecting…"
                  : status.kind === "creating"
                    ? "Creating…"
                    : isStaging(staging)
                      ? "Attaching…"
                      : CREATE_LABELS[createAction]}
                {/* The hint has to match the preference — a bare ↩ next to a
                    field that only creates on ⌘↩ is what made Enter look
                    broken in the first place. */}
                {sendKey === "mod-enter" ? (
                  <span className={[CREATE_KBD, mergeStylexClassName("", sx.mx0, sx.phoneHidden, sx.textXs)].filter(Boolean).join(" ")}>
                    {MOD_ENTER_GLYPH}
                  </span>
                ) : (
                  /* Snug the return glyph up to the label and nudge it off the
                     button edge. "Create more" is a desktop workflow, so the
                     hint goes away with the caret on phones. */
                  <IconReturn
                    className={[CREATE_KBD, mergeStylexClassName("", sx.Mx3px, sx.phoneHidden)].filter(Boolean).join(" ")}
                    size={20}
                  />
                )}
              </button>
              {/* The tooltip is where the cycle shortcut is taught: the caret
                  is the only thing on screen that says these options exist.
                  Inline there are no options to pick between, so the button is
                  whole and the caret is gone. */}
              {!inline && (
              <Tooltip label="Create options" shortcut={CYCLE_SHORTCUT}>
              <button
                type="button"
                className={CREATE_CARET}
                onClick={() => setCreateMenuOpen((v) => !v)}
                // Not having a prompt yet leaves the caret alone: the options
                // are still worth reading, and picking one is how you change
                // what Enter will do. A create in flight is the one thing that
                // closes it off, and then it greys out with the main button
                // beside it, so the pair still reads as one busy control. An
                // attachment on its way to disk holds the same pair the same
                // way, for the second or two it takes.
                disabled={busy || isStaging(staging)}
                aria-haspopup="menu"
                aria-expanded={createMenuOpen}
                aria-label="Create options"
              >
                <IconChevronDown
                  className={[mergeStylexClassName("", sx.transitionTransform), createMenuOpen ? mergeStylexClassName("", sx.rotate180) : ""].filter(Boolean).join(" ")}
                  size={22}
                />
              </button>
              </Tooltip>
              )}
              {!inline && createMenuOpen && (
                <div className={CREATE_MENU} role="menu">
                  {[
                    { action: "open" as const, title: "Create", desc: "Open the new session" },
                    {
                      action: "background" as const,
                      title: "Create in background",
                      desc: "Stay where you are",
                    },
                    { action: "more" as const, title: "Create more", desc: "Stay here to start another" },
                  ].map((opt) => (
                    <button
                      key={opt.action}
                      type="button"
                      role="menuitemradio"
                      aria-checked={createAction === opt.action}
                      className={CREATE_MENU_ITEM}
                      onClick={() => {
                        setCreateAction(opt.action);
                        setCreateMenuOpen(false);
                      }}
                    >
                      <Menu.Check
                        on={createAction === opt.action}
                        size={22}
                        className={mergeStylexOverrideClassName("", sx.mtPx, sx.textDim)}
                      />
                      <span {...stylex.props(sx.flex, sx.minW0, sx.flexCol, sx.gapPx)}>
                        <span {...stylex.props(sx.fontSemibold, typography.label)}>{opt.title}</span>
                        <span {...stylex.props(sx.textDim, typography.supporting)}>{opt.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            </div>
            )}
          </div>
        </div>
        </div>
      </motion.div>
    </>
  );

  if (inline) {
    return (
      <div
        className={cn(
          INLINE_CARD,
          ASK_SURFACE,
          mode === "ask" && mergeStylexClassName("", sx.beforeOpacity100, sx.afterOpacity100),
        )}
        style={askSurfaceStyle}
        role="group"
        aria-label="New session"
        onKeyDown={handleCardKeyDown}
      >
        {card}
      </div>
    );
  }

  return (
    <Modal.Root
      open={open}
      // Escape and outside presses both land here. App's global Esc-closes-a-
      // palette shortcut can't double-fire: Base UI stops the keydown before it
      // reaches window, so this is the only close (which matters, because
      // closePalette also pops a /new deep link off history).
      onOpenChange={(next) => {
        if (next || busy) return;
        // Whatever is still in the prompt was worth typing, so leaving parks it
        // as a draft instead of dropping it behind the palette.
        void parkDraftOnExit();
        onBack();
      }}
      // Focus is trapped, but the page is neither inerted nor scroll-locked: the
      // "@"-mention popup portals to <body>, and inerting would leave it dead.
      modal="trap-focus"
      // Mid-create the palette isn't dismissable. An open mention popup also
      // owns the next click: it lives outside the dialog, so pressing it would
      // otherwise read as an outside press and close the whole palette.
      disablePointerDismissal={busy || mentionOpen}
    >
      <Modal.Content
        data-global-file-composer="new-session"
        variant="palette"
        widthClassName={mergeStylexClassName("", sharedClassStyles.wMin820px100PhoneFull)}
        // The bottom pad is the keyboard's own height (lib/keyboard-inset).
        // The sheet is anchored to the bottom of the LAYOUT viewport, which iOS
        // does not shrink for the keyboard, so without it the composer sits
        // behind the keys and the page has to be panned to reach it. It is 0px
        // wherever nothing covers the window.
        viewportClassName={mergeStylexClassName("", sharedClassStyles.phoneItemsEnd, sharedClassStyles.phonePx0, sharedClassStyles.phonePbVarKbInset0px, sharedClassStyles.phonePt3)}
        className={cn(
          // A phone sheet carries a rounder top corner than the floating
          // palette does: it meets the screen's own edge on three sides, so the
          // two corners it keeps are the whole of its shape.
          //
          // The keyboard cap is what keeps the title bar on screen: a tall
          // enough sheet (a prompt carrying an image) ran off the top and took
          // dismiss and send with it. 43dvh fits the strip left above an iPhone
          // keyboard and its suggestion bar, and the 100% holds the sheet
          // inside that strip on a client whose keyboard is taller than the
          // one 43dvh was measured against. Past the cap the prompt scrolls,
          // which is what its scroller is for.
          mergeStylexClassName("phone:[body.kb-open_&]:max-h-[min(43dvh,100%)] phone:[&_textarea]:min-h-[160px] phone:[&_textarea]:text-input-phone", sx.maxHCalc89dvh1rem, sx.phoneMaxHCalc100dvh12px, sx.phoneRoundedTCalc40pxVarRf, sx.phoneRoundedBNone),
          ASK_SURFACE,
          mode === "ask" && mergeStylexClassName("", sx.beforeOpacity100, sx.afterOpacity100),
        )}
        style={askSurfaceStyle}
        aria-label="New session"
        onKeyDown={handleCardKeyDown}
        // The prompt, not the repo picker Base UI would otherwise land on as the
        // first tabbable.
        initialFocus={promptRef}
        finalFocus={() => !createdRef.current}
      >
        {card}
        <FullPageFileDropOverlay active={fileDragActive} />
      </Modal.Content>
    </Modal.Root>
  );
}
