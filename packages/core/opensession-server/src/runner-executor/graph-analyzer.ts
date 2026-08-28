/**
 * Graph Analyzer for Repository Intelligence.
 *
 * Provides risk analysis, impact assessment, and code relationship queries.
 */

import type {
  DurableRepositoryFileRegistry,
} from "./durable-repository-file-registry";
import type { FileRelationship, RiskAnalysis, TaskCodeContext } from "./mission-control-graph";

/**
 * Graph Analyzer Interface.
 */
export interface GraphAnalyzerInterface {
  // Risk analysis
  analyzeFileRisk(projectId: string, filePath: string): Promise<RiskAnalysis>;
  identifyHighRiskFiles(projectId: string, threshold?: number): Promise<string[]>;
  
  // Impact analysis
  analyzeChangeImpact(
    projectId: string,
    modifiedFiles: string[],
  ): Promise<{
    directlyImpacted: string[];
    transitivelyImpacted: string[];
    riskScore: number;
  }>;

  // Task context
  getTaskCodeContext(
    projectId: string,
    taskId: string,
    relevantFiles?: string[],
  ): Promise<TaskCodeContext>;
  findSimilarTasks(projectId: string, taskId: string): Promise<string[]>;

  // Graph queries
  findCriticalPaths(projectId: string): Promise<string[][]>;
  findCircularDependencies(projectId: string): Promise<string[][]>;
  getCodeLanguageDistribution(projectId: string): Promise<Record<string, number>>;
}

/**
 * Create a graph analyzer.
 */
export function createGraphAnalyzer(
  fileRegistry: DurableRepositoryFileRegistry,
): GraphAnalyzerInterface {
  return {
    async analyzeFileRisk(
      projectId: string,
      filePath: string,
    ): Promise<RiskAnalysis> {
      // Get the file
      const file = await fileRegistry.getFileByPath(projectId, filePath);
      if (!file) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Get all files that depend on this file
      const impacted = await fileRegistry.getFileImpact(projectId, filePath);

      // Calculate risk scores
      const impactedFiles = impacted.map((rel) => ({
        path: rel.sourceFile,
        riskScore: rel.riskScore,
        reason: `Direct ${rel.relationshipType}`,
      }));

      // Estimate test coverage based on related files
      const relatedFiles = await fileRegistry.findRelatedFiles(
        projectId,
        filePath,
      );
      const avgTestCoverage = file.testCoverage || 0;
      const estimatedAffectedCoverage = Math.max(0, avgTestCoverage - 20);

      // Determine breaking change risk
      let breakingChangeRisk: "low" | "medium" | "high" = "low";
      if (impacted.length > 10) breakingChangeRisk = "high";
      else if (impacted.length > 5) breakingChangeRisk = "medium";

      // Generate suggestions
      const suggestions = [];
      if (!file.testCoverage || file.testCoverage < 80) {
        suggestions.push(`Increase test coverage for ${filePath}`);
      }
      if (impacted.length > 5) {
        suggestions.push("Consider refactoring to reduce coupling");
      }
      if (file.complexity && file.complexity > 10) {
        suggestions.push("File has high cyclomatic complexity - consider breaking into smaller modules");
      }

      return {
        projectId,
        filePath,
        impactedFiles: impactedFiles.slice(0, 10), // Top 10
        estimatedTestCoverage: estimatedAffectedCoverage,
        breakingChangeRisk,
        suggestions,
      };
    },

    async identifyHighRiskFiles(
      projectId: string,
      threshold: number = 0.7,
    ): Promise<string[]> {
      const highRiskFiles = await fileRegistry.getHighRiskFiles(
        projectId,
        20,
      );
      return highRiskFiles;
    },

    async analyzeChangeImpact(
      projectId: string,
      modifiedFiles: string[],
    ): Promise<{
      directlyImpacted: string[];
      transitivelyImpacted: string[];
      riskScore: number;
    }> {
      const directly = new Set<string>();
      const transitively = new Set<string>();
      let totalRiskScore = 0;

      // Find all directly impacted files
      for (const filePath of modifiedFiles) {
        const impacts = await fileRegistry.getFileImpact(projectId, filePath);
        for (const rel of impacts) {
          directly.add(rel.sourceFile);
          totalRiskScore += rel.riskScore;
        }
      }

      // Find transitively impacted files (one degree removed)
      for (const directFile of directly) {
        const impacts = await fileRegistry.getFileImpact(
          projectId,
          directFile,
        );
        for (const rel of impacts) {
          if (!directly.has(rel.sourceFile)) {
            transitively.add(rel.sourceFile);
            totalRiskScore += rel.riskScore * 0.5; // Lower weight for transitive
          }
        }
      }

      return {
        directlyImpacted: Array.from(directly),
        transitivelyImpacted: Array.from(transitively),
        riskScore: Math.min(1, totalRiskScore / Math.max(1, modifiedFiles.length)),
      };
    },

    async getTaskCodeContext(
      projectId: string,
      taskId: string,
      relevantFiles?: string[],
    ): Promise<TaskCodeContext> {
      // If relevant files provided, use them; otherwise return empty context
      const files = relevantFiles || [];

      const context: TaskCodeContext = {
        taskId,
        projectId,
        relevantFiles: files.map((path) => ({
          path,
          relevance: 1.0,
          symbols: [],
          reason: "Explicitly provided",
        })),
        estimatedScope: files.length <= 3 ? "small" : files.length <= 10 ? "medium" : "large",
        complexity: "medium",
      };

      return context;
    },

    async findSimilarTasks(
      projectId: string,
      taskId: string,
    ): Promise<string[]> {
      // Simplified: return empty list for now
      // A full implementation would compare task context, code changes, etc.
      return [];
    },

    async findCriticalPaths(projectId: string): Promise<string[][]> {
      // Simplified: return empty for now
      // Full implementation would use graph algorithms (topological sort, etc.)
      return [];
    },

    async findCircularDependencies(projectId: string): Promise<string[][]> {
      // Simplified: return empty for now
      // Full implementation would detect cycles in file dependency graph
      return [];
    },

    async getCodeLanguageDistribution(
      projectId: string,
    ): Promise<Record<string, number>> {
      const files = await fileRegistry.listFiles(projectId);
      const distribution: Record<string, number> = {};

      for (const file of files) {
        distribution[file.language] = (distribution[file.language] || 0) + 1;
      }

      return distribution;
    },
  };
}
