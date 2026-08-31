/**
 * Comprehensive tests for PR 6: Repository Intelligence Graph.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { randomUUIDv7 } from "bun";

import {
  openDurableRepositoryFileRegistry,
  type DurableRepositoryFileRegistry,
} from "./durable-repository-file-registry";
import { createGraphAnalyzer, type GraphAnalyzerInterface } from "./graph-analyzer";
import {
  createTaskCodeContextManager,
  type TaskCodeContextManagerInterface,
} from "./task-code-context";
import type { RepositoryFile, FileRelationship, CommitFileChange } from "./mission-control-graph";
import { testFeltDb } from "./test-feltdb";

let testCounter = 0;
let testDir: string;
let fileRegistry: DurableRepositoryFileRegistry;
let analyzer: GraphAnalyzerInterface;
let contextManager: TaskCodeContextManagerInterface;

const prefix = "mc-graph-test";

beforeEach(() => {
  testDir = `/tmp/${prefix}-${Date.now()}-${testCounter++}`;
  fs.mkdirSync(testDir, { recursive: true });

  fileRegistry = openDurableRepositoryFileRegistry(
    path.join(testDir, "files.db"),
  );
  analyzer = createGraphAnalyzer(fileRegistry);
  contextManager = createTaskCodeContextManager(
    testFeltDb(path.join(testDir, "context.db")),
  );
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Repository File Registry Tests
// ============================================================================

describe("DurableRepositoryFileRegistry", () => {
  it("should create and retrieve a repository file", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const file: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath: "src/utils/helpers.ts",
      fileType: "source",
      language: "typescript",
      size: 1024,
      lines: 45,
      symbols: [
        {
          id: `sym-${randomUUIDv7()}`,
          name: "formatDate",
          kind: "function",
          filePath: "src/utils/helpers.ts",
          line: 10,
          column: 1,
          isExported: true,
        },
      ],
      imports: [],
      exports: [
        {
          id: `exp-${randomUUIDv7()}`,
          filePath: "src/utils/helpers.ts",
          exportType: "named",
          symbols: ["formatDate"],
          lineNumber: 10,
        },
      ],
      dependencies: [],
      dependents: [],
      testCoverage: 95,
      lastAnalyzedAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
    };

    await fileRegistry.createFile(file);

    const retrieved = await fileRegistry.getFile(file.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.filePath).toBe("src/utils/helpers.ts");
    expect(retrieved?.language).toBe("typescript");
    expect(retrieved?.symbols.length).toBe(1);
  });

  it("should retrieve file by path", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const filePath = "src/index.ts";
    const file: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath,
      fileType: "source",
      language: "typescript",
      size: 512,
      lines: 25,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      dependents: [],
      lastAnalyzedAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
    };

    await fileRegistry.createFile(file);

    const retrieved = await fileRegistry.getFileByPath(projectId, filePath);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(file.id);
  });

  it("should list files by project", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const now = new Date().toISOString();

    const file1: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath: "src/app.ts",
      fileType: "source",
      language: "typescript",
      size: 1024,
      lines: 50,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      dependents: [],
      lastAnalyzedAt: now,
      lastModifiedAt: now,
    };

    const file2: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath: "test/app.test.ts",
      fileType: "test",
      language: "typescript",
      size: 2048,
      lines: 100,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      dependents: [],
      lastAnalyzedAt: now,
      lastModifiedAt: now,
    };

    await fileRegistry.createFile(file1);
    await fileRegistry.createFile(file2);

    const files = await fileRegistry.listFiles(projectId);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.map((f) => f.filePath)).toContain("src/app.ts");
    expect(files.map((f) => f.filePath)).toContain("test/app.test.ts");
  });

  it("should filter files by type", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const now = new Date().toISOString();

    const sourceFile: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath: "src/main.ts",
      fileType: "source",
      language: "typescript",
      size: 1024,
      lines: 50,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      dependents: [],
      lastAnalyzedAt: now,
      lastModifiedAt: now,
    };

    const testFile: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath: "test/main.test.ts",
      fileType: "test",
      language: "typescript",
      size: 512,
      lines: 30,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      dependents: [],
      lastAnalyzedAt: now,
      lastModifiedAt: now,
    };

    await fileRegistry.createFile(sourceFile);
    await fileRegistry.createFile(testFile);

    const sourceFiles = await fileRegistry.listFiles(projectId, "source");
    expect(sourceFiles.length).toBe(1);
    expect(sourceFiles[0].filePath).toBe("src/main.ts");
  });

  it("should create and query file relationships", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const relationship: FileRelationship = {
      id: `rel-${randomUUIDv7()}`,
      projectId,
      sourceFile: "src/app.ts",
      targetFile: "src/utils.ts",
      relationshipType: "imports",
      riskScore: 0.8,
      weight: 1.0,
    };

    await fileRegistry.createRelationship(relationship);

    const rels = await fileRegistry.getRelationshipsByFile(
      projectId,
      "src/app.ts",
    );
    expect(rels.length).toBeGreaterThan(0);
    expect(rels.some((r) => r.id === relationship.id)).toBe(true);
  });

  it("should record file changes from commits", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const commitSha = "abc123def456";

    const change: CommitFileChange = {
      id: `chg-${randomUUIDv7()}`,
      projectId,
      commitSha,
      filePath: "src/main.ts",
      changeType: "modified",
      additions: 10,
      deletions: 5,
      timestamp: new Date().toISOString(),
    };

    await fileRegistry.recordFileChange(change);

    const changes = await fileRegistry.getCommitChanges(projectId, commitSha);
    expect(changes.length).toBe(1);
    expect(changes[0].filePath).toBe("src/main.ts");
    expect(changes[0].additions).toBe(10);
  });

  it("should calculate file impact (dependents)", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const rel1: FileRelationship = {
      id: `rel-${randomUUIDv7()}`,
      projectId,
      sourceFile: "src/app.ts",
      targetFile: "src/utils.ts",
      relationshipType: "imports",
      riskScore: 0.5,
      weight: 1.0,
    };

    const rel2: FileRelationship = {
      id: `rel-${randomUUIDv7()}`,
      projectId,
      sourceFile: "src/components/button.ts",
      targetFile: "src/utils.ts",
      relationshipType: "imports",
      riskScore: 0.6,
      weight: 1.0,
    };

    await fileRegistry.createRelationship(rel1);
    await fileRegistry.createRelationship(rel2);

    const impact = await fileRegistry.getFileImpact(projectId, "src/utils.ts");
    expect(impact.length).toBe(2);
    expect(impact.map((r) => r.sourceFile)).toContain("src/app.ts");
  });

  it("should get high-risk files", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    // Create relationships with varying risk scores
    for (let i = 0; i < 5; i++) {
      const rel: FileRelationship = {
        id: `rel-${randomUUIDv7()}`,
        projectId,
        sourceFile: `src/file${i}.ts`,
        targetFile: `src/utils.ts`,
        relationshipType: "imports",
        riskScore: 0.1 * (i + 1),
        weight: 1.0,
      };
      await fileRegistry.createRelationship(rel);
    }

    const highRisk = await fileRegistry.getHighRiskFiles(projectId);
    expect(highRisk.length).toBeGreaterThan(0);
  });

  it("should find related files", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const rel1: FileRelationship = {
      id: `rel-${randomUUIDv7()}`,
      projectId,
      sourceFile: "src/app.ts",
      targetFile: "src/utils.ts",
      relationshipType: "imports",
      riskScore: 0.5,
      weight: 1.0,
    };

    const rel2: FileRelationship = {
      id: `rel-${randomUUIDv7()}`,
      projectId,
      sourceFile: "src/app.ts",
      targetFile: "src/config.ts",
      relationshipType: "imports",
      riskScore: 0.3,
      weight: 1.0,
    };

    await fileRegistry.createRelationship(rel1);
    await fileRegistry.createRelationship(rel2);

    const related = await fileRegistry.findRelatedFiles(projectId, "src/app.ts");
    expect(related.length).toBe(2);
    expect(related).toContain("src/utils.ts");
    expect(related).toContain("src/config.ts");
  });
});

// ============================================================================
// Graph Analyzer Tests
// ============================================================================

describe("GraphAnalyzer", () => {
  it("should analyze file risk", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const filePath = "src/utils.ts";
    const now = new Date().toISOString();

    const file: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath,
      fileType: "source",
      language: "typescript",
      size: 1024,
      lines: 50,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      dependents: [],
      testCoverage: 60,
      lastAnalyzedAt: now,
      lastModifiedAt: now,
    };

    await fileRegistry.createFile(file);

    const risk = await analyzer.analyzeFileRisk(projectId, filePath);
    expect(risk.filePath).toBe(filePath);
    expect(risk.estimatedTestCoverage).toBeLessThanOrEqual(60);
  });

  it("should analyze change impact", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const rel: FileRelationship = {
      id: `rel-${randomUUIDv7()}`,
      projectId,
      sourceFile: "src/app.ts",
      targetFile: "src/utils.ts",
      relationshipType: "imports",
      riskScore: 0.7,
      weight: 1.0,
    };

    await fileRegistry.createRelationship(rel);

    const impact = await analyzer.analyzeChangeImpact(projectId, ["src/utils.ts"]);
    expect(impact.directlyImpacted).toContain("src/app.ts");
    expect(impact.riskScore).toBeGreaterThan(0);
  });

  it("should get code language distribution", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const now = new Date().toISOString();

    const tsFile: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath: "src/main.ts",
      fileType: "source",
      language: "typescript",
      size: 1024,
      lines: 50,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      dependents: [],
      lastAnalyzedAt: now,
      lastModifiedAt: now,
    };

    const pyFile: RepositoryFile = {
      id: `file-${randomUUIDv7()}`,
      projectId,
      filePath: "scripts/build.py",
      fileType: "other",
      language: "python",
      size: 512,
      lines: 25,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      dependents: [],
      lastAnalyzedAt: now,
      lastModifiedAt: now,
    };

    await fileRegistry.createFile(tsFile);
    await fileRegistry.createFile(pyFile);

    const dist = await analyzer.getCodeLanguageDistribution(projectId);
    expect(dist.typescript).toBe(1);
    expect(dist.python).toBe(1);
  });
});

// ============================================================================
// Task Code Context Tests
// ============================================================================

describe("TaskCodeContextManager", () => {
  it("should set and get task context", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const context = {
      taskId,
      projectId,
      relevantFiles: [
        { path: "src/app.ts", relevance: 0.9, symbols: [], reason: "Test" },
      ],
      estimatedScope: "small" as const,
      complexity: "low" as const,
    };

    await contextManager.setContext(context);

    const retrieved = await contextManager.getContext(taskId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.relevantFiles.length).toBe(1);
    expect(retrieved?.relevantFiles[0].path).toBe("src/app.ts");
  });

  it("should link files to task", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    await contextManager.linkFilesToTask(taskId, projectId, [
      "src/app.ts",
      "src/utils.ts",
    ]);

    const context = await contextManager.getContext(taskId);
    expect(context).toBeDefined();
    expect(context?.relevantFiles.length).toBe(2);
    expect(context?.estimatedScope).toBe("small");
  });

  it("should unlink file from task", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    await contextManager.linkFilesToTask(taskId, projectId, [
      "src/app.ts",
      "src/utils.ts",
      "src/config.ts",
    ]);

    await contextManager.unlinkFileFromTask(taskId, "src/utils.ts");

    const context = await contextManager.getContext(taskId);
    expect(context?.relevantFiles.length).toBe(2);
    expect(context?.relevantFiles.map((f) => f.path)).not.toContain("src/utils.ts");
  });

  it("should delete task context", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const context = {
      taskId,
      projectId,
      relevantFiles: [],
      estimatedScope: "small" as const,
      complexity: "low" as const,
    };

    await contextManager.setContext(context);
    await contextManager.deleteContext(taskId);

    const retrieved = await contextManager.getContext(taskId);
    expect(retrieved).toBeUndefined();
  });
});
