/**
 * Durable Repository File Registry backed by FeltDB.
 *
 * Manages code inventory, symbols, and file-level metadata.
 */

import type { StateFirstDB } from "@feltdb/core";
import type {
  RepositoryFile,
  CodeSymbol,
  ImportRelationship,
  ExportStatement,
  FileRelationship,
  CommitFileChange,
} from "./mission-control-graph";
import type { CommitFileChange as ObservedCommitFileChange } from "./mission-control-repository-observer";
export type { RepositoryFile } from "./mission-control-graph";

interface GraphRelationship {
  fromId: string;
  toId: string;
  kind: string;
  metadata?: Record<string, unknown>;
}

/**
 * Stored repository file row.
 */
interface StoredRepositoryFile {
  id: string;
  projectId: string;
  filePath: string;
  fileType: string;
  language: string;
  size: number;
  lines: number;
  symbols: CodeSymbol[];
  imports: ImportRelationship[];
  exports: ExportStatement[];
  dependencies: string[];
  dependents: string[];
  complexity?: number;
  testCoverage?: number;
  lastAnalyzedAt: string;
  lastModifiedAt: string;
}

/**
 * Stored file relationship row.
 */
interface StoredFileRelationship {
  id: string;
  projectId: string;
  sourceFile: string;
  targetFile: string;
  relationshipType: string;
  riskScore: number;
  weight: number;
  sharedSymbols?: FileRelationship["sharedSymbols"];
  metadata?: FileRelationship["metadata"];
}

/**
 * Stored commit file change row.
 */
interface StoredCommitFileChange {
  id: string;
  projectId: string;
  commitSha: string;
  filePath: string;
  changeType: string;
  additions: number;
  deletions: number;
  changedSymbols?: CommitFileChange["changedSymbols"];
  timestamp: string;
}

/**
 * Durable Repository File Registry Interface.
 */
export interface DurableRepositoryFileRegistry {
  // File CRUD
  createFile(file: RepositoryFile): Promise<void>;
  getFile(id: string): Promise<RepositoryFile | undefined>;
  getFileByPath(projectId: string, filePath: string): Promise<RepositoryFile | undefined>;
  listFiles(projectId: string, fileType?: string): Promise<RepositoryFile[]>;
  updateFile(file: RepositoryFile): Promise<void>;
  deleteFile(id: string): Promise<void>;

  // Relationships
  createRelationship(
    relationship: FileRelationship,
  ): Promise<void>;
  getRelationshipsByFile(
    projectId: string,
    filePath: string,
  ): Promise<FileRelationship[]>;
  getRelationships(fileId: string, relationshipType: string): Promise<GraphRelationship[]>;
  getRelationshipsByType(relationshipType: string): Promise<GraphRelationship[]>;
  getFileImpact(projectId: string, filePath: string): Promise<FileRelationship[]>;
  updateRelationship(relationship: FileRelationship): Promise<void>;
  deleteRelationship(id: string): Promise<void>;

  // Commit changes
  recordFileChange(change: CommitFileChange): Promise<void>;
  getFileChanges(
    projectId: string,
    filePath: string,
  ): Promise<CommitFileChange[]>;
  getCommitChanges(projectId: string, commitSha: string): Promise<CommitFileChange[]>;
  getChangesByFile(fileId: string): Promise<ObservedCommitFileChange[]>;
  getChangesByAgentRun(runId: string): Promise<ObservedCommitFileChange[]>;

  // Analytics
  getHighRiskFiles(projectId: string, limit?: number): Promise<string[]>;
  getRecentChanges(projectId: string, limit?: number): Promise<CommitFileChange[]>;
  findRelatedFiles(projectId: string, filePath: string): Promise<string[]>;
}

/**
 * Open or create a durable repository file registry.
 */
export function openDurableRepositoryFileRegistry(
  db: StateFirstDB,
): DurableRepositoryFileRegistry {

  const FILES_COLLECTION = "repository_files";
  const RELATIONSHIPS_COLLECTION = "file_relationships";
  const CHANGES_COLLECTION = "commit_file_changes";

  return {
    async createFile(file: RepositoryFile): Promise<void> {
      const row: StoredRepositoryFile = {
        id: file.id,
        projectId: file.projectId,
        filePath: file.filePath,
        fileType: file.fileType,
        language: file.language,
        size: file.size,
        lines: file.lines,
        symbols: file.symbols,
        imports: file.imports,
        exports: file.exports,
        dependencies: file.dependencies,
        dependents: file.dependents,
        complexity: file.complexity,
        testCoverage: file.testCoverage,
        lastAnalyzedAt: file.lastAnalyzedAt,
        lastModifiedAt: file.lastModifiedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredRepositoryFile>(FILES_COLLECTION).set(file.id, row);
      });
    },

    async getFile(id: string): Promise<RepositoryFile | undefined> {
      const row = await db
        .collection<StoredRepositoryFile>(FILES_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        projectId: row.projectId,
        filePath: row.filePath,
        fileType: row.fileType as any,
        language: row.language,
        size: row.size,
        lines: row.lines,
        symbols: row.symbols,
        imports: row.imports,
        exports: row.exports,
        dependencies: row.dependencies,
        dependents: row.dependents,
        complexity: row.complexity,
        testCoverage: row.testCoverage,
        lastAnalyzedAt: row.lastAnalyzedAt,
        lastModifiedAt: row.lastModifiedAt,
      };
    },

    async getFileByPath(
      projectId: string,
      filePath: string,
    ): Promise<RepositoryFile | undefined> {
      const rows = await db
        .collection<StoredRepositoryFile>(FILES_COLLECTION)
        .find({ projectId, filePath });

      if (rows.length === 0) return undefined;
      const row = rows[0];
      return {
        id: row.id,
        projectId: row.projectId,
        filePath: row.filePath,
        fileType: row.fileType as any,
        language: row.language,
        size: row.size,
        lines: row.lines,
        symbols: row.symbols,
        imports: row.imports,
        exports: row.exports,
        dependencies: row.dependencies,
        dependents: row.dependents,
        complexity: row.complexity,
        testCoverage: row.testCoverage,
        lastAnalyzedAt: row.lastAnalyzedAt,
        lastModifiedAt: row.lastModifiedAt,
      };
    },

    async listFiles(
      projectId: string,
      fileType?: string,
    ): Promise<RepositoryFile[]> {
      const rows = fileType
        ? await db
            .collection<StoredRepositoryFile>(FILES_COLLECTION)
            .find({ projectId, fileType })
        : await db
            .collection<StoredRepositoryFile>(FILES_COLLECTION)
            .find({ projectId });

      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        filePath: row.filePath,
        fileType: row.fileType as any,
        language: row.language,
        size: row.size,
        lines: row.lines,
        symbols: row.symbols,
        imports: row.imports,
        exports: row.exports,
        dependencies: row.dependencies,
        dependents: row.dependents,
        complexity: row.complexity,
        testCoverage: row.testCoverage,
        lastAnalyzedAt: row.lastAnalyzedAt,
        lastModifiedAt: row.lastModifiedAt,
      }));
    },

    async updateFile(file: RepositoryFile): Promise<void> {
      const row: StoredRepositoryFile = {
        id: file.id,
        projectId: file.projectId,
        filePath: file.filePath,
        fileType: file.fileType,
        language: file.language,
        size: file.size,
        lines: file.lines,
        symbols: file.symbols,
        imports: file.imports,
        exports: file.exports,
        dependencies: file.dependencies,
        dependents: file.dependents,
        complexity: file.complexity,
        testCoverage: file.testCoverage,
        lastAnalyzedAt: file.lastAnalyzedAt,
        lastModifiedAt: file.lastModifiedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredRepositoryFile>(FILES_COLLECTION).set(file.id, row);
      });
    },

    async deleteFile(id: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredRepositoryFile>(FILES_COLLECTION).delete(id);
      });
    },

    async createRelationship(
      relationship: FileRelationship,
    ): Promise<void> {
      const row: StoredFileRelationship = {
        id: relationship.id,
        projectId: relationship.projectId,
        sourceFile: relationship.sourceFile,
        targetFile: relationship.targetFile,
        relationshipType: relationship.relationshipType,
        riskScore: relationship.riskScore,
        weight: relationship.weight,
        sharedSymbols: relationship.sharedSymbols,
        metadata: relationship.metadata,
      };

      await db.transaction((tx) => {
        tx.collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION).set(
          relationship.id,
          row,
        );
      });
    },

    async getRelationshipsByFile(
      projectId: string,
      filePath: string,
    ): Promise<FileRelationship[]> {
      const outgoing = await db
        .collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION)
        .find({ projectId, sourceFile: filePath });

      const incoming = await db
        .collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION)
        .find({ projectId, targetFile: filePath });

      const all = [...outgoing, ...incoming];

      return all.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        sourceFile: row.sourceFile,
        targetFile: row.targetFile,
        relationshipType: row.relationshipType as any,
        riskScore: row.riskScore,
        weight: row.weight,
        sharedSymbols: row.sharedSymbols,
        metadata: row.metadata,
      }));
    },

    async getRelationships(fileId: string, relationshipType: string): Promise<GraphRelationship[]> {
      const file = await this.getFile(fileId);
      if (!file) return [];
      const relationships = await this.getRelationshipsByFile(file.projectId, file.filePath);
      return relationships
        .filter((relationship) => relationshipType === "all" || relationship.relationshipType === relationshipType)
        .map((relationship) => ({
          fromId: relationship.sourceFile,
          toId: relationship.targetFile,
          kind: relationship.relationshipType,
          metadata: relationship.metadata,
        }));
    },

    async getRelationshipsByType(relationshipType: string): Promise<GraphRelationship[]> {
      const rows = await db.collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION).all();
      return rows
        .filter((row) => relationshipType === "all" || row.relationshipType === relationshipType)
        .map((row) => ({
          fromId: row.sourceFile,
          toId: row.targetFile,
          kind: row.relationshipType,
          metadata: row.metadata,
        }));
    },

    async getFileImpact(
      projectId: string,
      filePath: string,
    ): Promise<FileRelationship[]> {
      // Get all files that depend on this file (incoming)
      const incoming = await db
        .collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION)
        .find({ projectId, targetFile: filePath });

      return incoming.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        sourceFile: row.sourceFile,
        targetFile: row.targetFile,
        relationshipType: row.relationshipType as any,
        riskScore: row.riskScore,
        weight: row.weight,
        sharedSymbols: row.sharedSymbols,
        metadata: row.metadata,
      }));
    },

    async updateRelationship(
      relationship: FileRelationship,
    ): Promise<void> {
      const row: StoredFileRelationship = {
        id: relationship.id,
        projectId: relationship.projectId,
        sourceFile: relationship.sourceFile,
        targetFile: relationship.targetFile,
        relationshipType: relationship.relationshipType,
        riskScore: relationship.riskScore,
        weight: relationship.weight,
        sharedSymbols: relationship.sharedSymbols,
        metadata: relationship.metadata,
      };

      await db.transaction((tx) => {
        tx.collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION).set(
          relationship.id,
          row,
        );
      });
    },

    async deleteRelationship(id: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION).delete(id);
      });
    },

    async recordFileChange(change: CommitFileChange): Promise<void> {
      const row: StoredCommitFileChange = {
        id: change.id,
        projectId: change.projectId,
        commitSha: change.commitSha,
        filePath: change.filePath,
        changeType: change.changeType,
        additions: change.additions,
        deletions: change.deletions,
        changedSymbols: change.changedSymbols,
        timestamp: change.timestamp,
      };

      await db.transaction((tx) => {
        tx.collection<StoredCommitFileChange>(CHANGES_COLLECTION).set(
          change.id,
          row,
        );
      });
    },

    async getFileChanges(
      projectId: string,
      filePath: string,
    ): Promise<CommitFileChange[]> {
      const rows = await db
        .collection<StoredCommitFileChange>(CHANGES_COLLECTION)
        .find({ projectId, filePath });

      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        commitSha: row.commitSha,
        filePath: row.filePath,
        changeType: row.changeType as any,
        additions: row.additions,
        deletions: row.deletions,
        changedSymbols: row.changedSymbols,
        timestamp: row.timestamp,
      }));
    },

    async getCommitChanges(
      projectId: string,
      commitSha: string,
    ): Promise<CommitFileChange[]> {
      const rows = await db
        .collection<StoredCommitFileChange>(CHANGES_COLLECTION)
        .find({ projectId, commitSha });

      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        commitSha: row.commitSha,
        filePath: row.filePath,
        changeType: row.changeType as any,
        additions: row.additions,
        deletions: row.deletions,
        changedSymbols: row.changedSymbols,
        timestamp: row.timestamp,
      }));
    },

    async getChangesByFile(fileId: string): Promise<ObservedCommitFileChange[]> {
      const file = await this.getFile(fileId);
      if (!file) return [];
      const changes = await this.getFileChanges(file.projectId, file.filePath);
      return changes.map((change) => ({
        id: change.id,
        commitId: change.commitSha,
        fileId,
        changeType: change.changeType === "copied" ? "modified" : change.changeType,
        additions: change.additions,
        deletions: change.deletions,
      }));
    },

    async getChangesByAgentRun(_runId: string): Promise<ObservedCommitFileChange[]> {
      return [];
    },

    async getHighRiskFiles(
      projectId: string,
      limit: number = 10,
    ): Promise<string[]> {
      const rels = await db
        .collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION)
        .find({ projectId });

      // Group by source file and sum risk scores
      const riskMap = new Map<string, number>();
      for (const rel of rels) {
        const current = riskMap.get(rel.sourceFile) || 0;
        riskMap.set(rel.sourceFile, current + rel.riskScore);
      }

      // Sort by risk score
      const sorted = Array.from(riskMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([file]) => file);

      return sorted;
    },

    async getRecentChanges(
      projectId: string,
      limit: number = 20,
    ): Promise<CommitFileChange[]> {
      const rows = await db
        .collection<StoredCommitFileChange>(CHANGES_COLLECTION)
        .find({ projectId });

      return rows
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          projectId: row.projectId,
          commitSha: row.commitSha,
          filePath: row.filePath,
          changeType: row.changeType as any,
          additions: row.additions,
          deletions: row.deletions,
          changedSymbols: row.changedSymbols,
          timestamp: row.timestamp,
        }));
    },

    async findRelatedFiles(
      projectId: string,
      filePath: string,
    ): Promise<string[]> {
      const rels = await db
        .collection<StoredFileRelationship>(RELATIONSHIPS_COLLECTION)
        .find({ projectId });

      // Find all files that relate to this file
      const related = new Set<string>();
      for (const rel of rels) {
        if (rel.sourceFile === filePath) {
          related.add(rel.targetFile);
        }
        if (rel.targetFile === filePath) {
          related.add(rel.sourceFile);
        }
      }

      return Array.from(related);
    },
  };
}
