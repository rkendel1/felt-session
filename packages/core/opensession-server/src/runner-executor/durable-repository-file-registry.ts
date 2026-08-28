/**
 * Durable Repository File Registry backed by FeltDB.
 *
 * Manages code inventory, symbols, and file-level metadata.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import type {
  RepositoryFile,
  CodeSymbol,
  ImportRelationship,
  ExportStatement,
  FileRelationship,
  CommitFileChange,
} from "./mission-control-graph";

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
  symbols: string; // JSON
  imports: string; // JSON
  exports: string; // JSON
  dependencies: string; // JSON
  dependents: string; // JSON
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
  sharedSymbols?: string; // JSON
  metadata?: string; // JSON
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
  changedSymbols?: string; // JSON
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

  // Analytics
  getHighRiskFiles(projectId: string, limit?: number): Promise<string[]>;
  getRecentChanges(projectId: string, limit?: number): Promise<CommitFileChange[]>;
  findRelatedFiles(projectId: string, filePath: string): Promise<string[]>;
}

/**
 * Open or create a durable repository file registry.
 */
export function openDurableRepositoryFileRegistry(
  path: string,
): DurableRepositoryFileRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-repository-files",
  });

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
        symbols: JSON.stringify(file.symbols),
        imports: JSON.stringify(file.imports),
        exports: JSON.stringify(file.exports),
        dependencies: JSON.stringify(file.dependencies),
        dependents: JSON.stringify(file.dependents),
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
        symbols: JSON.parse(row.symbols),
        imports: JSON.parse(row.imports),
        exports: JSON.parse(row.exports),
        dependencies: JSON.parse(row.dependencies),
        dependents: JSON.parse(row.dependents),
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
        symbols: JSON.parse(row.symbols),
        imports: JSON.parse(row.imports),
        exports: JSON.parse(row.exports),
        dependencies: JSON.parse(row.dependencies),
        dependents: JSON.parse(row.dependents),
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
        symbols: JSON.parse(row.symbols),
        imports: JSON.parse(row.imports),
        exports: JSON.parse(row.exports),
        dependencies: JSON.parse(row.dependencies),
        dependents: JSON.parse(row.dependents),
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
        symbols: JSON.stringify(file.symbols),
        imports: JSON.stringify(file.imports),
        exports: JSON.stringify(file.exports),
        dependencies: JSON.stringify(file.dependencies),
        dependents: JSON.stringify(file.dependents),
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
        sharedSymbols: relationship.sharedSymbols
          ? JSON.stringify(relationship.sharedSymbols)
          : undefined,
        metadata: relationship.metadata
          ? JSON.stringify(relationship.metadata)
          : undefined,
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
        sharedSymbols: row.sharedSymbols
          ? JSON.parse(row.sharedSymbols)
          : undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
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
        sharedSymbols: row.sharedSymbols
          ? JSON.parse(row.sharedSymbols)
          : undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
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
        sharedSymbols: relationship.sharedSymbols
          ? JSON.stringify(relationship.sharedSymbols)
          : undefined,
        metadata: relationship.metadata
          ? JSON.stringify(relationship.metadata)
          : undefined,
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
        changedSymbols: change.changedSymbols
          ? JSON.stringify(change.changedSymbols)
          : undefined,
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
        changedSymbols: row.changedSymbols
          ? JSON.parse(row.changedSymbols)
          : undefined,
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
        changedSymbols: row.changedSymbols
          ? JSON.parse(row.changedSymbols)
          : undefined,
        timestamp: row.timestamp,
      }));
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
          changedSymbols: row.changedSymbols
            ? JSON.parse(row.changedSymbols)
            : undefined,
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
