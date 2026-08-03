/**
 * Ordered HTTP route handler chain. Handlers are grouped by domain; a handler
 * returns undefined to fall through. Order across modules is free because the
 * path families are disjoint — order WITHIN a family (e.g. /notes/search
 * before /notes/:id) is preserved inside its module. The WebSocket upgrade,
 * run-ws upgrades, SPA fallback and 404 stay in opensession.ts's fetch tail.
 */

import type { RouteHandler } from "./context";
import {
	proxyCloudFrontendRequest,
	proxyCloudSessionRequest,
	proxyCloudTargetRequest,
} from "../cloud-proxy";
import { handleSessionTransferRoutes } from "./session-transfer";
import { handleAuthRoutes } from "./auth";
import { handleMediaRoutes } from "./media";
import { handleStaticAssetsRoutes } from "./static-assets";
import { handlePlainRoutes } from "./plain";
import { handleFeedsRoutes } from "./feeds";
import { handleSlackChannelRoutes } from "./slack-channels";
import { handleSystemRoutes } from "./system";
import { handleSessionAssetsRoutes } from "./session-assets";
import { handleSessionsRoutes } from "./sessions";
import { handlePrRoutes } from "./pr";
import { handleSessionGitRoutes } from "./session-git";
import { handlePreviewRoutes } from "./preview";
import { handleWorkspaceRoutes } from "./workspace";
import { handleLocalReposRoutes } from "./local-repos";
import { handleAutomationsRoutes } from "./automations";
import { handleHumanAsksRoutes } from "./human-asks";
import { handleKeychainRoutes } from "./keychain";
import { handleDeployRoutes } from "./deploys";
import { handleChatRoutes } from "./chat";
import { handlePeopleRoutes } from "./people";
import { handlePrefsRoutes } from "./prefs";
import { handleSecurityRoutes } from "./security";
import { handleGoalsRoutes } from "./goals";
import { handleActionsRoutes } from "./actions";
import { handleConnectionsRoutes } from "./connections";
import { handleAccountsRoutes } from "./accounts";
import { handleModelsRoutes } from "./models";
import { handleNodesRoutes } from "./nodes";
import { handleNotesRoutes } from "./notes";
import { handlePapercutsRoutes } from "./papercuts";
import { handleTodosRoutes } from "./todos";
import { handleWorkflowsRoutes } from "./workflows";
import { handleReportsRoutes } from "./reports";
import { handleAnalyticsRoutes } from "./analytics";
import { handleSearchRoutes } from "./search";
import { handleOs1UpdateRoutes } from "./os1-update";

export type { RouteContext, RouteHandler } from "./context";

export const routeHandlers: RouteHandler[] = [
	// First: the sign-in endpoints are exempt from the auth gate (which runs
	// before dispatch in opensession.ts) and must never be shadowed.
	handleAuthRoutes,
	handleMediaRoutes,
	// Local profile only: serve the current hosted shell and assets from the
	// loopback origin. API and WebSocket paths are excluded by the handler.
	proxyCloudFrontendRequest,
	handleStaticAssetsRoutes,
	handlePlainRoutes,
	handleFeedsRoutes,
	handleSlackChannelRoutes,
	handleSystemRoutes,
	handleOs1UpdateRoutes,
	handleSessionTransferRoutes,
	// Local profile only: the cloud-target New Session palette reads the hosted
	// model catalog and account pools instead of the reduced local equivalents.
	proxyCloudTargetRequest,
	// Local profile only: local ids fall through; every other session id is
	// forwarded before a local route can turn the ownership miss into a 404.
	proxyCloudSessionRequest,
	// Before the generic session routes: /api/sessions/:id/assets* is inside
	// their path family and must not be swallowed by broader matches.
	handleSessionAssetsRoutes,
	handleSessionsRoutes,
	handlePrRoutes,
	handleSessionGitRoutes,
	handlePreviewRoutes,
	handleLocalReposRoutes,
	handleWorkspaceRoutes,
	handleAutomationsRoutes,
	handleHumanAsksRoutes,
	handleKeychainRoutes,
	handleDeployRoutes,
	handleChatRoutes,
	handlePeopleRoutes,
	handlePrefsRoutes,
	handleSecurityRoutes,
	handleGoalsRoutes,
	handleActionsRoutes,
	handleConnectionsRoutes,
	handleAccountsRoutes,
	handleModelsRoutes,
	handleNodesRoutes,
	handleNotesRoutes,
	handlePapercutsRoutes,
	handleTodosRoutes,
	handleWorkflowsRoutes,
	handleReportsRoutes,
	handleAnalyticsRoutes,
	handleSearchRoutes,
];
