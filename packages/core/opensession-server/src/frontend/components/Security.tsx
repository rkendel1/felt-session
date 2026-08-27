import { repoLabel } from "../lib/repo-label";
import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import {
  fetchSecurity,
  startScanApi,
  deleteScanApi,
  createScanProfileApi,
  updateScanProfileApi,
  deleteScanProfileApi,
  fetchAutomations,
  relativeTime,
  type SecurityScan,
  type ScanProfile,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { AGENT_NAME, docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { Menu } from "../ui/menu";
import { Modal } from "../ui/modal";
import { CheckStatusIcon } from "./CheckStatusIcon";
import { IconDotsHorizontal, IconPencil, IconPlus, IconTrash } from "./icons";
import { SOURCE_CHIP } from "../lib/source-chip-classes";
import { Field, Input, Textarea } from "../ui/input";
import { OptionSelect } from "../ui/select";
import {
  SettingCard,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
  StatusChip,
  rowMenuTriggerClasses,
} from "../ui/settings";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minH0: {
			minHeight: "0"
	},
	flex1: {
			flex: "1"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	px8: {
			paddingInline: "32px"
	},
	pt11: {
			paddingTop: "44px"
	},
	pb22: {
			paddingBottom: "88px"
	},
	selfStart: {
			alignSelf: "flex-start"
	},
	mb4: {
			marginBottom: "16px"
	},
	px5: {
			paddingInline: "20px"
	},
	mb3: {
			marginBottom: "12px"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	mt1: {
			marginTop: "4px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	textRed: {
			color: "var(--red)"
	},
	mt0: {
			marginTop: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap3: {
			gap: "12px"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	gap2: {
			gap: "8px"
	},
	mt2: {
			marginTop: "8px"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap1: {
			gap: "4px"
	},
	minW0: {
			minWidth: "0"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	size2: {
			width: "8px",
			height: "8px"
	},
	shrink0: {
			flexShrink: "0"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	textFg: {
			color: "var(--text)"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	gap35: {
			gap: "14px"
	},
	mt3px: {
			marginTop: "3px"
	},
	mt05: {
			marginTop: "2px"
	},
	block: {
			display: "block"
	},
	fontNormal: {
			fontWeight: "var(--font-weight-normal)"
	},

	size5: {
		"width": "20px",
		"height": "20px"
	},
	textGreen: {
		"color": "var(--green)"
	},
	phoneFlexCol: {
		"@media (max-width: 720px)": {
			"flexDirection": "column"
		}
	},
	phoneItemsStart: {
		"@media (max-width: 720px)": {
			"alignItems": "flex-start"
		}
	},
	phoneGap3: {
		"@media (max-width: 720px)": {
			"gap": "12px"
		}
	},
	lineClamp2: {
		"WebkitLineClamp": "2",
		"WebkitBoxOrient": "vertical",
		"display": "-webkit-box",
		"overflow": "hidden"
	},
	mlAuto: {
		"marginLeft": "auto"
	},
	flexRow: {
		"flexDirection": "row"
	},
	gap25: {
		"gap": "10px"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	opacity50: {
		"opacity": ".5"
	},

	phonePx4: {
		"@media (max-width: 720px)": {
			"paddingInline": "16px"
		}
	},
	phonePt5: {
		"@media (max-width: 720px)": {
			"paddingTop": "20px"
		}
	},
	phonePb12: {
		"@media (max-width: 720px)": {
			"paddingBottom": "48px"
		}
	},
	textLink: {
		"color": "var(--link)"
	},
	noUnderline: {
		"textDecorationLine": "none"
	},
	hoverUnderline: {
		"@media (hover: hover)": {
			":hover": {
				"textDecorationLine": "underline"
			}
		}
	},
});

/* Security is a tool surface hosted inside Settings, so it reads as one of its
   pages: the settings reading column, a SettingsHeader on top, and each group
   of rows on a SettingCard plate. Its two forms are real dialogs (ui/modal)
   rather than hand-rolled overlays, which is what gets them a focus trap. */

/** 16px on phones, so iOS doesn't zoom a focused field; paragraph leading in a
    textarea. Both reach in from a dialog's body to its fields. */
const FORM_FIELDS =
  "[&_textarea]:leading-normal phone:[&_input]:text-input-phone phone:[&_select]:text-input-phone phone:[&_textarea]:text-input-phone";
/** A link inside a row: the session an entry points at, the page that owns it. */
const LINK = mergeStylexClassName("", sx.cursorPointer, sx.textLink, sx.noUnderline, sx.hoverUnderline);

interface Props {
  onOpenSession: (sessionId: string) => void;
}

interface RecurringScan {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: string;
  lastRunSessionId?: string;
}

type Tab = "scans" | "profiles";

/** A scan's state as the settings row reads it: a dot and a word. */
function scanStatus(status: SecurityScan["status"]): { label: string; dot: string } {
  if (status === "running") return { label: "Running", dot: "var(--yellow)" };
  if (status === "done") return { label: "Done", dot: "var(--green)" };
  if (status === "interactive") return { label: "Interactive", dot: "var(--accent)" };
  return { label: "Error", dot: "var(--red)" };
}

/** The ✓/✗ a finished run carries, in the app's shared check glyph. */
function RunGlyph({ ok, title }: { ok: boolean; title?: string }) {
  return (
    <span
      className={cn(
        mergeStylexClassName("[&_svg]:size-3.5", sx.flex, sx.size5, sx.shrink0, sx.itemsCenter, sx.justifyCenter),
        ok ? mergeStylexClassName("", sx.textGreen) : mergeStylexClassName("", sx.textRed),
      )}
      title={title}
    >
      <CheckStatusIcon kind={ok ? "success" : "failure"} />
    </span>
  );
}

export function Security({ onOpenSession }: Props) {
  const [scans, setScans] = useState<SecurityScan[]>([]);
  const [profiles, setProfiles] = useState<ScanProfile[]>([]);
  const [repos, setRepos] = useState<Array<{ id: string }>>([]);
  const [recurring, setRecurring] = useState<RecurringScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("scans");
  const [showNewScan, setShowNewScan] = useState(false);
  const [editProfile, setEditProfile] = useState<ScanProfile | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stable identity: only setters and module functions are captured, so the
  // polling effect can list `load` without ever refiring from re-renders.
  const load = useCallback(async () => {
    await (async () => {
const data = await fetchSecurity();
      setScans(data.scans);
      setProfiles(data.profiles);
      setRepos(data.repos);
      setLoading(false);
})().catch(async () => {

});
    await (async () => {
const autos = await fetchAutomations();
      setRecurring(
        (autos as RecurringScan[]).filter((a) =>
          /deepsec|security scan/i.test(a.name),
        ),
      );
})().catch(async () => {

});
  }, []);

  useEffect(() => {
    document.title = docTitle("Security");
    load();
    const id = setInterval(load, 10000);
    return () => {
      clearInterval(id);
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  async function handleDeleteScan(s: SecurityScan) {
    if (!confirm("Remove this scan record? Its sessions are left as-is.")) return;
    await (async () => {
await deleteScanApi(s.id);
      load();
})().catch(async (e: any) => {
setError(e.message);
});
  }

  async function handleDeleteProfile(p: ScanProfile) {
    if (!confirm(`Delete profile "${p.name}"?`)) return;
    await (async () => {
await deleteScanProfileApi(p.id);
      load();
})().catch(async (e: any) => {
setError(e.message);
});
  }

  return (
    <div {...mergeStylexProps("", sx.phonePx4, sx.phonePt5, sx.phonePb12, sx.flex, sx.minH0, sx.flex1, sx.justifyCenter, sx.overflowYAuto, sx.px8, sx.pt11, sx.pb22)}>
      <SettingsPanel className={mergeStylexOverrideClassName("", sx.selfStart)}>
        <SettingsHeader
          title="Security"
          description="deepsec scans across your repos. Every confirmed finding lands as its own PR."
          className={mergeStylexOverrideClassName("", sx.phoneFlexCol, sx.phoneItemsStart, sx.phoneGap3)}
          actions={
            tab === "profiles" ? (
              <Button
                variant="primary"
                icon={<IconPlus size={16} />}
                onClick={() => setEditProfile("new")}
              >
                New profile
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<IconPlus size={16} />}
                onClick={() => setShowNewScan(true)}
              >
                New scan
              </Button>
            )
          }
        />

        {/* The tab bar takes the card's own inset, so it sits over the rows it
            switches rather than over the page. */}
        <div {...stylex.props(sx.mb4, sx.px5)}>
          <Segmented
            label="Security view"
            value={tab}
            onValueChange={(next) => setTab(next as Tab)}
          >
            <SegmentedOption value="scans">Scans {scans.length}</SegmentedOption>
            <SegmentedOption value="profiles">Profiles {profiles.length}</SegmentedOption>
          </Segmented>
        </div>

        {error && (
          <InlineAlert className={mergeStylexOverrideClassName("", sx.mb3)} onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        )}

        {loading ? (
          <LoadingState>Loading…</LoadingState>
        ) : tab === "profiles" ? (
          <SettingCard>
            {profiles.length === 0 ? (
              <EmptyState placement="row" title="No scan profiles yet">
                A profile tells a scan how to read your code: what to prioritize,
                what is intentionally public, and where the severity bar sits.
              </EmptyState>
            ) : (
              profiles.map((p) => (
                <SettingRow key={p.id} className={mergeStylexOverrideClassName("", sx.itemsStart)}>
                  <SettingRowText>
                    <SettingRowTitle>{p.name}</SettingRowTitle>
                    <SettingRowDescription className={mergeStylexOverrideClassName("", sx.lineClamp2)}>
                      {p.prompt}
                    </SettingRowDescription>
                    <div {...stylex.props(sx.mt1, sx.textFaint, typography.meta)}>by {p.createdBy}</div>
                  </SettingRowText>
                  <SettingRowControl>
                    <Menu.Root>
                      <Menu.Trigger
                        className={rowMenuTriggerClasses}
                        aria-label={`Manage ${p.name}`}
                      >
                        <IconDotsHorizontal size={18} />
                      </Menu.Trigger>
                      <Menu.Popup align="end" sideOffset={4}>
                        <Menu.Item onClick={() => setEditProfile(p)}>
                          <IconPencil size={16} />
                          Edit profile
                        </Menu.Item>
                        <Menu.Item
                          onClick={() => handleDeleteProfile(p)} {...mergeStylexProps("data-[highlighted]:bg-red-soft", sx.textRed)}
                        >
                          <IconTrash size={16} />
                          Delete profile
                        </Menu.Item>
                      </Menu.Popup>
                    </Menu.Root>
                  </SettingRowControl>
                </SettingRow>
              ))
            )}
          </SettingCard>
        ) : (
          <>
            {recurring.length > 0 && (
              <>
                <SettingsGroupLabel className={mergeStylexOverrideClassName("", sx.mt0)}>Recurring</SettingsGroupLabel>
                <SettingCard>
                  {recurring.map((r) => (
                    <SettingRow key={r.id}>
                      <SettingRowText>
                        <SettingRowTitle>{r.name}</SettingRowTitle>
                        <SettingRowDescription>
                          {r.schedule}
                          {r.lastRunAt ? ` · last run ${relativeTime(r.lastRunAt)}` : ""}
                        </SettingRowDescription>
                      </SettingRowText>
                      <SettingRowControl className={mergeStylexOverrideClassName("", sx.flex, sx.itemsCenter, sx.gap3)}>
                        {r.lastRunStatus === "ok" || r.lastRunStatus === "error" ? (
                          <RunGlyph
                            ok={r.lastRunStatus === "ok"}
                            title={
                              r.lastRunStatus === "ok" ? "Last run ok" : "Last run failed"
                            }
                          />
                        ) : null}
                        <StatusChip
                          label={r.enabled ? "On" : "Off"}
                          dot={r.enabled ? "var(--green)" : "var(--text-faint)"}
                        />
                        <a className={LINK} href={`${BASE_PATH}/automations`}>
                          Manage
                        </a>
                      </SettingRowControl>
                    </SettingRow>
                  ))}
                </SettingCard>
                <SettingsGroupLabel>Scans</SettingsGroupLabel>
              </>
            )}

            <SettingCard>
              {scans.length === 0 ? (
                <EmptyState placement="row" title="No scans yet">
                  Start a scan to search for findings across your repositories.
                </EmptyState>
              ) : (
                scans.map((s) => (
                  <SettingRow key={s.id} className={mergeStylexOverrideClassName("", sx.itemsStart)}>
                    <SettingRowText>
                      <div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap2)}>
                        <SettingRowTitle>
                          {s.interactive ? "Interactive scan" : "Scan"} ·{" "}
                          {s.repos.map(repoLabel).join(", ")}
                        </SettingRowTitle>
                        {s.profileName && (
                          <span className={SOURCE_CHIP} title="Scan profile">
                            {s.profileName}
                          </span>
                        )}
                      </div>

                      {s.instructions && (
                        <SettingRowDescription className={mergeStylexOverrideClassName("", sx.lineClamp2)}>
                          {s.instructions}
                        </SettingRowDescription>
                      )}

                      <div {...stylex.props(sx.mt2, sx.flex, sx.flexCol, sx.gap1)}>
                        {s.sessions.map((ref) => (
                          <div
                            key={ref.repo + ref.sessionId}
                            {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2, sx.textDim, typography.label)}
                          >
                            {ref.status === "running" ? (
                              <span
                                {...stylex.props(sx.size2, sx.shrink0, sx.roundedFull)}
                                style={{ background: "var(--yellow)" }}
                                title="Running"
                              />
                            ) : (
                              <RunGlyph ok={ref.status === "ok"} title={ref.error} />
                            )}
                            <span {...stylex.props(sx.shrink0, sx.textFg)}>{repoLabel(ref.repo)}</span>
                            {ref.error && (
                              <span {...stylex.props(sx.truncate, sx.textRed)} title={ref.error}>
                                {ref.error}
                              </span>
                            )}
                            {ref.sessionId && (
                              <a
                                className={cn(LINK, mergeStylexClassName("", sx.mlAuto, sx.shrink0))}
                                href={`${BASE_PATH}/session/${ref.sessionId}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  onOpenSession(ref.sessionId);
                                }}
                              >
                                View session
                              </a>
                            )}
                          </div>
                        ))}
                      </div>

                      <div {...stylex.props(sx.mt2, sx.textFaint, typography.meta)}>
                        started {relativeTime(s.createdAt)}
                        {s.finishedAt && ` · finished ${relativeTime(s.finishedAt)}`}
                        {` · by ${s.createdBy}`}
                      </div>
                    </SettingRowText>
                    <SettingRowControl className={mergeStylexOverrideClassName("", sx.flex, sx.itemsCenter, sx.gap2)}>
                      <StatusChip {...scanStatus(s.status)} />
                      <Menu.Root>
                        <Menu.Trigger className={rowMenuTriggerClasses} aria-label="Manage scan">
                          <IconDotsHorizontal size={18} />
                        </Menu.Trigger>
                        <Menu.Popup align="end" sideOffset={4}>
                          <Menu.Item
                            onClick={() => handleDeleteScan(s)} {...mergeStylexProps("data-[highlighted]:bg-red-soft", sx.textRed)}
                          >
                            <IconTrash size={16} />
                            Remove scan
                          </Menu.Item>
                        </Menu.Popup>
                      </Menu.Root>
                    </SettingRowControl>
                  </SettingRow>
                ))
              )}
            </SettingCard>
          </>
        )}

        <NewScanModal
          open={showNewScan}
          repos={repos.map((r) => r.id)}
          profiles={profiles}
          onOpenChange={setShowNewScan}
          onStarted={(sessionId) => {
            setShowNewScan(false);
            load();
            if (sessionId) onOpenSession(sessionId);
          }}
        />

        <ProfileModal
          open={!!editProfile}
          initial={editProfile && editProfile !== "new" ? editProfile : null}
          onOpenChange={(next) => {
            if (!next) setEditProfile(null);
          }}
          onSaved={() => {
            setEditProfile(null);
            load();
          }}
        />
      </SettingsPanel>
    </div>
  );
}

// ── New scan dialog ──────────────────────────────────────────

function NewScanModal({
  open,
  repos,
  profiles,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  repos: string[];
  profiles: ScanProfile[];
  onOpenChange: (open: boolean) => void;
  onStarted: (sessionId?: string) => void;
}) {
  const [scope, setScope] = useState<"single" | "all">("single");
  const [repo, setRepo] = useState("");
  const [profileId, setProfileId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [recurrence, setRecurrence] = useState<"none" | "daily" | "weekly">("none");
  const [interactive, setInteractive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Open with the caret in the first field rather than on the close button,
  // which is where Base UI puts it by default.
  const repoRef = React.useRef<HTMLButtonElement>(null);

  const singleRepo = scope === "single" && !!repo;
  const canRecur = singleRepo && !interactive;
  const canInteractive = singleRepo && recurrence === "none";

  const firstRepo = repos[0] || "";
  // The dialog stays mounted, so each opening starts from a clean draft.
  useEffect(() => {
    if (!open) return;
    setScope("single");
    setRepo(firstRepo);
    setProfileId("");
    setInstructions("");
    setRecurrence("none");
    setInteractive(false);
    setStarting(false);
    setError(null);
  }, [open, firstRepo]);

  async function handleStart() {
    setStarting(true);
    setError(null);
    await (async () => {
const res = await startScanApi({
        repos: scope === "all" ? "all" : [repo],
        profileId: profileId || undefined,
        instructions: instructions.trim() || undefined,
        interactive: canInteractive && interactive,
        recurrence: canRecur ? recurrence : "none",
        createdBy: getCurrentUser(),
      });
      onStarted(res.sessionId);
})().catch(async (e: any) => {
setError(e.message);
      setStarting(false);
});
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!starting) onOpenChange(next);
      }}
    >
      <Modal.Content
        widthClassName={mergeStylexClassName("", sharedClassStyles.maxW34rem)}
        className={FORM_FIELDS}
        initialFocus={repoRef}
      >
        <Modal.Header
          title="New scan"
          description="Start a search for findings across your repositories."
        />

        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap35)}>
          {/* self-start: the track hugs its two options. A flex column stretches
              its children, and a stretched segmented control is a full-width
              well with a knob sitting in one corner of it. */}
          <Segmented
            className={mergeStylexOverrideClassName("", sx.selfStart)}
            label="Scan scope"
            value={scope}
            onValueChange={(next) => {
              if (next === "all") {
                setScope("all");
                setInteractive(false);
                setRecurrence("none");
                return;
              }
              setScope("single");
            }}
          >
            <SegmentedOption value="single">Single repo</SegmentedOption>
            <SegmentedOption value="all">All repos</SegmentedOption>
          </Segmented>

          {scope === "single" && (
            <Field label="Repository">
              <OptionSelect
                triggerRef={repoRef}
                label="Repository"
                value={repo}
                options={repos.map((r) => ({ value: r, label: repoLabel(r) }))}
                onChange={setRepo}
              />
            </Field>
          )}

          <Field label="Scan profile">
            <OptionSelect
              label="Scan profile"
              value={profileId}
              options={[
                { value: "", label: "None · default threat model" },
                ...profiles.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={setProfileId}
            />
            {profiles.length === 0 && (
              <span {...stylex.props(sx.textFaint, typography.supporting)}>
                No profiles yet. A profile tells a scan how to read your code.
              </span>
            )}
          </Field>

          <Field label="Instructions for this scan (optional)">
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              placeholder="Focus or constrain the scan. e.g. “only the upload pipeline and its S3 handling”, “report only, no fix PRs”…"
            />
          </Field>

          <Field label="Repeats">
            <OptionSelect
              label="Repeats"
              value={canRecur ? recurrence : "none"}
              options={[
                { value: "none", label: "Does not repeat" },
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
              ]}
              onChange={(next) => setRecurrence(next as "none" | "daily" | "weekly")}
              disabled={!canRecur}
            />
            {!singleRepo && (
              <span {...stylex.props(sx.textFaint, typography.supporting)}>
                Recurring and interactive scans take one repository at a time.
              </span>
            )}
          </Field>

          <label
            className={cn(
              mergeStylexClassName("", sx.flex, sx.flexRow, sx.itemsStart, sx.gap25, typography.label, sx.fontMedium, sx.textDim),
              canInteractive ? mergeStylexClassName("", sx.cursorPointer) : mergeStylexClassName("", sx.opacity50),
            )}
          >
            <Checkbox
              className={mergeStylexOverrideClassName("", sx.mt3px)}
              checked={canInteractive && interactive}
              disabled={!canInteractive}
              onCheckedChange={setInteractive}
            />
            <span>
              Interactive mode
              <span {...stylex.props(sx.mt05, sx.block, sx.fontNormal, sx.textFaint, typography.label)}>
                Instead of scanning end to end, {AGENT_NAME} shapes the threat model
                with you in a session first.
              </span>
            </span>
          </label>

          {error && <InlineAlert>{error}</InlineAlert>}
        </div>

        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={starting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleStart}
            disabled={starting || (scope === "single" && !repo)}
          >
            {starting
              ? "Starting…"
              : recurrence !== "none" && canRecur
                ? "Create recurring scan"
                : interactive && canInteractive
                  ? "Start interactive session"
                  : "Start scan"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

// ── Profile dialog ───────────────────────────────────────────

function ProfileModal({
  open,
  initial,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  initial: ScanProfile | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name || "");
    setPrompt(initial?.prompt || "");
    setSaving(false);
    setError(null);
  }, [open, initial]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    await (async () => {
if (initial) await updateScanProfileApi(initial.id, { name, prompt });
      else await createScanProfileApi({ name, prompt, createdBy: getCurrentUser() });
      onSaved();
})().catch(async (e: any) => {
setError(e.message);
      setSaving(false);
});
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <Modal.Content
        widthClassName={mergeStylexClassName("", sharedClassStyles.maxW34rem)}
        className={FORM_FIELDS}
        initialFocus={nameRef}
      >
        <Modal.Header
          title={initial ? `Edit "${initial.name}"` : "New scan profile"}
          description="A profile tells every scan that uses it how to read your code."
        />

        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap35)}>
          <Field label="Name">
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Payments-focused, strict"
            />
          </Field>

          <Field label="Threat model">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={8}
              placeholder={
                "What to prioritize (auth, payments, uploads…), what's intentionally public, known accepted risks / false positives to skip, severity bar, PR-per-finding vs report-only…"
              }
            />
          </Field>

          {error && <InlineAlert>{error}</InlineAlert>}
        </div>

        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || !prompt.trim()}
          >
            {saving ? "Saving…" : initial ? "Save changes" : "Create profile"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
