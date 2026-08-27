import React, {
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { transcribeClip } from "../lib/api";
import { IconArrowUp, IconCheck, IconMic, IconPlus, IconX } from "./icons";
import { Tooltip } from "../ui/tooltip";
import { PRODUCT_NAME } from "../lib/brand";
import { cn, mergeStylexProps, mergeStylexClassName } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import { paletteIconBtn } from "../lib/palette-classes";
import { composerSend, composerSendDefault } from "../lib/composer-classes";
import { useIsPhone } from "../hooks/useIsPhone";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { matchesShortcut } from "../lib/shortcuts";
import {
  effectiveSendKey,
  isSendCombo,
  MOD_ENTER_GLYPH,
} from "../lib/send-key";
import { getSendKeyPref, onSendKeyChanged } from "../lib/send-key-pref";
import { isApple } from "../lib/platform";
import {
  startBrowserDictation,
  type BrowserDictation,
} from "../lib/browser-dictation";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	h10: {
			height: "40px"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
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
	inlineFlex: {
			display: "inline-flex"
	},
	relative: {
			position: "relative"
	},
	mx4: {
			marginInline: "16px"
	},
	hFull: {
			height: "100%"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	gap1: {
			gap: "4px"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	z1: {
			zIndex: "1"
	},
	block: {
			display: "block"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	textFg: {
			color: "var(--text)"
	},
	Absolute: {
			position: "absolute!important"
	},
	inset0: {
			inset: "0"
	},
	gap25: {
			gap: "10px"
	},
	px1: {
			paddingInline: "4px"
	},
	shrink0: {
			flexShrink: "0"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	absolute: {
			position: "absolute"
	},
	bottomCalc1008px: {
			bottom: "calc(100% + 8px)"
	},
	right0: {
			right: "0"
	},
	z7: {
			zIndex: "7"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	bgRedSoft: {
			backgroundColor: "var(--red-soft)"
	},
	px11px: {
			paddingInline: "11px"
	},
	py7px: {
			paddingBlock: "7px"
	},
	textRed: {
			color: "var(--red)"
	},

	transitionOpacity: {
		"transitionProperty": "opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	opacity15: {
		"opacity": ".15"
	},

	hoverTextAccent: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--accent-ink)"
			}
		}
	},

	pointerEventsAuto: {
		"pointerEvents": "auto"
	},
	z6: {
		"zIndex": "6"
	},
	itemsEnd: {
		"alignItems": "flex-end"
	},
	gap15: {
		"gap": "6px"
	},
	bgVarComposerSurface: {
		"backgroundColor": "var(--composer-surface)"
	},
	px35: {
		"paddingInline": "14px"
	},
	pb25: {
		"paddingBottom": "10px"
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phonePb9px: {
		"@media (max-width: 720px)": {
			"paddingBottom": "9px"
		}
	},
	roundedVarComposerRadius: {
		"borderRadius": "var(--composer-radius)"
	,
		cornerShape: "var(--cs)"},
	phoneGap15: {
		"@media (max-width: 720px)": {
			"gap": "6px"
		}
	},
	size10: {
		"width": "40px",
		"height": "40px"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	roundedMd: {
		"borderRadius": "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	borderNone: {
		"--tw-border-style": "none",
		"borderStyle": "none"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
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
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledOpacity35: {
		":disabled": {
			"opacity": ".35"
		}
	},
	phoneMx18px: {
		"@media (max-width: 720px)": {
			"marginInline": "18px"
		}
	},
	h05: {
		"height": "2px"
	},
	w3px: {
		"width": "3px"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	,
		cornerShape: "round"},
	bgDim: {
		"backgroundColor": "var(--text-dim)"
	},
	transitionHeight: {
		"transitionProperty": "height",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	duration90ms: {
		"--tw-duration": "90ms",
		"transitionDuration": "90ms"
	},
	easeLinear: {
		"--tw-ease": "linear",
		"transitionTimingFunction": "linear"
	},
	bgFaint: {
		"backgroundColor": "var(--text-faint)"
	},
	borderColorMixInSrgbVarRed40Transparent: {
		"borderColor": "var(--red)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--red) 40%,transparent)"
		}
	},
});

type Phase = "idle" | "requesting" | "recording" | "cancelling" | "transcribing";

/** Dictation is capped. This is a session input, not a memo recorder. */
const MAX_SECONDS = 120;
const INITIAL_BAR_COUNT = 72;
const INITIAL_PHONE_BAR_COUNT = 24;
const MAX_BAR_COUNT = 160;
const BAR_WIDTH = 3;
const BAR_GAP = 4;

/* The recording bar's chrome. Every variant is written out in full rather than
   composed from a fragment: Tailwind scans source text, so a class assembled
   from a variable is never generated.

   The bar covers the WHOLE input rather than parking on its bottom edge: while
   a clip is recording there is nothing to read and nothing to edit in the
   draft underneath, and a half-visible field invited a caret into text the
   dictation was about to append to. It carries the host surface's own fill so
   the waveform reads as drawn straight onto the container, not onto a second
   raised slab inside it. */
const OVERLAY =
	mergeStylexClassName("", sx.pointerEventsAuto, sx.absolute, sx.inset0, sx.z6, sx.flex, sx.itemsEnd, sx.gap15, sx.bgVarComposerSurface, sx.px35, sx.pb25, sx.phonePx3, sx.phonePb9px);
/** Default corner. A host whose container is rounded differently passes its
 *  own (the new-session card is `rounded-2xl`). */
const OVERLAY_RADIUS = mergeStylexClassName("", sx.roundedVarComposerRadius);

/* Waveform bars. Colour lives on the variant, never alongside a second colour
   utility on the same element. Two of those don't compose, the sheet's order
   decides the winner. Bars without a sample yet are a 2px baseline dot; live
   ones get their height inline from the level meter. */
const WAVE_BAR_IDLE = mergeStylexClassName("", sx.h05, sx.w3px, sx.shrink0, sx.roundedFull, sx.bgFaint);
const WAVE_BAR_LIVE =
	mergeStylexClassName("", sx.h05, sx.w3px, sx.shrink0, sx.roundedFull, sx.bgDim, sx.transitionHeight, sx.duration90ms, sx.easeLinear);

/* Hosts can match cancel to the control it replaces. This fallback keeps the
   standalone VoiceInput target at the same 40px size as its idle mic. */
const GLYPH_CANCEL =
	mergeStylexClassName("", sx.inlineFlex, sx.size10, sx.shrink0, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.borderNone, sx.bgTransparent, sx.textDim, sx.transitionColors, sx.hoverBgHover, sx.hoverTextFg, sx.disabledCursorDefault, sx.disabledOpacity35);

/** Each period fades in after the one before it, then all three clear together.
 *  Their spans stay in layout while transparent so the label never shifts. */
const TRANSCRIBING_DOT_STARTS = [0.06, 0.23, 0.4] as const;
const TRANSCRIBING_DOT_MOTION = {
  duration: 1.4,
  repeat: Infinity,
  ease: "linear",
} as const;

/** The recording row arrives through a short blur rather than sliding. The
 *  overlay's surface itself is not animated: it covers the field on the first
 *  frame, so text cannot remain visible while the controls settle in. */
const ROW_MOTION = {
	initial: { filter: "blur(4px)" },
	animate: { filter: "blur(0px)" },
	transition: { type: "tween", duration: duration.base, ease },
} as const;
const GLYPH_MORPH = {
	type: "spring",
	duration: duration.large,
	bounce: 0,
} as const;
const MIC_OUT = {
	initial: { opacity: 1, filter: "blur(0px)", scale: 1 },
	animate: { opacity: 0, filter: "blur(4px)", scale: 0.25 },
	transition: GLYPH_MORPH,
} as const;
const CHECK_IN = {
	initial: { opacity: 0, filter: "blur(4px)", scale: 0.25 },
	animate: { opacity: 1, filter: "blur(0px)", scale: 1 },
	transition: GLYPH_MORPH,
} as const;
const PLUS_TO_CANCEL = {
	initial: { rotate: 0 },
	animate: { rotate: 45 },
	transition: GLYPH_MORPH,
} as const;

/**
 * Wispr-Flow-style dictation control shared by the session Composer and the
 * New-session palette. Idle it's just a mic button; tapping it takes over the
 * whole input surface with a recording bar (cancel × · live transcript · save
 * ✓ · save and send ↑), then hands the browser's final text to `onText` or,
 * when the send button asked for it, to `onTextSend`. Browsers without live
 * speech recognition keep the prior /api/transcribe fallback.
 *
 * ✓ and ↑ differ only in what happens after the text lands: ✓ leaves it in the
 * draft to read and edit (and dictating again appends to it), ↑ sends the
 * message as it stands.
 *
 * The bar renders as an absolutely-positioned overlay filling the nearest
 * positioned ancestor, so the host container must be positioned: `.composer`
 * in the session view, and the palette's Modal.Content, whose `variant="palette"`
 * carries `relative` for exactly this.
 */
export function VoiceInput({
  onText,
  onTextSend,
  disabled,
  className = paletteIconBtn,
  overlayClassName,
  overlayStyle,
  overlayTargetRef,
  editTargetRef,
  onActiveChange,
  shortcutActive = false,
  cancelClassName,
  cancelFromPlus = false,
}: {
  onText: (text: string) => void;
  /** Take the text and send it straight away. Without one, the send button is
   *  not drawn. A host with nothing to send to only offers ✓. */
  onTextSend?: (text: string) => void;
  disabled?: boolean;
  /** Classes for the idle mic button. Both hosts pass their own: the
   *  new-session footer so the mic keeps the sizing its neighbours get there,
   *  the composer so it turns into a circle with the "+" in the resting
   *  pill. */
  className?: string;
  /** Corner (and any surface override) for the recording bar, to match the
   *  container it covers. */
  overlayClassName?: string;
  overlayStyle?: React.CSSProperties;
  /** Optional full-input layer. The session Composer's mic lives inside its
   *  toolbar, so its overlay is portaled to a box covering the Composer. */
  overlayTargetRef?: React.RefObject<HTMLElement | null>;
  /** The draft field to restore after keeping, cancelling, or an error. */
  editTargetRef?: React.RefObject<HTMLElement | null>;
  /** Lets a host collapse its container while dictation owns the input. */
  onActiveChange?: (active: boolean) => void;
  /** Lets this visible Composer claim the app-wide dictate shortcut. */
  shortcutActive?: boolean;
  /** Matches cancel to the add control it replaces in a full-surface host. */
  cancelClassName?: string;
  /** Rotate the host's add glyph into cancel instead of swapping to an X. */
  cancelFromPlus?: boolean;
}) {
  const isPhone = useIsPhone();
  const dictateKeys = useShortcutKeys("composer-dictate");
  const [storedSendKey, setStoredSendKey] = useState(getSendKeyPref);
  useEffect(
    () => onSendKeyChanged(() => setStoredSendKey(getSendKeyPref())),
    [],
  );
  const sendKey = effectiveSendKey(storedSendKey);
  const sendKeyCaps =
    sendKey === "mod-enter" ? [MOD_ENTER_GLYPH] : [isApple ? "↵" : "Enter"];
  const [barCount, setBarCount] = useState(
    isPhone ? INITIAL_PHONE_BAR_COUNT : INITIAL_BAR_COUNT,
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [overlayTarget, setOverlayTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setOverlayTarget(overlayTargetRef?.current ?? null);
  }, [overlayTargetRef]);
  const recRef = useRef<MediaRecorder | null>(null);
  const speechRef = useRef<BrowserDictation | null>(null);
  const speechResultRef = useRef<Promise<string> | null>(null);
  /** Invalidates an unresolved permission request when recording is cancelled
   *  or the control unmounts. A late stream is stopped instead of recording. */
  const requestRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const callbacksRef = useRef({ onText, onTextSend });
  const activeChangeRef = useRef(onActiveChange);
  useLayoutEffect(() => {
    callbacksRef.current = { onText, onTextSend };
    activeChangeRef.current = onActiveChange;
  }, [onText, onTextSend, onActiveChange]);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const acceptRef = useRef(false);
  /** Which button ended the clip: ↑ sends the result, ✓ just keeps it. */
  const sendRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const idleButtonRef = useRef<HTMLButtonElement | null>(null);

  function cleanup() {
    timersRef.current.forEach((t) => clearInterval(t));
    timersRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    recRef.current = null;
  }
  function restoreEditorFocus() {
    // The first frame lets React remove `inert`; the second restores the caret
    // after that commit instead of trying to focus an inert textarea.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        returnFocusRef.current?.focus({ preventScroll: true }),
      ),
    );
  }

  function finishCancellation() {
    setLiveTranscript("");
    setPhase("cancelling");
    timersRef.current.push(
      window.setTimeout(() => {
        setPhase("idle");
        restoreEditorFocus();
      }, duration.large * 1000),
    );
  }

  function stop(accept: boolean, send = false) {
    if (phase === "requesting") {
      requestRef.current++;
      finishCancellation();
      return;
    }
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return;
    acceptRef.current = accept;
    sendRef.current = accept && send;
    const speech = speechRef.current;
    speechRef.current = null;
    if (accept) {
      setPhase("transcribing");
      speechResultRef.current = speech?.finish() ?? null;
    } else {
      speech?.cancel();
      speechResultRef.current = null;
    }
    rec.stop();
  }

  async function finish(
    blob: Blob,
    request: number,
    browserResult: Promise<string> | null,
  ) {
    let restoreFocus = false;
    await (async () => {
      // A live browser result avoids uploading and reprocessing the complete
      // clip. The existing server transcription remains the fallback, so an
      // unsupported browser or a speech-service outage behaves as before.
      const liveText = (await browserResult?.catch(() => ""))?.trim() || "";
      const text = liveText || (await transcribeClip(blob));
      if (request !== requestRef.current) return;
      const callbacks = callbacksRef.current;
      if (!text) {
        setError("Heard nothing. Try again.");
        restoreFocus = true;
      } else if (sendRef.current && callbacks.onTextSend) {
        callbacks.onTextSend(text);
      } else {
        callbacks.onText(text);
        restoreFocus = true;
      }
    })()
      .catch((error: any) => {
        if (request !== requestRef.current) return;
        setError(error?.message || "Transcription failed");
        restoreFocus = true;
      })
      .finally(() => {
        if (request === requestRef.current) {
          sendRef.current = false;
          setLiveTranscript("");
          setPhase("idle");
          if (restoreFocus) restoreEditorFocus();
        }
      });
  }

  const start = async () => {
    setError(null);
    // getUserMedia only exists in secure contexts. Over plain http (the
    // :3850 hostname) the mic simply isn't there.
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(`Mic needs HTTPS. Open ${PRODUCT_NAME} at its ts.net URL.`);
      return;
    }
    // Take over the field in the same gesture that asked for the mic. Waiting
    // for a permission round trip first made the button appear unresponsive.
    const request = ++requestRef.current;
    speechRef.current?.cancel();
    speechRef.current = null;
    speechResultRef.current = null;
    setLiveTranscript("");
    setPhase("requesting");
    // The bar hides the field, so the caret must leave it too: a keystroke
    // into text nobody can see is an edit made blind, and the dictation is
    // about to append to that same draft.
    const focused = document.activeElement as HTMLElement | null;
    returnFocusRef.current = editTargetRef?.current ?? focused;
    focused?.blur?.();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      if (request === requestRef.current) {
        setError("Microphone permission denied");
        setPhase("idle");
        restoreEditorFocus();
      }
      return;
    }
    if (request !== requestRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    // Chrome/Firefox record webm/opus; iOS Safari only does mp4/AAC. The
    // server transcodes whatever container we send.
    const mime =
      ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
        MediaRecorder.isTypeSupported?.(m),
      ) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recRef.current = rec;
    chunksRef.current = [];
    acceptRef.current = false;
    sendRef.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const accepted = acceptRef.current;
      const browserResult = speechResultRef.current;
      speechResultRef.current = null;
      const blob = new Blob(chunksRef.current, {
        type: rec.mimeType || mime || "audio/webm",
      });
      cleanup();
      if (accepted) void finish(blob, request, browserResult);
      else finishCancellation();
    };

    // Live level meter for the waveform is progressive enhancement. Recording
    // works fine without it.
    await (async () => {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      timersRef.current.push(
        window.setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setLevels((prev) => [
            ...prev.slice(-(MAX_BAR_COUNT - 1)),
            Math.min(1, rms * 4),
          ]);
        }, 90),
      );
    })().catch(() => {
      // No waveform, no problem.
    });

    const startedAt = Date.now();
    setLevels([]);
    timersRef.current.push(
      window.setInterval(() => {
        if (Date.now() - startedAt >= MAX_SECONDS * 1000) stop(true);
      }, 1000),
    );
    rec.start(250);
    // Browser speech recognition streams partial text while the clip is still
    // being recorded. The audio blob remains the accuracy-preserving fallback
    // when the browser service is absent or fails.
    speechRef.current = startBrowserDictation(
      (text) => {
        if (request === requestRef.current) setLiveTranscript(text);
      },
      stream,
    );
    setPhase("recording");
  };

  useEffect(
    () => () => {
      requestRef.current++;
      speechRef.current?.cancel();
      speechRef.current = null;
      cleanup();
    },
    [],
  );

  // The overlay is visually modal, so make it modal to keyboards and assistive
  // technology too. The portal target remains interactive; its siblings are
  // restored to exactly the inert state they had before recording.
  const active = phase !== "idle";
  useLayoutEffect(() => {
    const waveform = waveformRef.current;
    if (!active || !waveform) return;
    const measure = () => {
      const count = Math.max(
        1,
        Math.min(
          MAX_BAR_COUNT,
          Math.floor((waveform.clientWidth + BAR_GAP) / (BAR_WIDTH + BAR_GAP)),
        ),
      );
      setBarCount((current) => (current === count ? current : count));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(waveform);
    return () => observer.disconnect();
  }, [active]);
  // The shortcut listener reads the live start closure through an effect
  // event, so the subscription keys stay the enablement state.
  const startFromShortcut = useEffectEvent(function onKeyDown(
    event: KeyboardEvent,
  ) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      disabled ||
      phase !== "idle" ||
      !matchesShortcut(event, "composer-dictate")
    )
      return;
    const button = idleButtonRef.current;
    const editorFocused = document.activeElement === editTargetRef?.current;
    if (!button || (!shortcutActive && !editorFocused)) return;
    if (button.closest("[inert], [hidden], [aria-hidden='true']")) return;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (!hit || (hit !== button && !button.contains(hit))) return;
    event.preventDefault();
    void start();
  });
  useEffect(() => {
    window.addEventListener("keydown", startFromShortcut);
    return () => window.removeEventListener("keydown", startFromShortcut);
  }, [disabled, editTargetRef, phase, shortcutActive]);
  const stopOnSend = useEffectEvent(function onKeyDown(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      !isSendCombo(event, sendKey)
    )
      return;
    event.preventDefault();
    stop(true, true);
  });
  useEffect(() => {
    if (phase !== "recording" || !onTextSend) return;
    window.addEventListener("keydown", stopOnSend);
    return () => window.removeEventListener("keydown", stopOnSend);
  }, [onTextSend, phase, sendKey]);
  useEffect(() => {
    activeChangeRef.current?.(active);
    return () => {
      if (active) activeChangeRef.current?.(false);
    };
  }, [active]);
  useEffect(() => {
    const target = overlayTarget;
    const parent = target?.parentElement;
    if (!active || !target || !parent) return;
    const siblings = Array.from(parent.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child !== target,
    );
    const previous = siblings.map((element) => [element, element.inert] as const);
    for (const [element] of previous) element.inert = true;
    return () => {
      for (const [element, inert] of previous) element.inert = inert;
    };
  }, [active, overlayTarget]);

  // Errors show as a small bubble above the control; clear themselves.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const overlay = phase !== "idle" && (
    <div
      className={cn(OVERLAY, overlayClassName || OVERLAY_RADIUS)}
      style={overlayStyle}
    >
      {phase === "recording" || phase === "requesting" || phase === "cancelling" ? (
        <motion.div
          key="recording" {...mergeStylexProps("", sx.phoneGap15, sx.flex, sx.h10, sx.minW0, sx.flex1, sx.itemsCenter, sx.gap2)}
          {...ROW_MOTION}
        >
          <span {...stylex.props(sx.srOnly)} role="status" aria-live="polite">
            {phase === "requesting" ? "Starting dictation" : "Recording"}
          </span>
          {/* Leading × puts the way out where a person's eye starts. The
              two committing actions stay together on the right. */}
          <Tooltip label="Cancel">
            <button
              type="button"
              className={cancelClassName || GLYPH_CANCEL}
              onClick={() => stop(false)}
              disabled={phase === "cancelling"}
              aria-label="Cancel dictation"
            >
              {cancelFromPlus ? (
                <motion.span
                  {...stylex.props(sx.inlineFlex)}
                  initial={PLUS_TO_CANCEL.initial}
                  animate={
                    phase === "cancelling"
                      ? PLUS_TO_CANCEL.initial
                      : PLUS_TO_CANCEL.animate
                  }
                  transition={PLUS_TO_CANCEL.transition}
                >
                  <IconPlus size={22} />
                </motion.span>
              ) : (
                <IconX size={22} />
              )}
            </button>
          </Tooltip>
          {/* Full-width track: baseline dots on the quiet/older left, live
              bars accumulating on the right by the accept buttons. */}
          <div
            ref={waveformRef} {...mergeStylexProps("", sx.phoneMx18px, sx.relative, sx.mx4, sx.flex, sx.hFull, sx.minW0, sx.flex1, sx.itemsCenter, sx.justifyCenter, sx.gap1, sx.overflowHidden)}
            aria-hidden="true"
          >
            <div
              className={cn(
                mergeStylexClassName("", sx.absolute, sx.inset0, sx.flex, sx.itemsCenter, sx.justifyCenter, sx.gap1, sx.transitionOpacity),
                liveTranscript && mergeStylexClassName("", sx.opacity15),
              )}
            >
              {Array.from({ length: barCount }, (_, i) => {
                const l = levels[levels.length - barCount + i];
                const active = l !== undefined;
                return (
                  <span
                    key={i}
                    className={active ? WAVE_BAR_LIVE : WAVE_BAR_IDLE}
                    style={{ height: active ? `${16 + l * 84}%` : undefined }}
                  />
                );
              })}
            </div>
            {liveTranscript && (
              <span {...stylex.props(sx.relative, sx.z1, sx.block, sx.minW0, sx.truncate, sx.textFg, typography.label)}>
                {liveTranscript}
              </span>
            )}
          </div>
          <Tooltip label="Keep it. The text lands in the draft to edit.">
            <button
              type="button"
              className={cn(className, mergeStylexClassName("", sx.hoverTextAccent, sx.textFg))}
              onClick={() => stop(true)}
              disabled={phase === "requesting" || phase === "cancelling"}
              aria-label="Stop and transcribe"
            >
              {/* Start with the mic at the checkmark's resting position,
                  then blur the two glyphs through one another. */}
              <motion.span
                {...stylex.props(sx.Absolute, sx.inset0, sx.inlineFlex, sx.itemsCenter, sx.justifyCenter)}
                {...MIC_OUT}
                aria-hidden="true"
              >
                <IconMic size={22} />
              </motion.span>
              <motion.span
                {...stylex.props(sx.inlineFlex)}
                {...CHECK_IN}
                aria-hidden="true"
              >
                <IconCheck size={22} />
              </motion.span>
            </button>
          </Tooltip>
          {onTextSend && (
            <Tooltip label="Send it" shortcut={sendKeyCaps}>
              <button
                type="button"
                className={cn(composerSend, composerSendDefault)}
                onClick={() => stop(true, true)}
                disabled={phase === "requesting" || phase === "cancelling"}
                aria-label="Stop, transcribe and send"
              >
                <IconArrowUp size={20} />
              </button>
            </Tooltip>
          )}
        </motion.div>
      ) : (
        <motion.div
          key="transcribing"
          {...stylex.props(sx.flex, sx.h10, sx.minW0, sx.flex1, sx.itemsCenter, sx.gap25, sx.px1)}
          role="status"
          aria-live="polite"
          {...ROW_MOTION}
        >
          <span {...stylex.props(sx.srOnly)}>Transcribing</span>
          {liveTranscript ? (
            <span
              {...stylex.props(sx.minW0, sx.truncate, sx.textFg, typography.label)}
              aria-hidden="true"
            >
              {liveTranscript}
            </span>
          ) : (
            <span
              {...stylex.props(sx.shrink0, sx.fontMedium, sx.textDim, typography.label)}
              aria-hidden="true"
            >
              Transcribing
              <span {...stylex.props(sx.inlineFlex)}>
                {TRANSCRIBING_DOT_STARTS.map((start, index) => (
                  <motion.span
                    key={index}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 0, 1, 1, 0, 0] }}
                    transition={{
                      ...TRANSCRIBING_DOT_MOTION,
                      times: [0, start, start + 0.06, 0.72, 0.78, 1],
                    }}
                  >
                    .
                  </motion.span>
                ))}
              </span>
            </span>
          )}
        </motion.div>
      )}
    </div>
  );
  return (
    <>
      <Tooltip label="Dictate" shortcut={dictateKeys ?? undefined}>
        <button
          ref={idleButtonRef}
          type="button"
          className={className}
          onClick={start}
          disabled={disabled || phase !== "idle"}
          aria-label="Dictate"
        >
          <IconMic size={22} />
        </button>
      </Tooltip>
      {error && phase === "idle" && (
        <div
          role="alert" {...mergeStylexProps("", sx.borderColorMixInSrgbVarRed40Transparent, sx.absolute, sx.bottomCalc1008px, sx.right0, sx.z7, sx.whitespaceNowrap, sx.roundedControl, sx.border, sx.bgRedSoft, sx.px11px, sx.py7px, sx.fontMedium, sx.textRed, typography.supporting)}
        >
          {error}
        </div>
      )}
      {overlayTarget && overlay ? createPortal(overlay, overlayTarget) : overlay}
    </>
  );
}
