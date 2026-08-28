/**
 * Filesystem observation service for Mission Control.
 *
 * Tracks file inventory, changes, and generates diffs.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

/**
 * File stat information.
 */
export interface FileStat {
  path: string;
  size: number;
  mtime: string;
  isDirectory: boolean;
  hash?: string;
}

/**
 * File change event.
 */
export interface FileChangeEvent {
  path: string;
  type: "added" | "modified" | "deleted";
  oldPath?: string; // for renames
  sizeBefore?: number;
  sizeAfter?: number;
  timestamp: string;
}

/**
 * Filesystem Observation Service
 */
export class FilesystemObserver {
  private rootPath: string;
  private inventory: Map<string, FileStat> = new Map();
  private ignorePatterns: Set<string> = new Set([
    "node_modules",
    ".git",
    ".vscode",
    "dist",
    "build",
    "coverage",
    ".env",
    ".DS_Store",
  ]);

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  /**
   * Add patterns to ignore (e.g., "node_modules", ".git").
   */
  addIgnorePattern(pattern: string): void {
    this.ignorePatterns.add(pattern);
  }

  /**
   * Scan filesystem and build initial inventory.
   */
  async scan(): Promise<FileStat[]> {
    this.inventory.clear();
    const files = await this.scanDirectory(this.rootPath);
    return files;
  }

  /**
   * Get current inventory.
   */
  getInventory(): FileStat[] {
    return Array.from(this.inventory.values());
  }

  /**
   * Detect changes since last inventory.
   */
  async detectChanges(): Promise<FileChangeEvent[]> {
    const newInventory = await this.scan();
    const changes: FileChangeEvent[] = [];

    const now = new Date().toISOString();

    // Check for added and modified files
    for (const file of newInventory) {
      const old = this.inventory.get(file.path);

      if (!old) {
        changes.push({
          path: file.path,
          type: "added",
          sizeAfter: file.size,
          timestamp: now,
        });
      } else if (old.hash !== file.hash || old.mtime !== file.mtime) {
        changes.push({
          path: file.path,
          type: "modified",
          sizeBefore: old.size,
          sizeAfter: file.size,
          timestamp: now,
        });
      }
    }

    // Check for deleted files
    for (const [path, old] of this.inventory) {
      const newFile = newInventory.find((f) => f.path === path);
      if (!newFile) {
        changes.push({
          path,
          type: "deleted",
          sizeBefore: old.size,
          timestamp: now,
        });
      }
    }

    // Update inventory
    this.inventory.clear();
    for (const file of newInventory) {
      this.inventory.set(file.path, file);
    }

    return changes;
  }

  /**
   * Read file content.
   */
  async readFile(filePath: string): Promise<string | null> {
    try {
      const fullPath = path.join(this.rootPath, filePath);
      const content = await fs.promises.readFile(fullPath, "utf-8");
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Write file content.
   */
  async writeFile(filePath: string, content: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.rootPath, filePath);
      const dir = path.dirname(fullPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(fullPath, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a file.
   */
  async deleteFile(filePath: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.rootPath, filePath);
      await fs.promises.unlink(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file hash (MD5).
   */
  private getFileHash(content: string): string {
    return createHash("md5").update(content).digest("hex");
  }

  /**
   * Check if path should be ignored.
   */
  private shouldIgnore(filePath: string): boolean {
    const relativePath = path.relative(this.rootPath, filePath);
    const parts = relativePath.split(path.sep);

    for (const part of parts) {
      for (const pattern of this.ignorePatterns) {
        if (part === pattern || part.startsWith(pattern)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Recursively scan directory.
   */
  private async scanDirectory(dirPath: string): Promise<FileStat[]> {
    const files: FileStat[] = [];

    try {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (this.shouldIgnore(fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.scanDirectory(fullPath);
          files.push(...subFiles);
        } else {
          try {
            const stat = await fs.promises.stat(fullPath);
            const content = await fs.promises.readFile(fullPath, "utf-8");
            const hash = this.getFileHash(content);
            const relativePath = path.relative(this.rootPath, fullPath);

            files.push({
              path: relativePath,
              size: stat.size,
              mtime: stat.mtime.toISOString(),
              isDirectory: false,
              hash,
            });

            this.inventory.set(relativePath, {
              path: relativePath,
              size: stat.size,
              mtime: stat.mtime.toISOString(),
              isDirectory: false,
              hash,
            });
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }

    return files;
  }
}

/**
 * Create a FilesystemObserver instance.
 */
export function createFilesystemObserver(rootPath: string): FilesystemObserver {
  return new FilesystemObserver(rootPath);
}
