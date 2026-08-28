/**
 * Repository Observer: Watches filesystem and git for changes, derives intelligence.
 *
 * This is the read/derive layer for PR6: Repository Intelligence Graph.
 *
 * The filesystem and Git are authoritative sources.
 * FeltDB stores derived intelligence about structure, relationships, and history.
 */

export interface RepositoryCommit {
  id: string;
  repositoryId: string;
  sha: string;
  parentShas: string[];
  branch?: string;
  author?: string;
  message: string;
  committedAt: string;
  observedAt: string;
}

export interface CommitFileChange {
  id: string;
  commitId: string;
  fileId: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  newPath?: string;
  additions?: number;
  deletions?: number;
}

export interface RepositorySnapshot {
  id: string;
  repositoryId: string;
  commitSha: string;
  createdAt: string;
  fileCount: number;
  symbolCount: number;
  graphVersion: number;
}

export interface IndexResult {
  repositoryId: string;
  filesIndexed: number;
  symbolsExtracted: number;
  edgesCreated: number;
  edgesRemoved: number;
  duration: number;
  timestamp: string;
  status: "success" | "partial" | "failed";
  error?: string;
}

/**
 * RepositoryIndexer orchestrates analysis of repository structure.
 * Designed for incremental indexing (don't rescan entire repo).
 */
export interface RepositoryIndexer {
  /**
   * Full index: analyze entire repository from a clean state.
   */
  index(repositoryId: string): Promise<IndexResult>;

  /**
   * Incremental: index a specific commit and its changes.
   */
  indexCommit(repositoryId: string, commitSha: string): Promise<IndexResult>;

  /**
   * Incremental: re-analyze specific file paths.
   * Used when filesystem changes or git history updates.
   */
  indexChangedFiles(repositoryId: string, paths: string[]): Promise<IndexResult>;

  /**
   * Get current indexing status for a repository.
   */
  getIndexStatus(
    repositoryId: string
  ): Promise<{
    status: "never" | "queued" | "indexing" | "ready" | "failed";
    lastIndexedAt?: string;
    lastIndexedCommit?: string;
    error?: string;
  }>;
}

/**
 * Repository symbol extractor (language-agnostic interface).
 * Implementations for each supported language.
 */
export interface SymbolExtractor {
  language: string;

  /**
   * Extract symbols (classes, functions, types, etc.) from source code.
   */
  extract(
    filePath: string,
    content: string
  ): Promise<Array<{
    kind:
      | "module"
      | "class"
      | "function"
      | "method"
      | "type"
      | "interface"
      | "constant"
      | "variable"
      | "enum";
    name: string;
    qualifiedName?: string;
    startLine: number;
    endLine: number;
    signature?: string;
  }>>;

  /**
   * Extract import statements and dependencies.
   */
  extractDependencies(
    filePath: string,
    content: string
  ): Promise<Array<{
    module: string;
    isExternal: boolean;
    isRelative: boolean;
    resolvedPath?: string;
  }>>;
}

/**
 * Risk scoring based on deterministic signals, not AI.
 * Agents should be able to explain why something is high-risk.
 */
export interface RiskSignals {
  dependentCount: number; // How many other files depend on this
  recentChangeCount: number; // Changes in last N commits
  failedExecutionCount: number; // Agent runs that failed on this file
  reviewFindingCount: number; // Review issues in this file
  activeTaskCount: number; // Tasks currently targeting this file
}

export interface RiskScore {
  fileId: string;
  score: number; // 0-100, higher is riskier
  signals: RiskSignals;
  summary: string; // Human-readable explanation
  timestamp: string;
}

/**
 * The repository graph queries that agents actually use.
 * Abstraction over raw FeltDB queries.
 */
export interface RepositoryGraphQueries {
  /**
   * What does this file depend on (direct imports)?
   */
  getFileDependencies(fileId: string): Promise<Array<{ fileId: string; path: string }>>;

  /**
   * What files depend on this file?
   */
  getDependents(fileId: string): Promise<Array<{ fileId: string; path: string }>>;

  /**
   * Where is this symbol referenced?
   */
  getSymbolReferences(symbolId: string): Promise<Array<{ fileId: string; line: number }>>;

  /**
   * What files changed in this commit?
   */
  getChangedFiles(commitSha: string): Promise<CommitFileChange[]>;

  /**
   * Files affected by a task (direct + transitive).
   */
  getFilesAffectedByTask(taskId: string): Promise<Array<{ fileId: string; path: string }>>;

  /**
   * Files modified by an agent run.
   */
  getFilesModifiedByAgentRun(runId: string): Promise<CommitFileChange[]>;

  /**
   * Recent changes across repository (configurable window).
   */
  getRecentChanges(repositoryId: string, windowDays?: number): Promise<CommitFileChange[]>;

  /**
   * Related files (N degrees of separation in the graph).
   */
  getRelatedFiles(fileId: string, depth: number): Promise<Array<{ fileId: string; path: string; distance: number }>>;

  /**
   * Neighborhood around a node in the graph (for visualization/analysis).
   */
  getRepositoryNeighborhood(nodeId: string, depth: number): Promise<{
    node: { id: string; type: string; label: string };
    edges: Array<{ source: string; target: string; kind: string }>;
  }>;

  /**
   * Files that are high-risk and why.
   */
  getRiskNeighborhood(fileId: string): Promise<{
    target: { fileId: string; risk: RiskScore };
    dependents: RiskScore[];
    dependencies: RiskScore[];
  }>;
}

/**
 * Repository state tracker: what have we indexed, what's current?
 */
export interface RepositoryIndexState {
  repositoryId: string;
  headCommit: string;
  lastIndexedCommit?: string;
  lastIndexedAt?: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  indexingStatus: "never" | "queued" | "indexing" | "ready" | "failed";
  indexingError?: string;
}
