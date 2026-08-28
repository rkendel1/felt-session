/**
 * Repository Graph Queries: The abstraction layer agents use to query the graph.
 *
 * This is NOT raw FeltDB queries. This is a clean service interface
 * that agents call without needing to understand database structure.
 *
 * Example: getRelatedFiles(fileId) → "What code relates to this task?"
 */

import type {
  RepositoryGraphQueries,
  RiskScore,
  RiskSignals,
} from "./mission-control-repository-observer";
import type { CommitFileChange } from "./mission-control-repository-observer";
import type { DurableRepositoryFileRegistry } from "./durable-repository-file-registry";
import type { DurableRepositoryCommitRegistry } from "./durable-repository-commit-registry";

export interface GraphQueriesConfig {
  fileRegistry: DurableRepositoryFileRegistry;
  commitRegistry: DurableRepositoryCommitRegistry;
  riskConfig?: {
    dependentWeight: number;
    changeWeight: number;
    failureWeight: number;
    reviewWeight: number;
    taskWeight: number;
  };
}

export function createRepositoryGraphQueries(
  config: GraphQueriesConfig
): RepositoryGraphQueries {
  const {
    fileRegistry,
    commitRegistry,
    riskConfig = {
      dependentWeight: 15,
      changeWeight: 10,
      failureWeight: 20,
      reviewWeight: 15,
      taskWeight: 25,
    },
  } = config;

  return {
    async getFileDependencies(fileId: string) {
      const edges = await fileRegistry.getRelationships(fileId, "depends_on");
      return Promise.all(
        edges.map(async (edge) => ({
          fileId: edge.toId,
          path: (await fileRegistry.getFile(edge.toId))?.path || "unknown",
        }))
      );
    },

    async getDependents(fileId: string) {
      const edges = await fileRegistry.getRelationships(fileId, "used_by");
      return Promise.all(
        edges.map(async (edge) => ({
          fileId: edge.fromId,
          path: (await fileRegistry.getFile(edge.fromId))?.path || "unknown",
        }))
      );
    },

    async getSymbolReferences(symbolId: string) {
      const edges = await fileRegistry.getRelationshipsByType("references");
      const refs = edges.filter((e) => e.toId === symbolId);

      return refs.map((ref) => ({
        fileId: ref.fromId,
        line: (ref.metadata as any)?.line || 0,
      }));
    },

    async getChangedFiles(commitSha: string) {
      const commit = await commitRegistry.getCommitBySha(commitSha);
      if (!commit) return [];

      return commitRegistry.getCommitChanges(commit.id);
    },

    async getFilesAffectedByTask(taskId: string) {
      // Get files linked to this task
      const edges = await fileRegistry.getRelationshipsByType("affects");
      const taskEdges = edges.filter((e) => e.metadata?.taskId === taskId);

      return Promise.all(
        taskEdges.map(async (edge) => ({
          fileId: edge.toId,
          path: (await fileRegistry.getFile(edge.toId))?.path || "unknown",
        }))
      );
    },

    async getFilesModifiedByAgentRun(runId: string) {
      // Get changes associated with agent run
      return fileRegistry.getChangesByAgentRun(runId);
    },

    async getRecentChanges(
      repositoryId: string,
      windowDays: number = 7
    ): Promise<CommitFileChange[]> {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - windowDays);

      const commits = await commitRegistry.getCommits(repositoryId, 1000);
      const recent = commits.filter(
        (c) => new Date(c.committedAt) > cutoff
      );

      const changes: CommitFileChange[] = [];
      for (const commit of recent) {
        const commitChanges = await commitRegistry.getCommitChanges(commit.id);
        changes.push(...commitChanges);
      }

      return changes;
    },

    async getRelatedFiles(fileId: string, depth: number) {
      const visited = new Set<string>();
      const result: Array<{
        fileId: string;
        path: string;
        distance: number;
      }> = [];

      const queue: Array<{ id: string; distance: number }> = [
        { id: fileId, distance: 0 },
      ];

      while (queue.length > 0) {
        const current = queue.shift()!;

        if (visited.has(current.id) || current.distance > depth) continue;
        visited.add(current.id);

        if (current.distance > 0) {
          const file = await fileRegistry.getFile(current.id);
          if (file) {
            result.push({
              fileId: current.id,
              path: file.path,
              distance: current.distance,
            });
          }
        }

        if (current.distance < depth) {
          // Get adjacent files
          const deps = await fileRegistry.getRelationships(
            current.id,
            "depends_on"
          );
          for (const dep of deps) {
            if (!visited.has(dep.toId)) {
              queue.push({ id: dep.toId, distance: current.distance + 1 });
            }
          }

          const dependents = await fileRegistry.getRelationships(
            current.id,
            "used_by"
          );
          for (const dep of dependents) {
            if (!visited.has(dep.fromId)) {
              queue.push({ id: dep.fromId, distance: current.distance + 1 });
            }
          }
        }
      }

      return result;
    },

    async getRepositoryNeighborhood(nodeId: string, depth: number) {
      const edges = await fileRegistry.getRelationshipsByType("all");
      const visited = new Set<string>();
      const relevant: typeof edges = [];

      function collect(
        id: string,
        currentDepth: number
      ): void {
        if (visited.has(id) || currentDepth > depth) return;
        visited.add(id);

        for (const edge of edges) {
          if (edge.fromId === id || edge.toId === id) {
            relevant.push(edge);

            if (edge.fromId === id) collect(edge.toId, currentDepth + 1);
            if (edge.toId === id) collect(edge.fromId, currentDepth + 1);
          }
        }
      }

      collect(nodeId, 0);

      return {
        node: {
          id: nodeId,
          type: "file",
          label: (await fileRegistry.getFile(nodeId))?.path || nodeId,
        },
        edges: relevant.map((e) => ({
          source: e.fromId,
          target: e.toId,
          kind: e.kind,
        })),
      };
    },

    async getRiskNeighborhood(fileId: string) {
      const file = await fileRegistry.getFile(fileId);
      if (!file) {
        return {
          target: {
            fileId,
            risk: {
              fileId,
              score: 0,
              signals: {
                dependentCount: 0,
                recentChangeCount: 0,
                failedExecutionCount: 0,
                reviewFindingCount: 0,
                activeTaskCount: 0,
              },
              summary: "File not found",
              timestamp: new Date().toISOString(),
            },
          },
          dependents: [],
          dependencies: [],
        };
      }

      const calculateRisk = (signals: RiskSignals): RiskScore => {
        const score =
          signals.dependentCount * riskConfig.dependentWeight +
          signals.recentChangeCount * riskConfig.changeWeight +
          signals.failedExecutionCount * riskConfig.failureWeight +
          signals.reviewFindingCount * riskConfig.reviewWeight +
          signals.activeTaskCount * riskConfig.taskWeight;

        const parts = [];
        if (signals.dependentCount > 0)
          parts.push(`${signals.dependentCount} dependents`);
        if (signals.recentChangeCount > 0)
          parts.push(`${signals.recentChangeCount} recent changes`);
        if (signals.failedExecutionCount > 0)
          parts.push(`${signals.failedExecutionCount} failed executions`);
        if (signals.reviewFindingCount > 0)
          parts.push(`${signals.reviewFindingCount} review findings`);
        if (signals.activeTaskCount > 0)
          parts.push(`${signals.activeTaskCount} active tasks`);

        return {
          fileId: signals.dependentCount === 0 ? "unknown" : fileId,
          score: Math.min(100, score),
          signals,
          summary:
            parts.length > 0
              ? `High-risk: ${parts.join(", ")}`
              : "Low-risk file",
          timestamp: new Date().toISOString(),
        };
      };

      // Get dependents and their signals
      const dependents = await fileRegistry.getRelationships(
        fileId,
        "used_by"
      );
      const dependentRisks: RiskScore[] = [];

      for (const dep of dependents) {
        const depFile = await fileRegistry.getFile(dep.fromId);
        if (depFile) {
          const changes = await fileRegistry.getChangesByFile(dep.fromId);
          dependentRisks.push(
            calculateRisk({
              dependentCount: await fileRegistry
                .getRelationships(dep.fromId, "used_by")
                .then((r) => r.length),
              recentChangeCount: changes.length,
              failedExecutionCount: 0,
              reviewFindingCount: 0,
              activeTaskCount: 0,
            })
          );
        }
      }

      // Get dependencies and their signals
      const deps = await fileRegistry.getRelationships(
        fileId,
        "depends_on"
      );
      const depRisks: RiskScore[] = [];

      for (const dep of deps) {
        const depFile = await fileRegistry.getFile(dep.toId);
        if (depFile) {
          const changes = await fileRegistry.getChangesByFile(dep.toId);
          depRisks.push(
            calculateRisk({
              dependentCount: await fileRegistry
                .getRelationships(dep.toId, "used_by")
                .then((r) => r.length),
              recentChangeCount: changes.length,
              failedExecutionCount: 0,
              reviewFindingCount: 0,
              activeTaskCount: 0,
            })
          );
        }
      }

      // Risk score for the target file
      const myChanges = await fileRegistry.getChangesByFile(fileId);
      const myDependents = await fileRegistry.getRelationships(
        fileId,
        "used_by"
      );
      const targetRisk = calculateRisk({
        dependentCount: myDependents.length,
        recentChangeCount: myChanges.length,
        failedExecutionCount: 0,
        reviewFindingCount: 0,
        activeTaskCount: 0,
      });

      return {
        target: { fileId, risk: targetRisk },
        dependents: dependentRisks,
        dependencies: depRisks,
      };
    },
  };
}
