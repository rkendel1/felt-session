import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseOpencodeModel,
  opencodeGateReason,
  opencodeRunPolicy,
  opencodeDeniedToolIds,
  proxyOpencodeMcpConfigs,
  remoteOpencodeMcpConfigs,
  inProcessOpencodeMcpConfigs,
  reconnectSharedInProcessMcp,
  sharedOpencodeEligible,
  sharedServerKey,
  opencodeServerDisposition,
  classifyOpencodeTurnFailure,
  shouldRepairEmptyCompletion,
  shouldRetryTransientRun,
  emptyCompletionRepairPrompt,
  meridianRequiredModels,
  buildTurnResultEvents,
  openaiBridgeAccountState,
} from "./opencode-runner";
import { buildRunInstructions } from "./run-instructions";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import { STRIPE_CONFIRM_TOOLS, filterMcpServers } from "./runner-shared";
import { DESK_NOTE } from "./desk";
import {
  automationDeniedTools,
  opencodeAutomationModel,
  DEFAULT_OPENCODE_AUTOMATION_MODEL,
} from "./automations";
import {
  flattenMessageText,
  replayConversation,
  jsonSchemaToZodShape,
  admitBridgeRequest,
} from "./anthropic-bridge";
import {
  opencodeTurnTimeoutMs,
  bridgeMaxRequestsPerHour,
  normalizeOpencodeConfig,
  DEFAULT_TURN_TIMEOUT_MINUTES,
  DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR,
} from "./opencode-config";

// Roster-dependent assertions below (alias "Alex"/"alex" resolving to the
// GitHub login "happylinks") must not read the operator's real
// ~/.opensession/config.json — pin a fixture roster for this file so the
// tests pass on any machine.
let restoreIdentities: (() => void) | undefined;
beforeAll(() => {
  restoreIdentities = __setIdentitiesForTest([
    { name: "Alex Rivera", email: "alex@example.com", github: "happylinks" },
  ]);
});
afterAll(() => restoreIdentities?.());

describe("parseOpencodeModel", () => {
  test("splits provider/model", () => {
    expect(parseOpencodeModel("opencode/anthropic/claude-sonnet-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
    });
  });
  test("model id may contain slashes (openrouter-style)", () => {
    expect(parseOpencodeModel("opencode/openrouter/meta/llama-4")).toEqual({
      providerID: "openrouter",
      modelID: "meta/llama-4",
    });
  });
  test("rejects non-opencode and malformed ids", () => {
    expect(parseOpencodeModel("claude-sonnet-5")).toBeNull();
    expect(parseOpencodeModel("opencode/anthropic")).toBeNull();
    expect(parseOpencodeModel("opencode/anthropic/")).toBeNull();
    expect(parseOpencodeModel("opencode//x")).toBeNull();
  });
});

describe("shared server eligibility", () => {
  test("keeps same-owner aliases on the shared server", () => {
    expect(
      sharedOpencodeEligible({
        journal: { kind: "prompt" },
        user: "happylinks",
        mcpGrantUser: "Alex",
      }),
    ).toBe(true);
  });

  test('"all" is the wide default, not an allowlist that forfeits the pool', () => {
    // The eligibility check predates McpScope, when "every server" was spelled
    // `undefined` and any VALUE meant a restriction. Reading a truthy "all" as
    // a restriction would push every pooled interactive run onto its own
    // server — the amnesiac-turn-2 failure the pool exists to avoid.
    expect(
      sharedOpencodeEligible({ journal: { kind: "prompt" }, mcpServers: "all" }),
    ).toBe(true);
    expect(
      sharedOpencodeEligible({ journal: { kind: "prompt" }, mcpServers: ["grafana"] }),
    ).toBe(false);
    expect(
      sharedOpencodeEligible({ journal: { kind: "prompt" }, mcpServers: [] }),
    ).toBe(false);
  });

  test("keeps cross-owner sessions off the prompter's shared server", () => {
    expect(
      sharedOpencodeEligible({
        journal: { kind: "prompt" },
        user: "Jaap",
        mcpGrantUser: "Alex",
      }),
    ).toBe(false);
  });

  test("separates user GitHub auth from the service-credential pool", () => {
    expect(sharedServerKey("openai-account", "Kent")).toBe(
      "shared:openai-account:kent",
    );
    expect(sharedServerKey("openai-account", "Kent", "9ranty")).toBe(
      "shared:openai-account:kent:github-9ranty",
    );
  });

  test("drains adopted recovery holds before reusing or replacing them", () => {
    expect(
      opencodeServerDisposition({
        alive: true,
        sameConfig: true,
        sharedRequest: false,
        activeRuns: 0,
        recoveringRuns: 1,
      }),
    ).toBe("drain");
    expect(
      opencodeServerDisposition({
        alive: true,
        sameConfig: true,
        sharedRequest: false,
        activeRuns: 0,
      }),
    ).toBe("reuse");
    expect(
      opencodeServerDisposition({
        alive: true,
        sameConfig: true,
        sharedRequest: true,
        activeRuns: 0,
        recoveringRuns: 1,
      }),
    ).toBe("reuse");
  });
});

describe("Dial Meridian quota preflight", () => {
  test("requires both Opus main and Fable oracle capacity", () => {
    expect(meridianRequiredModels("claude-opus-5", "oracle-fable")).toEqual([
      "claude-opus-5",
      "claude-fable-5",
    ]);
  });

  test("uses the same-bridge Opus oracle for an Anthropic Fable main", () => {
    expect(meridianRequiredModels("claude-fable-5", "oracle-sol")).toEqual([
      "claude-fable-5",
      "claude-opus-5",
    ]);
  });
});

describe("empty successful completion recovery", () => {
  test("retries one empty or whitespace-only stop, then stays bounded", () => {
    expect(shouldRepairEmptyCompletion("", 0)).toBe(true);
    expect(shouldRepairEmptyCompletion(" \n\t", 0)).toBe(true);
    expect(shouldRepairEmptyCompletion("", 1)).toBe(false);
    expect(shouldRepairEmptyCompletion("Finished the task.", 0)).toBe(false);
  });

  test("repair prompt anchors the original task and demands a real finish", () => {
    const prompt = emptyCompletionRepairPrompt("make the PR");
    expect(prompt).toContain("previous response stopped successfully");
    expect(prompt).toContain("make the PR");
    expect(prompt).toContain("finish the user's task");
  });
});

describe("transient bridge recovery", () => {
  test("retains API-key accounts for rotation without enabling the OAuth liveness guard", () => {
    const account = {
      id: "acc-key-rotation",
      name: "api-key-account",
      kind: "api_key" as const,
      value: "sk-test",
      createdAt: "2026-08-16T00:00:00Z",
    };

    const state = openaiBridgeAccountState(account, "api-key");

    expect(state.account).toBe(account);
    expect(state.livenessGuard).toBe(false);
  });

  test("classifies provider limits once while preserving the user-facing message", () => {
    const anthropicMessage = "Claude usage limit reached";
    const openaiMessage = "The usage limit has been reached";

    expect(classifyOpencodeTurnFailure("anthropic", anthropicMessage)).toEqual({
      kind: "usage_limit",
      message: anthropicMessage,
    });
    expect(classifyOpencodeTurnFailure("openai", openaiMessage)).toEqual({
      kind: "usage_limit",
      message: openaiMessage,
    });
    expect(classifyOpencodeTurnFailure("openai", "fetch failed")).toEqual({
      kind: "other",
      message: "fetch failed",
    });
  });

  test("keeps explicit failure kinds authoritative over message text", () => {
    expect(
      classifyOpencodeTurnFailure(
        "openai",
        "OpenAI provider overloaded on account alpha",
        "provider_overloaded",
      ),
    ).toEqual({
      kind: "provider_overloaded",
      message: "OpenAI provider overloaded on account alpha",
    });
    expect(
      classifyOpencodeTurnFailure(
        "anthropic",
        "Claude subscription issue on account beta",
        "usage_limit",
      ),
    ).toEqual({
      kind: "usage_limit",
      message: "Claude subscription issue on account beta",
    });
  });

  test("walks two alternative accounts after distinct bridge wedges", () => {
    expect(
      shouldRetryTransientRun({
        failure: { kind: "liveness_wedge", message: "silent bridge" },
        hasAlternativeAccount: true,
        attemptIndex: 0,
        wedgeRetries: 0,
      })
    ).toBe(true);
    expect(
      shouldRetryTransientRun({
        failure: { kind: "liveness_wedge", message: "silent bridge" },
        hasAlternativeAccount: true,
        attemptIndex: 1,
        wedgeRetries: 1,
      })
    ).toBe(true);
    expect(
      shouldRetryTransientRun({
        failure: { kind: "liveness_wedge", message: "silent bridge" },
        hasAlternativeAccount: true,
        attemptIndex: 2,
        wedgeRetries: 2,
      })
    ).toBe(false);
  });

  test("keeps ordinary and same-account transient retries at one", () => {
    expect(
      shouldRetryTransientRun({
        failure: { kind: "other", message: "fetch failed" },
        hasAlternativeAccount: false,
        attemptIndex: 0,
        wedgeRetries: 0,
      })
    ).toBe(true);
    expect(
      shouldRetryTransientRun({
        failure: { kind: "other", message: "fetch failed" },
        hasAlternativeAccount: false,
        attemptIndex: 1,
        wedgeRetries: 0,
      })
    ).toBe(false);
    expect(
      shouldRetryTransientRun({
        failure: { kind: "liveness_wedge", message: "silent bridge" },
        hasAlternativeAccount: false,
        attemptIndex: 1,
        wedgeRetries: 1,
      })
    ).toBe(false);
  });

  test("does not respawn a server after an explicit provider overload", () => {
    expect(
      shouldRetryTransientRun({
        failure: {
          kind: "provider_overloaded",
          message: "OpenAI provider overloaded on account alpha",
        },
        hasAlternativeAccount: true,
        attemptIndex: 0,
        wedgeRetries: 0,
      })
    ).toBe(false);
  });

  test("does not retry a classified usage limit as a transient failure", () => {
    expect(
      shouldRetryTransientRun({
        failure: { kind: "usage_limit", message: "Claude usage limit reached" },
        hasAlternativeAccount: true,
        attemptIndex: 0,
        wedgeRetries: 0,
      }),
    ).toBe(false);
  });
});

describe("opencodeGateReason (run gate)", () => {
  test("interactive kinds pass", () => {
    expect(opencodeGateReason({ journal: { kind: "prompt" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "create" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "goal" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "prompt-resume" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "prompt-fallback" } })).toBeNull();
  });
  test("automation kinds pass (least-privilege enforced via opencodeRunPolicy)", () => {
    expect(opencodeGateReason({ journal: { kind: "automation" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "automation-resume" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "automation-fallback" } })).toBeNull();
  });
  test("deniedTools no longer blocks — enforcement moved to the policy layer", () => {
    expect(
      opencodeGateReason({
        journal: { kind: "prompt" },
        deniedTools: { mcp__plain__reply_to_thread: "no" },
      })
    ).toBeNull();
  });
  test("deny by default: no journal / no kind / empty kind are all blocked", () => {
    expect(opencodeGateReason({})).toContain("deny by default");
    expect(opencodeGateReason({ journal: {} })).toContain("deny by default");
    expect(opencodeGateReason({ journal: { kind: "" } })).toContain("deny by default");
  });
  test("explicit allowOpencode marker passes without a journal (verify scripts)", () => {
    expect(opencodeGateReason({ allowOpencode: true })).toBeNull();
  });
  test("single-engine: every known run kind is allowed (unattended policy applies)", () => {
    expect(opencodeGateReason({ journal: { kind: "action" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "action-resume" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "github-review" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "security-scan" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "plain" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "linear" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "slack" } })).toBeNull();
  });
  test("unknown kinds stay blocked (deny by default)", () => {
    expect(opencodeGateReason({ journal: { kind: "mystery-kind" } })).toContain("not available");
  });
});

describe("opencodeRunPolicy (unattended least-privilege enforcement)", () => {
  const DENIED = automationDeniedTools();

  test("automation runs are unattended even with an empty deny-set", () => {
    expect(opencodeRunPolicy({ journalKind: "automation" }).unattended).toBe(true);
    expect(opencodeRunPolicy({ journalKind: "automation-resume" }).unattended).toBe(true);
  });
  test("deniedTools force unattended regardless of kind (interactive resume of automation session)", () => {
    expect(
      opencodeRunPolicy({ journalKind: "prompt", deniedTools: DENIED }).unattended
    ).toBe(true);
  });
  test("interactive runs strip the money-movers but keep the server (reads stay)", () => {
    const p = opencodeRunPolicy({ journalKind: "prompt", confirmTools: STRIPE_CONFIRM_TOOLS });
    expect(p.unattended).toBe(false);
    expect(p.disables["stripe_create_refund"]).toBe(false);
    expect(p.disables["stripe_stripe_api_write"]).toBe(false);
    // Only the confirm tools (and the native question tool) are stripped —
    // nothing read-shaped.
    expect(p.disables["stripe_stripe_api_read"]).toBeUndefined();
    // Interactive wording: ask the human in the session, not the internal note.
    const note = p.noteGroups.find((g) => g.tools.includes("mcp__stripe__create_refund"))!;
    expect(note.message).toContain("human in this session");
    expect(note.message).not.toContain("unattended");
  });

  test("all runs strip OpenCode's native question tool in favor of the Open Session card", () => {
    expect(opencodeRunPolicy({ journalKind: "prompt" }).disables.question).toBe(false);
    expect(opencodeRunPolicy({ journalKind: "automation" }).disables.question).toBe(false);
  });

  test("engine-outside-sandbox runs strip every host-local workspace tool", () => {
    const p = opencodeRunPolicy({
      journalKind: "prompt",
      disableLocalWorkspaceTools: true,
    });
    for (const name of [
      "bash",
      "read",
      "write",
      "edit",
      "patch",
      "apply_patch",
      "grep",
      "glob",
    ]) {
      expect(p.disables[name]).toBe(false);
    }
    expect(p.unattended).toBe(false);
  });

  test("every automation-denied tool is stripped under opencode's <server>_<tool> naming", () => {
    const p = opencodeRunPolicy({
      journalKind: "automation",
      deniedTools: DENIED,
      confirmTools: STRIPE_CONFIRM_TOOLS,
    });
    for (const name of Object.keys(DENIED)) {
      const m = name.match(/^mcp__(.+?)__(.+)$/)!;
      expect(p.disables[`${m[1]}_${m[2]}`]).toBe(false);
    }
    // Spot-check the exact ids CLAUDE.md's least-privilege spec calls out.
    expect(p.disables["plain_reply_to_thread"]).toBe(false);
    expect(p.disables["plain_mark_thread_done"]).toBe(false);
    expect(p.disables["plain_snooze_thread"]).toBe(false);
    expect(p.disables["workos_delete_user"]).toBe(false);
    expect(p.disables["workos_get_impersonation_url"]).toBe(false);
    expect(p.disables["workos_revoke_session"]).toBe(false);
  });

  test("incident.io: an automation may declare, but not mutate anything else", () => {
    const p = opencodeRunPolicy({
      journalKind: "automation",
      deniedTools: DENIED,
      confirmTools: STRIPE_CONFIRM_TOOLS,
    });
    // Declaring is the point of the grant: it lands in triage with no
    // severity, so a human still accepts it.
    expect(p.disables["incident_incident_create"]).toBeUndefined();
    // Reads stay available for deduping against open incidents.
    expect(p.disables["incident_incident_list"]).toBeUndefined();
    expect(p.disables["incident_incident_show"]).toBeUndefined();
    // Everything that changes response state is stripped.
    expect(p.disables["incident_incident_update"]).toBe(false);
    expect(p.disables["incident_escalation_respond"]).toBe(false);
    expect(p.disables["incident_follow_up_create"]).toBe(false);
    expect(p.disables["incident_alert_attach"]).toBe(false);
    expect(p.disables["incident_extension_plugin_update"]).toBe(false);
  });

  test("Stripe money-movers fold into the deny-set (post-in-note), incl. stripe_api_write", () => {
    const p = opencodeRunPolicy({
      journalKind: "automation",
      deniedTools: DENIED,
      confirmTools: STRIPE_CONFIRM_TOOLS,
    });
    expect(p.disables["stripe_create_refund"]).toBe(false);
    expect(p.disables["stripe_cancel_subscription"]).toBe(false);
    expect(p.disables["stripe_update_subscription"]).toBe(false);
    expect(p.disables["stripe_stripe_api_execute"]).toBe(false);
    expect(p.disables["stripe_stripe_api_write"]).toBe(false);
    // Naming-drift guards — money-movers only.
    expect(p.disables["*_create_refund"]).toBe(false);
    expect(p.disables["create_refund"]).toBe(false);
    // Server-scoped denies must NOT wildcard-strip same-named tools of OTHER
    // servers: the Plain reply_to_thread deny used to remove
    // slack_reply_to_thread from every automation run (2026-07-26).
    expect(p.disables["*_reply_to_thread"]).toBeUndefined();
    expect(p.disables["reply_to_thread"]).toBeUndefined();
    expect(p.disables["plain_reply_to_thread"]).toBe(false);
    // The instructions carry the confirm_unattended-style guidance.
    const stripeNote = p.noteGroups.find((g) =>
      g.tools.includes("mcp__stripe__create_refund")
    )!;
    expect(stripeNote.message).toContain("unattended");
    expect(stripeNote.message).toContain("internal note");
    expect(stripeNote.message).toContain("human");
  });

  test("denied-tool messages survive into the note groups", () => {
    const p = opencodeRunPolicy({ journalKind: "automation", deniedTools: DENIED });
    const plainNote = p.noteGroups.find((g) => g.tools.includes("mcp__plain__reply_to_thread"))!;
    expect(plainNote.message).toContain("read-only");
    const workosNote = p.noteGroups.find((g) => g.tools.includes("mcp__workos__delete_user"))!;
    expect(workosNote.message).toContain("read-only");
  });

  test("deniedTools message wins over the confirm label for the same tool", () => {
    const p = opencodeRunPolicy({
      journalKind: "automation",
      deniedTools: { mcp__stripe__create_refund: "hard denied" },
      confirmTools: { mcp__stripe__create_refund: "Create a refund" },
    });
    expect(p.noteGroups[0].message).toBe("hard denied");
  });
});

describe("automation runs and per-user MCP servers (fail closed)", () => {
  // Automation runs pass no `user`, so any allowedUsers-restricted server in
  // the live mcp-config.json must be invisible to them — untrusted ticket
  // text can never reach a user-scoped server (e.g. brex), even when the
  // automation's own allowlist names it. Runs against the live mcp-config.json
  // (brex is the restricted server as of 2026-07-09); with no restricted server
  // configured the loop is empty and only the metadata-strip assertion bites.
  test("allowedUsers-restricted servers are hidden from user-less runs", () => {
    const unrestricted = filterMcpServers("all", undefined);
    let mcpConfig: any = {};
    try {
      mcpConfig = JSON.parse(
        require("fs").readFileSync(
          `${process.env.HOME}/projects/opensession/mcp-config.json`,
          "utf-8"
        )
      ).mcpServers;
    } catch {}
    const restricted = Object.entries(mcpConfig || {}).filter(
      ([, cfg]: [string, any]) => Array.isArray(cfg?.allowedUsers) && cfg.allowedUsers.length
    );
    for (const [name] of restricted) {
      expect(unrestricted[name]).toBeUndefined();
      // Even an explicit allowlist naming it (automation mcpServers) can't
      // surface it without a cleared user.
      expect(filterMcpServers([name], undefined)[name]).toBeUndefined();
    }
    // The metadata never reaches the SDK config.
    for (const cfg of Object.values(unrestricted)) {
      expect((cfg as any).allowedUsers).toBeUndefined();
    }
  });
});

describe("opencodeDeniedToolIds", () => {
  test("mcp names map to the exact server-scoped id by default", () => {
    expect(opencodeDeniedToolIds("mcp__plain__reply_to_thread")).toEqual([
      "plain_reply_to_thread",
    ]);
  });
  test("broad (money-mover) names add the wildcard and bare drift-guards", () => {
    expect(opencodeDeniedToolIds("mcp__stripe__create_refund", { broad: true })).toEqual([
      "stripe_create_refund",
      "*_create_refund",
      "create_refund",
    ]);
  });
  test("non-mcp names pass through verbatim", () => {
    expect(opencodeDeniedToolIds("Bash")).toEqual(["Bash"]);
  });
});

describe("opencodeAutomationModel (automations dispatch on opencode)", () => {
  // The live ~/.opensession-opencode.json has the bridge enabled; these
  // assertions describe the bridged mapping (the fail-safe path is exercised
  // only when the bridge is off, which would flip claude tiers to passthrough).
  test("tier-preserving mapping", () => {
    expect(opencodeAutomationModel("claude-sonnet-4-6")).toBe(
      "opencode/anthropic/claude-sonnet-4-6"
    );
    expect(opencodeAutomationModel("claude-fable-5")).toBe("opencode/anthropic/claude-fable-5");
    expect(opencodeAutomationModel("gpt-5.5")).toBe("opencode/openai/gpt-5.5");
  });
  test("unset model gets the automation default", () => {
    expect(opencodeAutomationModel(undefined)).toBe(DEFAULT_OPENCODE_AUTOMATION_MODEL);
    expect(opencodeAutomationModel("")).toBe(DEFAULT_OPENCODE_AUTOMATION_MODEL);
  });
  test("already-opencode ids and unknown shapes pass through", () => {
    expect(opencodeAutomationModel("opencode/anthropic/claude-haiku-4-5")).toBe(
      "opencode/anthropic/claude-haiku-4-5"
    );
    expect(opencodeAutomationModel("codex-mini")).toBe("codex-mini");
  });
  test("pi ids name their engine — pass through untouched", () => {
    expect(opencodeAutomationModel("pi/anthropic/claude-sonnet-5")).toBe(
      "pi/anthropic/claude-sonnet-5"
    );
    expect(opencodeAutomationModel("pi/openai/gpt-5.5-codex")).toBe("pi/openai/gpt-5.5-codex");
  });
});

describe("proxyOpencodeMcpConfigs", () => {
  test("builds stdio proxy entries with token env", () => {
    const out = proxyOpencodeMcpConfigs({ "michael-sessions": {}, "michael-ask": {} }, "tok-1");
    expect(Object.keys(out).sort()).toEqual(["michael-ask", "michael-sessions"]);
    const entry = out["michael-sessions"] as any;
    expect(entry.type).toBe("local");
    expect(entry.command[0]).toContain("bun");
    expect(entry.environment.OPENSESSION_RPC_TOKEN).toBe("tok-1");
    expect(entry.environment.OPENSESSION_MCP_SERVER).toBe("michael-sessions");
    expect(entry.environment.OPENSESSION_MCP_CATALOG).toBe("michael-ask,michael-sessions");
  });
  test("empty without token or servers (fail closed)", () => {
    expect(proxyOpencodeMcpConfigs({ "michael-admin": {} }, undefined)).toEqual({});
    expect(proxyOpencodeMcpConfigs(undefined, "tok")).toEqual({});
  });
});

describe("remoteOpencodeMcpConfigs", () => {
  test("builds loopback streamable-HTTP entries with bearer header", () => {
    const out = remoteOpencodeMcpConfigs({ "opensession-sessions": {}, "opensession-ask": {} }, "tok-2");
    expect(Object.keys(out).sort()).toEqual(["opensession-ask", "opensession-sessions"]);
    const entry = out["opensession-sessions"] as any;
    expect(entry.type).toBe("remote");
    expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/opensession-sessions$/);
    expect(entry.headers.authorization).toBe("Bearer tok-2");
    expect(entry.oauth).toBe(false);
  });
  test("empty without token or servers (fail closed)", () => {
    expect(remoteOpencodeMcpConfigs({ "opensession-admin": {} }, undefined)).toEqual({});
    expect(remoteOpencodeMcpConfigs(undefined, "tok")).toEqual({});
  });
  test("chooser falls back to stdio proxies when the HTTP listener is not bound", () => {
    // Under bun test the listener never binds (startMcpHttpServer no-ops), so
    // the chooser must produce the stdio shape — the same fallback a failed
    // port bind takes in production.
    const out = inProcessOpencodeMcpConfigs({ "opensession-ask": {} }, "tok-3") as any;
    expect(out["opensession-ask"].type).toBe("local");
  });
});

describe("reconnectSharedInProcessMcp", () => {
  test("reconnects failed or newly-added proxies and leaves connected ones alone", async () => {
    const connected: string[] = [];
    const client = {
      mcp: {
        status: async () => ({
          data: {
            "opensession-sessions": { status: "connected" },
            "opensession-todos": { status: "failed", error: "Failed to get tools" },
          },
        }),
        connect: async ({ path }: { path: { name: string } }) => {
          connected.push(path.name);
          return { data: true };
        },
      },
    };

    const failed = await reconnectSharedInProcessMcp(
      client as any,
      ["opensession-sessions", "opensession-todos", "opensession-assets"],
      { query: { directory: "/tmp/worktree" } }
    );

    expect(connected).toEqual(["opensession-todos", "opensession-assets"]);
    expect(failed).toEqual([]);
  });

  test("reports proxies OpenCode could not reconnect", async () => {
    const client = {
      mcp: {
        status: async () => ({ data: { "opensession-todos": { status: "failed" } } }),
        connect: async () => ({ error: { message: "no tools" } }),
      },
    };

    expect(
      await reconnectSharedInProcessMcp(client as any, ["opensession-todos"])
    ).toEqual(["opensession-todos"]);
  });

  test("fails soft when MCP status never settles", async () => {
    let signal: AbortSignal | undefined;
    const client = {
      mcp: {
        status: (options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise(() => {});
        },
        connect: async () => ({ data: true }),
      },
    };

    expect(
      await reconnectSharedInProcessMcp(
        client as any,
        ["opensession-todos", "opensession-assets"],
        {},
        { timeoutMs: 5 }
      )
    ).toEqual(["opensession-todos", "opensession-assets"]);
    expect(signal?.aborted).toBe(true);
  });

  test("fails soft when an MCP reconnect never settles", async () => {
    let signal: AbortSignal | undefined;
    const client = {
      mcp: {
        status: async () => ({ data: { "opensession-todos": { status: "failed" } } }),
        connect: (options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise(() => {});
        },
      },
    };

    expect(
      await reconnectSharedInProcessMcp(
        client as any,
        ["opensession-todos"],
        {},
        { timeoutMs: 5 }
      )
    ).toEqual(["opensession-todos"]);
    expect(signal?.aborted).toBe(true);
  });
});

describe("buildRunInstructions", () => {
  test("every run forbids interactive AWS login and human device-code asks", () => {
    for (const isAsk of [true, false]) {
      const s = buildRunInstructions({ isAsk });
      expect(s).toContain("## AWS access is non-interactive");
      expect(s).toContain("NEVER run `aws login` or `aws sso login`");
      expect(s).toContain("NEVER ask a human to authorize AWS");
      expect(s).toContain("without setting `AWS_PROFILE` or passing `--profile`");
    }
  });
  // The public-repo confirmation PROMPT was removed in aa4009d5: enforcement
  // moved to credential scope (tellahq-only PAT + GitHub App user tokens —
  // GitHub 403s any outside write server-side), which prompt wording can't
  // strengthen and doesn't need. The data-handling instruction below remains
  // prompt-level because no credential boundary can enforce it.
  test("every run forbids uploads to public file hosts", () => {
    for (const isAsk of [true, false]) {
      const s = buildRunInstructions({ isAsk });
      expect(s).toContain("never upload to public hosts");
      expect(s).toContain("stop and report the failure");
    }
  });
  test("every run learns the UI renders mermaid fences as diagrams", () => {
    for (const isAsk of [true, false]) {
      const s = buildRunInstructions({ isAsk });
      expect(s).toContain("## Session UI rendering");
      expect(s).toContain("```mermaid fenced code blocks render as actual diagrams");
    }
  });
  test("every run is asked to qualify PR references with the repo id", () => {
    for (const isAsk of [true, false]) {
      const s = buildRunInstructions({ isAsk });
      expect(s).toContain("Write pull request references qualified with the repo id");
      expect(s).toContain("rather than a bare `#92`");
    }
  });
  test("every run forbids unbounded browser services", () => {
    for (const isAsk of [true, false]) {
      const s = buildRunInstructions({ isAsk });
      expect(s).toContain("## Browser processes must be bounded");
      expect(s).toContain("Never launch Chrome/Chromium or Xvfb directly");
      expect(s).toContain("bun scripts/cdp-browser.ts start");
      expect(s).toContain("Never reuse another session's CDP port or browser profile");
    }
  });
  test("every run knows the private-key-backed GitHub checks command", () => {
    for (const isAsk of [true, false]) {
      const s = buildRunInstructions({ isAsk });
      expect(s).toContain("## GitHub checks authentication");
      expect(s).toContain("scripts/gh-checks.ts <pr-number>");
      expect(s).toContain("short-lived, read-only installation token");
    }
  });
  test("a configured PR reviewer becomes a --reviewer instruction", () => {
    const s = buildRunInstructions({
      isAsk: false,
      osSessionId: "os-1",
      prReviewer: "tellahq/super-developers",
    });
    expect(s).toContain("## PR reviewer");
    expect(s).toContain("--reviewer tellahq/super-developers");
    expect(s).toContain("--add-reviewer tellahq/super-developers");
    // A rejected reviewer must not cost the PR itself.
    expect(s).toContain("never drop the PR over it");
  });
  // A user asking for "a new session" means a detached session in their own
  // sidebar, not an in-process subagent that dies with this run.
  test("a user asking for a new session gets create_session, not a subagent", () => {
    const s = buildRunInstructions({
      isAsk: false,
      inProcessMcp: { "opensession-sessions": {} },
    });
    expect(s).toContain('When the USER asks for "a new session"');
    expect(s).toContain("Use `create_session` for that");
    expect(s).toContain("Never satisfy that request with an in-process");
    expect(s).toContain("When it is ambiguous, create the session");
  });
  test("runs without the sessions server are told nothing about create_session", () => {
    const s = buildRunInstructions({ isAsk: false });
    expect(s).not.toContain('When the USER asks for "a new session"');
  });
  test("no reviewer configured leaves the PR section alone", () => {
    const s = buildRunInstructions({ isAsk: false, osSessionId: "os-1" });
    expect(s).toContain("## PR attribution");
    expect(s).not.toContain("## PR reviewer");
  });
  test("the reviewer instruction is GitHub-only — code.storage has no PRs", () => {
    const s = buildRunInstructions({
      isAsk: false,
      osSessionId: "os-1",
      repoHost: "codestorage",
      prReviewer: "tellahq/super-developers",
    });
    expect(s).toContain("a pushed branch IS the change request");
    expect(s).not.toContain("## PR reviewer");
  });
  test("visual walkthroughs require an after screenshot and shipped-change copy", () => {
    const s = buildRunInstructions({
      isAsk: false,
      inProcessMcp: { "opensession-walkthrough": {} },
    });
    expect(s).toContain("a static visual change needs at least one after screenshot");
    expect(s).toContain("Retina or device-native resolution");
    expect(s).toContain("`bun scripts/capture-ui.ts`");
    expect(s).toContain("why it matters");
    expect(s).toContain("deliberate Share to Slack action");
  });
  // Native changes shipped without walkthroughs while web changes got them:
  // the instruction named only the web capture script, so an os1-ios run faced
  // an undocumented Mac-node chain and skipping looked reasonable every time.
  test("the walkthrough instruction names the native capture script too", () => {
    const s = buildRunInstructions({
      isAsk: false,
      inProcessMcp: { "opensession-walkthrough": {} },
    });
    expect(s).toContain("`bun scripts/capture-ios.ts`");
    expect(s).toContain("os1-ios/");
    expect(s).toContain("--platform mac");
    expect(s).toContain("deliberate Share to Slack action");
  });
  // Kent kept waiting for walkthroughs on design work that never came: the old
  // copy read as a judgement call and demanded a screen-recording, which is
  // absurd for a spacing fix, so runs skipped publishing entirely.
  test("a small visual change is explicitly not a reason to skip the walkthrough", () => {
    const s = buildRunInstructions({
      isAsk: false,
      inProcessMcp: { "opensession-walkthrough": {} },
    });
    expect(s).toContain("Treat that as the default rather than a judgement call");
    expect(s).toContain("being small is not a reason to skip");
    expect(s).not.toContain("trivial tweaks");
  });
  test("ask and scratch runs never get a reviewer instruction", () => {
    for (const input of [
      { isAsk: true, osSessionId: "os-1", prReviewer: "kentdebruin" },
      { isAsk: false, isScratch: true, osSessionId: "os-1", prReviewer: "kentdebruin" },
    ]) {
      expect(buildRunInstructions(input)).not.toContain("## PR reviewer");
    }
  });
  test("shared-pool runs are told their real cwd; per-session runs aren't", () => {
    const shared = buildRunInstructions({
      isAsk: false,
      cwd: "/home/ubuntu/projects/opensession",
    });
    expect(shared).toContain("## Working directory");
    expect(shared).toContain("`/home/ubuntu/projects/opensession` — you are already there");
    expect(shared).toContain("cd /home/ubuntu/projects/opensession &&");
    expect(buildRunInstructions({ isAsk: false })).not.toContain("## Working directory");
  });
  test("a pre-rename checkout path is named by the path that exists today", () => {
    // Sessions persisted before a checkout rename store the old path, which
    // survives as a symlink. Naming it here would have the model narrate the
    // pre-rename name back in every command, so the text resolves it.
    const root = mkdtempSync(join(tmpdir(), "opensession-cwd-test-"));
    const real = join(root, "opensession");
    const legacy = join(root, "tella-backstage");
    mkdirSync(real);
    symlinkSync("opensession", legacy);
    const s = buildRunInstructions({ isAsk: false, cwd: legacy });
    expect(s).toContain(`\`${real}\` — you are already there`);
    expect(s).not.toContain("tella-backstage");
    rmSync(root, { recursive: true, force: true });
  });
  test("an unresolvable cwd is left exactly as given", () => {
    const missing = join(tmpdir(), "opensession-cwd-missing-does-not-exist");
    expect(buildRunInstructions({ isAsk: false, cwd: missing })).toContain(
      `\`${missing}\` — you are already there`
    );
  });
  test("ask mode gets the read-only guardrail", () => {
    const s = buildRunInstructions({ isAsk: true });
    expect(s).toContain("READ-ONLY with respect to the checkout and shell");
    expect(s).toContain("does not prohibit intentional changes");
    expect(s).toContain("todos");
  });
  test("the Desk note permits product-scoped writes", () => {
    expect(DESK_NOTE).toContain("those refusals are outdated");
    expect(DESK_NOTE).toContain("use the requested Desk tool directly");
  });
  test("code mode gets the session link; confirm-tool notes ride deniedToolNotes", () => {
    const s = buildRunInstructions({
      isAsk: false,
      osSessionId: "abc-123",
      deniedToolNotes: opencodeRunPolicy({
        journalKind: "prompt",
        confirmTools: STRIPE_CONFIRM_TOOLS,
      }).noteGroups,
    });
    expect(s).toContain("/session/abc-123");
    expect(s).toContain("Created by [this");
    expect(s).toContain("mcp__stripe__create_refund");
    expect(s).toContain("human approval");
  });
  test("a resolved requester gets named + assigned in the PR instruction", () => {
    const s = buildRunInstructions({
      isAsk: false,
      osSessionId: "abc-123",
      user: "alex",
      author: { name: "Alex Rivera", email: "alice@example.com" },
    });
    expect(s).toContain("Started by Alex Rivera in [this");
    expect(s).toContain("--assignee happylinks");
    expect(s).not.toContain("Created by [this");
  });
  test("an unresolved user keeps the generic footer", () => {
    const s = buildRunInstructions({
      isAsk: false,
      osSessionId: "abc-123",
      user: "Anonymous",
      author: null,
    });
    expect(s).toContain("Created by [this");
    expect(s).not.toContain("--assignee");
  });
  test("unattended deny-set renders as a run-policy section", () => {
    const s = buildRunInstructions({
      isAsk: true,
      deniedToolNotes: opencodeRunPolicy({
        journalKind: "automation",
        deniedTools: automationDeniedTools(),
        confirmTools: STRIPE_CONFIRM_TOOLS,
      }).noteGroups,
    });
    expect(s).toContain("Run policy (least-privilege)");
    expect(s).toContain("mcp__stripe__create_refund");
    expect(s).toContain("mcp__plain__reply_to_thread");
    expect(s).toContain("mcp__workos__get_impersonation_url");
    expect(s).toContain("internal note");
  });
  test("dial runs get the oracle block; everyone else never hears of it", () => {
    const s = buildRunInstructions({
      isAsk: false,
      dialOracle: {
        agent: "oracle-fable",
        presetLabel: "Dial · High",
        mainLabel: "GPT-5.6 Sol",
        oracleLabel: "Claude Fable 5",
      },
    });
    expect(s).toContain("The Dial — your oracle");
    expect(s).toContain("`oracle-fable` subagent");
    expect(s).toContain('"Dial · High" preset');
    expect(s).toContain("advisory");
    expect(buildRunInstructions({ isAsk: false })).not.toContain("oracle");
  });
});

describe("anthropic-bridge message flattening", () => {
  test("tool_results unwrap to raw output", () => {
    expect(
      flattenMessageText([
        { type: "tool_result", tool_use_id: "t1", content: "exit 0" },
        { type: "text", text: "and a note" },
      ])
    ).toBe("exit 0\nand a note");
  });
  test("replay labels prior assistant turns", () => {
    const replay = replayConversation([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "42" }] },
    ]);
    expect(replay).toContain("hi");
    expect(replay).toContain("[Your previous reply]\nhello");
    expect(replay.endsWith("42")).toBe(true);
  });
});

describe("anthropic-bridge rate limiting", () => {
  test("admits under the ceiling, rejects past it, tracks tokens", () => {
    const account = `test-acct-${crypto.randomUUID()}`;
    const limit = bridgeMaxRequestsPerHour();
    const t0 = Date.now();
    for (let i = 0; i < limit; i++) {
      expect(admitBridgeRequest(account, 100, t0 + i).allowed).toBe(true);
    }
    const rejected = admitBridgeRequest(account, 100, t0 + limit);
    expect(rejected.allowed).toBe(false);
    expect(rejected.requests).toBe(limit);
    expect(rejected.tokens).toBe(limit * 100);
    expect(rejected.limit).toBe(limit);
  });
  test("window is rolling: old requests age out after an hour", () => {
    const account = `test-acct-${crypto.randomUUID()}`;
    const limit = bridgeMaxRequestsPerHour();
    const t0 = Date.now();
    for (let i = 0; i < limit; i++) admitBridgeRequest(account, 10, t0);
    expect(admitBridgeRequest(account, 10, t0 + 1).allowed).toBe(false);
    expect(admitBridgeRequest(account, 10, t0 + 60 * 60 * 1000 + 1).allowed).toBe(true);
  });
  test("accounts are limited independently", () => {
    const a = `test-acct-${crypto.randomUUID()}`;
    const b = `test-acct-${crypto.randomUUID()}`;
    const limit = bridgeMaxRequestsPerHour();
    const t0 = Date.now();
    for (let i = 0; i < limit; i++) admitBridgeRequest(a, 1, t0);
    expect(admitBridgeRequest(a, 1, t0 + 1).allowed).toBe(false);
    expect(admitBridgeRequest(b, 1, t0 + 1).allowed).toBe(true);
  });
});

describe("normalizeOpencodeConfig (bridge.mode / accounts)", () => {
  test("enabled with no bridge block defaults to meridian, no account restriction", () => {
    const cfg = normalizeOpencodeConfig({ enabled: true })!;
    expect(cfg.bridgeMode).toBe("meridian");
    expect(cfg.bridgeAccountIds).toBeUndefined();
  });
  test("disabled or missing enabled is always off, regardless of bridge.mode", () => {
    expect(normalizeOpencodeConfig({ enabled: false, bridge: { mode: "meridian" } })!.bridgeMode).toBe("off");
    expect(normalizeOpencodeConfig({ bridge: { mode: "native" } })!.bridgeMode).toBe("off");
  });
  test("explicit native and off modes are honored", () => {
    expect(normalizeOpencodeConfig({ enabled: true, bridge: { mode: "native" } })!.bridgeMode).toBe("native");
    expect(normalizeOpencodeConfig({ enabled: true, bridge: { mode: "off" } })!.bridgeMode).toBe("off");
  });
  test("unknown mode falls back to the meridian default", () => {
    expect(normalizeOpencodeConfig({ enabled: true, bridge: { mode: "banana" } })!.bridgeMode).toBe("meridian");
  });
  test("bridge.accounts wins; legacy bridgeAccountIds folds in when absent", () => {
    expect(
      normalizeOpencodeConfig({ enabled: true, bridge: { accounts: ["a"] }, bridgeAccountIds: ["b"] })!
        .bridgeAccountIds
    ).toEqual(["a"]);
    expect(
      normalizeOpencodeConfig({ enabled: true, bridgeAccountIds: ["b", ""] })!.bridgeAccountIds
    ).toEqual(["b"]);
  });
  test("malformed shapes are rejected or sanitized", () => {
    expect(normalizeOpencodeConfig(null)).toBeNull();
    expect(normalizeOpencodeConfig("x")).toBeNull();
    expect(normalizeOpencodeConfig([])).toBeNull();
    const cfg = normalizeOpencodeConfig({ enabled: true, bridge: { accounts: "not-array" } })!;
    expect(cfg.bridgeAccountIds).toBeUndefined();
  });
});

describe("opencode config defaults", () => {
  test("turn timeout and bridge request ceiling have sane defaults", () => {
    // Reads the live config file when present; both knobs must be positive and
    // default to the documented values when unset.
    expect(opencodeTurnTimeoutMs()).toBeGreaterThan(0);
    expect(DEFAULT_TURN_TIMEOUT_MINUTES).toBe(60);
    expect(bridgeMaxRequestsPerHour()).toBeGreaterThan(0);
    expect(DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR).toBe(300);
  });
});

describe("anthropic-bridge jsonSchemaToZodShape", () => {
  test("required vs optional and basic types", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        cmd: { type: "string", description: "shell command" },
        timeout: { type: "number" },
        flags: { type: "array", items: { type: "string" } },
      },
      required: ["cmd"],
    });
    expect(shape.cmd.safeParse("ls").success).toBe(true);
    expect(shape.cmd.safeParse(undefined).success).toBe(false);
    expect(shape.timeout.safeParse(undefined).success).toBe(true);
    expect(shape.flags.safeParse(["-a"]).success).toBe(true);
    expect(shape.flags.safeParse([1]).success).toBe(false);
  });
  test("degrades unknown constructs to permissive", () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape({ type: "string" })).toEqual({});
  });
});

// ── Per-turn usage accounting ──
//
// opencode emits one assistant message per model request, so a turn that calls
// tools is many messages. Reading only the last one under-reported cost 6.6x
// and tokens 7.8x across the whole message store before this was fixed.
describe("turn usage sums every step", () => {
  const step = (input: number, output: number, read: number, write: number, cost: number) => ({
    info: { role: "assistant", tokens: { input, output, cache: { read, write } }, cost },
    parts: [],
  });
  const build = (list: any[]) => {
    const audited: Record<string, unknown>[] = [];
    const events = buildTurnResultEvents({
      info: list.filter((m) => m.info?.role === "assistant").at(-1)?.info,
      list,
      textOut: "done",
      ocSessionId: "ses_1",
      model: "claude-opus-5",
      providerID: "anthropic",
      turnEvent: (fields) => audited.push(fields),
    });
    const done = events.find((e) => e.type === "done") as any;
    return { audit: audited[0], usage: done?.usage };
  };

  test("tokens and cost accumulate across the turn's model requests", () => {
    const { audit, usage } = build([
      { info: { role: "user" }, parts: [] },
      step(100, 20, 1_000, 500, 0.5),
      step(200, 30, 2_000, 0, 0.75),
      step(5, 40, 3_000, 0, 1.0),
    ]);
    expect(usage.inputTokens).toBe(305);
    expect(usage.outputTokens).toBe(90);
    expect(usage.cacheReadTokens).toBe(6_000);
    expect(usage.cacheCreationTokens).toBe(500);
    expect(usage.costUsd).toBeCloseTo(2.25);
    expect(audit.input_tokens).toBe(305);
    expect(audit.total_cost_usd).toBeCloseTo(2.25);
    // Cache writes were never emitted at all before, so the audit's
    // cache-write column read zero while the priciest tokens went unrecorded.
    expect(audit.cache_creation_input_tokens).toBe(500);
    expect(audit.steps).toBe(3);
  });

  test("context stays the final step's prompt size, not a sum of them", () => {
    const { usage } = build([
      { info: { role: "user" }, parts: [] },
      step(100, 20, 90_000, 0, 0.5),
      step(5, 40, 95_000, 0, 0.75),
    ]);
    // Summing prompt sizes would claim a 185k context window from two
    // ordinary 95k steps.
    expect(usage.contextTokens).toBe(95_005);
    expect(usage.cacheReadTokens).toBe(185_000);
  });

  test("only the current turn counts, not the whole session", () => {
    const { usage } = build([
      { info: { role: "user" }, parts: [] },
      step(999, 999, 999, 0, 9),
      { info: { role: "user" }, parts: [] },
      step(10, 20, 30, 0, 1),
    ]);
    expect(usage.inputTokens).toBe(10);
    expect(usage.costUsd).toBeCloseTo(1);
  });

  test("a turn whose steps report no usage yields no usage", () => {
    const { usage } = build([
      { info: { role: "user" }, parts: [] },
      { info: { role: "assistant" }, parts: [] },
    ]);
    expect(usage).toBeUndefined();
  });
});
