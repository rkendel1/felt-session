# Mission Control Project Control Plane - Implementation Guide

## Overview

The Mission Control Project Control Plane implementation establishes FeltDB as the sole persistence layer and introduces hierarchical durable entities: Projects, Repositories, Worktrees, Agents, and Tasks. This document guides the implementation of PRs 2-7.

## Architecture

```
                    Slack (human interface)
                              │
                         Mission Control
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
        ▼                     ▼                      ▼
    FeltDB          Local Worktrees            GitHub API
   (durable          (execution)              (external)
    state)           agents                   agent
```

## PR 2: Project and Repository Control Plane ✅ COMPLETE

### Entities

**Project** - Root organizational unit
- Fields: id, name, slug, repository config, local config, slack config, status
- Scopes: All other entities are scoped to a project
- Lifecycle: Creation, archiving, deletion with cascading cleanup

**Repository** - VCS representation per project
- Fields: id, projectId, name, provider, owner, repo, status, sync state
- Operations: CRUD, sync tracking, error recording
- Relationships: One repository per project (initially, can be extended)

### Implementation Files

- `mission-control-project.ts` - Type definitions
- `mission-control-repository.ts` - Type definitions
- `durable-project-registry.ts` - FeltDB-backed registry with interface
- `durable-repository-registry.ts` - FeltDB-backed registry with interface
- `project-initializer.ts` - Service for project lifecycle
- `mission-control-project.test.ts` - 21 comprehensive tests

### Key Patterns

1. **Registry Pattern**: Each durable entity type has a registry that:
   - Implements typed interface (e.g., `DurableProjectRegistry`)
   - Defines `StoredRow` type for FeltDB serialization (JSON strings for arrays)
   - Opens FeltDB with unique namespace
   - Returns interface implementing all CRUD operations

2. **Service Pattern**: `ProjectInitializer` provides higher-level operations:
   - Caches registry instances for efficient access
   - Handles repository URL parsing
   - Manages cascading deletes

3. **Concurrency**: Each registry instance holds its own FeltDB connection
   - All operations use transactions
   - Multiple initializers can safely operate on same disk data
   - Shared-memory caching via singleton pattern recommended for production

### API

```typescript
const initializer = createProjectInitializer(dataDir);

// Create project with associated repository
const project = await initializer.createProject({
  name: "My Project",
  slug: "my-project",
  repositoryUrl: "https://github.com/owner/repo.git",
  localRootPath: "/home/user/projects/repo",
  workspaceId: "W123",
  generalChannelId: "C123",
});

// Query operations
const projects = await initializer.listProjects();
const project = await initializer.getProject(projectId);
const project = await initializer.getProjectBySlug(slug);

// Repository operations
const repos = await initializer.getRepositoriesForProject(projectId);
await initializer.recordRepositorySync(repoId);
await initializer.recordRepositorySyncError(repoId, error);

// Cleanup
await initializer.deleteProject(projectId); // Cascades to repositories
```

### FeltDB Collections

- `mission_control_projects` - Stores MissionControlProject records
- `mission_control_repositories` - Stores MissionControlRepository records

### Status

✅ Complete with 21 passing tests
- Project CRUD operations
- Repository CRUD and sync tracking
- Workspace project initialization
- Cascading deletes
- Repository URL parsing (HTTPS and SSH formats)

---

## PR 3: Local Agent Execution and Durable Worktrees (NEXT)

### Overview

Introduces durable representation of local git worktrees and enables local agents to execute commands with full audit trail.

### Entities

**Worktree** - Durable git worktree representation
```typescript
interface MissionControlWorktree {
  id: string;
  projectId: string;
  repositoryId: string;
  path: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  agentId?: string;
  taskId?: string;
  status: "active" | "error" | "completed";
  createdAt: string;
  updatedAt: string;
}
```

**Agent Run** - Execution record for agent actions
```typescript
interface MissionControlAgentRun {
  id: string;
  projectId: string;
  agentId: string;
  taskId?: string;
  worktreeId?: string;
  command: string;
  status: "pending" | "running" | "succeeded" | "failed";
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Work Items

1. Create worktree types and interfaces
2. Create durable-worktree-registry.ts with FeltDB backing
3. Create durable-agent-run-registry.ts for execution history
4. Implement local git operations:
   - Clone repository
   - Create worktree
   - List files
   - Get file diffs
   - Record git state
5. Create agent executor that:
   - Manages worktree lifecycle
   - Records all commands and output
   - Tracks execution state
   - Enables rollback/cleanup
6. Implement filesystem observation:
   - File inventory tracking
   - Change detection
   - Diff computation
7. Write comprehensive tests
8. Document worktree lifecycle

### FeltDB Collections

- `mission_control_worktrees`
- `mission_control_agent_runs`
- `mission_control_file_inventory` (optional, for performance)

---

## PR 4: GitHub Agent (FOLLOWING PR 3)

### Overview

Enables @GitHub agent to understand and execute natural language commands against GitHub API.

### Entities

**GitHub Integration** - OAuth and API credentials
**Issue/PR/Commit Operations** - CRUD via GitHub API

### Work Items

1. Create GitHub integration types
2. Implement OAuth flow for repository authorization
3. Create GitHub API wrapper:
   - List/create/update/close issues
   - List/create/update/merge PRs
   - Post comments
   - Create commits
   - Manage branches
4. Implement natural language → API translation:
   - "@GitHub show my open PRs" → list PRs
   - "@GitHub merge this" → merge current PR
   - "@GitHub create a PR" → push branch and create PR
   - "@GitHub comment that tests passed" → add comment
5. Integrate with worktrees from PR 3
6. Error handling and retry logic
7. Write tests

### GitHub Collections

- `mission_control_github_integrations`
- `mission_control_github_oauth_tokens`

---

## PR 5: Slack Agent Addressing and Project Rooms

### Overview

Makes Slack the primary human interface with proper agent addressing and project-scoped channels.

### Entities

**Agent Identity** - Addressable agent
```typescript
interface AgentIdentity {
  id: string;
  handle: string; // @architect, @GitHub
  displayName: string;
  kind: "role" | "integration";
  role?: string;
  provider?: string;
  capabilities: string[];
  projectId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

**Slack Project Channel** - Per-repository coordination
```typescript
interface SlackProjectChannel {
  projectId: string;
  slackChannelId: string;
  channelName: string; // #project-myapp
  createdAt: string;
}
```

### Work Items

1. Create agent identity types
2. Create durable-agent-identity-registry.ts
3. Create durable-slack-project-channel-registry.ts
4. Implement Slack command parser:
   - Recognize @mentions
   - Extract intent and entities
   - Validate against agent capabilities
5. Implement agent autocomplete for Slack:
   - Populate agent list
   - Filter by project scope
   - Return rich completions
6. Implement command routing:
   - Parse "@GitHub merge this" → route to GitHub agent
   - Parse "@architect what's failing?" → route to architect
7. Create Slack message model linking to FeltDB (messages are ephemeral, decisions persist)
8. Error handling and fallbacks
9. Write tests

### Slack Collections

- `mission_control_agent_identities`
- `mission_control_slack_project_channels`
- `mission_control_slack_conversations` (links Slack → decisions)

---

## PR 6: Repository Intelligence Graph (FOLLOWING PR 5)

### Overview

Builds repository understanding for smarter agent decisions.

### Entities

**Repository File**
```typescript
interface RepositoryFile {
  id: string;
  repositoryId: string;
  path: string;
  language: string;
  symbols: string[]; // Functions, classes, exports
  imports: string[];
  exports: string[];
  lastModified: string;
  riskScore?: number; // 0-100, based on dependents
}
```

**File Relationship**
```typescript
interface FileRelationship {
  sourceFileId: string;
  targetFileId: string;
  type: "imports" | "depends_on" | "tested_by";
  createdAt: string;
}
```

### Work Items

1. Create file inventory types
2. Create durable-repository-file-registry.ts
3. Create durable-file-relationship-registry.ts
4. Implement file discovery:
   - Enumerate repository files
   - Extract language info (via language server or simple heuristics)
   - Parse imports/exports
5. Build relationship graph:
   - Map "who imports whom"
   - Calculate transitive dependencies
   - Identify risky files (many dependents)
6. Implement graph queries:
   - "What files does this task touch?"
   - "What code might break if we change this?"
   - "What's related to this issue?"
7. Incremental updates on repository sync
8. Visualization helpers
9. Write tests

### Graph Collections

- `mission_control_repository_files`
- `mission_control_file_relationships`
- `mission_control_risk_analysis` (cached computations)

---

## PR 7: Unified Agent Context and Autonomous Collaboration

### Overview

Enables autonomous multi-agent workflows with full causality tracking.

### Entities

**Durable Conversation**
```typescript
interface DurableConversation {
  id: string;
  projectId: string;
  participants: AgentIdentity[];
  topic: string;
  status: "active" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}
```

**Conversation Message** (links all interactions)
```typescript
interface ConversationMessage {
  id: string;
  conversationId: string;
  agentId: string;
  messageType: "command" | "response" | "observation" | "decision";
  content: string;
  context?: any; // File context, errors, etc.
  timestamp: string;
}
```

### Work Items

1. Create conversation types
2. Create durable-conversation-registry.ts
3. Implement agent context building:
   - Task history and criteria
   - Previous failed attempts and learnings
   - Related graph information
   - Current state from worktrees
4. Implement autonomous workflows:
   - @architect receives task → creates plan
   - @builder receives plan → executes changes
   - @reviewer reviews changes
   - @tester runs tests
   - @GitHub merges on approval
5. Implement decision logging:
   - Why each step was taken
   - What alternatives were considered
   - Metrics on agent performance
6. Implement rollback/retry logic
7. Write tests for common workflows

### Conversation Collections

- `mission_control_conversations`
- `mission_control_conversation_messages`
- `mission_control_decision_history`

---

## Integration with Existing Mission Control

The existing Mission Control code (durable-task-registry, durable-agent-registry) should be integrated as follows:

1. **Tasks** remain at current structure but add `projectId` field
2. **Agents** remain role-based but link to `AgentIdentity` (from PR 5)
3. **New relationship**: Task → Project → Repositories
4. **New relationship**: Agent → AgentIdentity → Capabilities

## Deployment Strategy

1. **PR 2**: Deploy to production (just persistence layer, no behavioral changes)
2. **PR 3**: Deploy to canary (local execution, monitor for issues)
3. **PR 4-5**: Deploy in parallel to canary (integrations)
4. **PR 6**: Deploy to canary (intelligence)
5. **PR 7**: Deploy to production when all autonomous workflows tested

## Testing Strategy

Each PR should include:
- Unit tests for registries and entities
- Integration tests for end-to-end workflows
- Test data fixtures
- Documentation of test patterns

Run: `bun test packages/core/opensession-server/src/runner-executor/`

## Monitoring and Observability

Each PR should add metrics for:
- Operation success rates
- Latency
- Error types
- Agent decision quality

## Next Steps

1. ✅ PR 2 complete - commit and merge
2. → Start PR 3 (Worktrees)
3. → Parallel work on PR 4-5 (GitHub + Slack)
4. → PR 6 (Graph)
5. → PR 7 (Autonomous loops)
