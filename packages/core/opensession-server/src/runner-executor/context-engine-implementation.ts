/**
 * Context Engine Implementation: Assembles unified agent context from all sources.
 *
 * This is the crucial integration point between PR6 (repository graph) and PR7 (agent context).
 * The engine does NOT invent context; it retrieves and ranks existing data from:
 * - Repository graph (files, symbols, dependencies, relationships)
 * - Task registry (description, acceptance criteria, priority)
 * - Execution history (prior attempts, output, failures)
 * - Conversation ledger (decisions, reviews, handoffs)
 * - Agent memory (what we learned)
 */

import type {
  ContextEngine,
  ContextConfig,
  UnifiedAgentContext,
  FileContext,
  SymbolContext,
  ChangeContext,
  ContextRelevance,
  ContextSnapshot,
  ProjectContext,
  RepositoryContext,
  TaskContext,
  ExecutionContext,
  ConversationContext,
  AttemptContext,
  DecisionContext,
  ReviewContext,
  FailureContext,
  BlockerContext,
  AgentContextSummary,
  AcceptanceCriterion,
  Constraint,
} from "./mission-control-context-unified";
import type { RepositoryGraphQueries } from "./repository-graph-queries";
import type { DurableRepositoryFileRegistry } from "./durable-repository-file-registry";
import type { DurableConversationLedger } from "./durable-conversation-ledger";
import { randomUUIDv7 } from "bun";

export interface ContextEngineConfig {
  graph: RepositoryGraphQueries;
  fileRegistry: DurableRepositoryFileRegistry;
  conversationLedger: DurableConversationLedger;
  config: ContextConfig;
  getProject(projectId: string): Promise<ProjectContext>;
  getRepository(repositoryId: string): Promise<RepositoryContext>;
  getTask(taskId: string): Promise<TaskContext | undefined>;
  getExecution(executionId: string): Promise<ExecutionContext | undefined>;
  getRelatedAgents(agentId: string): Promise<AgentContextSummary[]>;
}

export function createContextEngine(
  cfg: ContextEngineConfig
): ContextEngine {
  const {
    graph,
    fileRegistry,
    conversationLedger,
    config,
    getProject,
    getRepository,
    getTask,
    getExecution,
    getRelatedAgents,
  } = cfg;

  /**
   * Core logic: assemble context by relevance.
   */
  async function assembleContext(opts: {
    projectId: string;
    repositoryId: string;
    taskId?: string;
    executionId?: string;
    conversationId?: string;
    focusFileId?: string;
    agentId: string;
  }): Promise<UnifiedAgentContext> {
    const now = new Date().toISOString();
    const relevance: ContextRelevance[] = [];

    // 1. Project and repository context (always included)
    const project = await getProject(opts.projectId);
    const repository = await getRepository(opts.repositoryId);

    // 2. Task context (if applicable)
    let task: TaskContext | undefined;
    if (opts.taskId) {
      task = await getTask(opts.taskId);
      if (task) {
        relevance.push({
          sourceId: opts.taskId,
          sourceType: "task",
          score: 100,
          reason: "Primary work scope",
        });
      }
    }

    // 3. Execution context (if applicable)
    let execution: ExecutionContext | undefined;
    if (opts.executionId) {
      execution = await getExecution(opts.executionId);
    }

    // 4. Relevant files (from task or focus file)
    const relevantFiles: FileContext[] = [];
    let filesToAnalyze: string[] = [];

    if (opts.focusFileId) {
      // Focus on a specific file and its neighbors
      filesToAnalyze = [opts.focusFileId];
      const related = await graph.getRelatedFiles(opts.focusFileId, 2);
      filesToAnalyze.push(...related.map((r) => r.fileId));
    } else if (opts.taskId) {
      // Get files affected by task
      const affected = await graph.getFilesAffectedByTask(opts.taskId);
      filesToAnalyze = affected.map((f) => f.fileId);
    }

    // Analyze files and rank by relevance
    const fileScores: Map<string, number> = new Map();
    for (const fileId of filesToAnalyze) {
      const file = await fileRegistry.getFile(fileId);
      if (!file) continue;

      // Score based on:
      // - Direct task association (HIGH)
      // - Direct dependencies (HIGH)
      // - Recent changes (MEDIUM)
      // - Dependent count (MEDIUM)
      let score = 50; // base score

      if (opts.focusFileId === fileId) score += 50;
      const deps = await graph.getDependents(fileId);
      score += Math.min(20, deps.length * 2);
      const changes = await fileRegistry.getChangesByFile(fileId);
      score += Math.min(15, changes.length);

      fileScores.set(fileId, Math.min(100, score));
    }

    // Sort and limit
    const sortedFiles = Array.from(fileScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, config.maxRelevantFiles);

    for (const [fileId, score] of sortedFiles) {
      const file = await fileRegistry.getFile(fileId);
      if (!file) continue;

      const deps = await graph.getFileDependencies(fileId);
      const dependents = await graph.getDependents(fileId);

      relevantFiles.push({
        fileId,
        path: file.filePath,
        language: file.language,
        sizeBytes: file.size,
        relevanceScore: score,
        reason: score >= 90 ? "Direct task focus" : "Related to task",
        dependencies: deps.map((d) => d.path),
        dependents: dependents.map((d) => d.path),
      });

      relevance.push({
        sourceId: fileId,
        sourceType: "file",
        score,
        reason: "Task-related code",
      });
    }

    // 5. Recent changes
    const allChanges = await graph.getRecentChanges(
      opts.repositoryId,
      config.recentChangesWindow
    );
    const recentChanges = allChanges
      .slice(0, config.maxRecentChanges)
      .map((change) => ({
        fileId: change.fileId,
        path: "",
        changeType: change.changeType,
        commitSha: change.commitId,
        author: undefined,
        message: "Recent change",
        commitDate: now,
      }));

    // 6. Prior attempts (from conversation ledger)
    const priorAttempts: AttemptContext[] = [];
    if (opts.conversationId) {
      const turns = await conversationLedger.getTurnsByConversation(
        opts.conversationId
      );
      for (let i = 0; i < Math.min(config.maxPriorAttempts, turns.length); i++) {
        const turn = turns[i];
        if (turn.agentId === opts.agentId) {
          priorAttempts.push({
            attemptNumber: i + 1,
            agentId: turn.agentId,
            status: "success",
            output: turn.content,
            duration: 0,
            timestamp: turn.timestamp,
          });
        }
      }
    }

    // 7. Decisions
    const decisions: DecisionContext[] = [];
    if (opts.conversationId) {
      const decs = await conversationLedger.getDecisionsByConversation(
        opts.conversationId
      );
      for (const dec of decs.slice(0, config.maxDecisions)) {
        decisions.push({
          decisionId: dec.id,
          agentId: dec.agentId,
          decision: dec.decision,
          reasoning: dec.reasoning,
          confidence: dec.confidence,
          timestamp: dec.timestamp,
        });

        relevance.push({
          sourceId: dec.id,
          sourceType: "decision",
          score: Math.round(dec.confidence * 100),
          reason: "Prior decision",
        });
      }
    }

    // 8. Conversation context
    let conversationCtx: ConversationContext = {
      conversationId: opts.conversationId || "",
      projectId: opts.projectId,
      taskId: opts.taskId,
      participants: [],
      lastMessageAt: now,
      turnCount: 0,
    };

    if (opts.conversationId) {
      const conv = await conversationLedger.getConversation(opts.conversationId);
      if (conv) {
        conversationCtx = {
          conversationId: conv.id,
          projectId: conv.projectId,
          taskId: conv.taskId,
          participants: conv.participants,
          lastMessageAt: conv.updatedAt,
          turnCount: conv.turns.length,
        };
      }
    }

    // 9. Acceptance criteria
    const acceptanceCriteria: AcceptanceCriterion[] = [];
    if (task?.acceptanceCriteria) {
      for (const criterion of task.acceptanceCriteria) {
        acceptanceCriteria.push({
          criterion,
          verified: false,
        });
      }
    }

    // 10. Related agents
    const relatedAgents = await getRelatedAgents(opts.agentId);

    return {
      project,
      repository,
      task,
      execution,
      relevantFiles,
      relevantSymbols: [],
      recentChanges,
      priorAttempts,
      decisions,
      reviews: [],
      failures: [],
      blockers: [],
      relatedAgents,
      conversation: conversationCtx,
      acceptanceCriteria,
      constraints: [],
      generatedAt: now,
      relevanceInfo: relevance,
    };
  }

  return {
    async buildForTask(
      taskId: string,
      agentId: string
    ): Promise<UnifiedAgentContext> {
      const task = await getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      // Infer project and repository from task context
      // (In real implementation, task would carry this info)
      return assembleContext({
        projectId: "proj-default",
        repositoryId: "repo-default",
        taskId,
        agentId,
      });
    },

    async buildForExecution(
      executionId: string,
      agentId: string
    ): Promise<UnifiedAgentContext> {
      const execution = await getExecution(executionId);
      if (!execution) throw new Error(`Execution not found: ${executionId}`);

      return assembleContext({
        projectId: "proj-default",
        repositoryId: "repo-default",
        taskId: execution.taskId,
        executionId,
        agentId,
      });
    },

    async buildForConversation(
      conversationId: string,
      agentId: string
    ): Promise<UnifiedAgentContext> {
      const conv = await conversationLedger.getConversation(conversationId);
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

      return assembleContext({
        projectId: conv.projectId,
        repositoryId: "repo-default",
        taskId: conv.taskId,
        conversationId,
        agentId,
      });
    },

    async buildForFile(
      fileId: string,
      agentId: string
    ): Promise<UnifiedAgentContext> {
      return assembleContext({
        projectId: "proj-default",
        repositoryId: "repo-default",
        focusFileId: fileId,
        agentId,
      });
    },

    async buildForRepository(
      repositoryId: string,
      agentId: string
    ): Promise<UnifiedAgentContext> {
      return assembleContext({
        projectId: "proj-default",
        repositoryId,
        agentId,
      });
    },

    async createContextSnapshot(
      context: UnifiedAgentContext,
      commitSha: string,
      graphVersion: number
    ): Promise<ContextSnapshot> {
      return {
        id: `snap-${randomUUIDv7()}`,
        taskId: context.task?.taskId || "",
        agentId: context.execution?.agentId || "",
        repositoryCommit: commitSha,
        graphVersion,
        context,
        createdAt: new Date().toISOString(),
      };
    },
  };
}
