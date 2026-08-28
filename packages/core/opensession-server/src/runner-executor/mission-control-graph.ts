/**
 * Repository Intelligence Graph type definitions for PR 6.
 *
 * Models file inventory, code symbols, imports/exports, and relationships.
 */

/**
 * Symbol kind (function, class, type, interface, etc).
 */
export type SymbolKind =
  | "function"
  | "class"
  | "type"
  | "interface"
  | "enum"
  | "const"
  | "variable"
  | "module"
  | "namespace"
  | "import"
  | "export";

/**
 * Code symbol (function, class, type, etc).
 */
export interface CodeSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  line: number;
  column: number;
  description?: string;
  isExported: boolean;
  type?: string; // Type signature
}

/**
 * Import relationship between files.
 */
export interface ImportRelationship {
  id: string;
  fromFilePath: string;
  toFilePath: string;
  importType: "default" | "named" | "namespace" | "dynamic";
  symbols?: string[]; // Named imports
  lineNumber?: number;
  resolvedPath?: string; // Resolved full path after npm resolution
}

/**
 * Export statement.
 */
export interface ExportStatement {
  id: string;
  filePath: string;
  exportType: "default" | "named" | "namespace" | "re-export";
  symbols?: string[]; // Named exports
  lineNumber?: number;
}

/**
 * Repository file with code metadata.
 */
export interface RepositoryFile {
  id: string;
  projectId: string;
  filePath: string;
  fileType: "source" | "test" | "config" | "doc" | "other";
  language: string; // "typescript", "javascript", "python", etc.
  size: number;
  lines: number;
  symbols: CodeSymbol[]; // Functions, classes, types, etc.
  imports: ImportRelationship[];
  exports: ExportStatement[];
  dependencies: string[]; // Direct file dependencies
  dependents: string[]; // Files that depend on this
  complexity?: number; // Cyclomatic complexity
  testCoverage?: number; // Percentage 0-100
  lastAnalyzedAt: string;
  lastModifiedAt: string;
}

/**
 * File relationship in the graph.
 */
export interface FileRelationship {
  id: string;
  projectId: string;
  sourceFile: string;
  targetFile: string;
  relationshipType: "imports" | "exports_to" | "test_for" | "tests" | "depends_on";
  riskScore: number; // 0-1 indicating risk of changing source
  weight: number; // Strength of relationship
  sharedSymbols?: string[]; // Symbols used across files
  metadata?: Record<string, unknown>;
}

/**
 * Commit-to-file relationship.
 */
export interface CommitFileChange {
  id: string;
  projectId: string;
  commitSha: string;
  filePath: string;
  changeType: "added" | "modified" | "deleted" | "renamed" | "copied";
  additions: number;
  deletions: number;
  changedSymbols?: string[]; // Symbols affected by commit
  timestamp: string;
}

/**
 * Graph projection of file relationships for query efficiency.
 */
export interface FileGraph {
  projectId: string;
  fileCount: number;
  symbolCount: number;
  relationships: FileRelationship[];
  highRiskFiles: string[]; // Files with high change impact
  criticalPaths: string[][]; // Critical file dependency paths
  lastUpdatedAt: string;
}

/**
 * Risk analysis result.
 */
export interface RiskAnalysis {
  projectId: string;
  filePath: string;
  impactedFiles: Array<{
    path: string;
    riskScore: number; // 0-1
    reason: string;
  }>;
  estimatedTestCoverage: number; // Percentage affected
  breakingChangeRisk: "low" | "medium" | "high";
  suggestions: string[];
}

/**
 * Task-to-code relationship.
 */
export interface TaskCodeContext {
  taskId: string;
  projectId: string;
  relevantFiles: Array<{
    path: string;
    relevance: number; // 0-1 score
    symbols: string[];
    reason: string;
  }>;
  relatedTasks?: string[];
  estimatedScope: "small" | "medium" | "large";
  complexity: "low" | "medium" | "high";
}
