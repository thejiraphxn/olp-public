/**
 * Filesystem workspace abstraction. Use-cases ask for a scratch
 * directory; the concrete adapter handles `mkdtemp` / `rmSync`.
 *
 * Keeps `node:fs` / `node:os` / `node:path` out of the application
 * layer.
 */
export interface Workspace {
  /** Allocates an isolated temp directory. Caller MUST `cleanup()`. */
  create(prefix: string): Promise<TempDir>;
}

export interface TempDir {
  /** Absolute path of the scratch directory. */
  readonly dir: string;
  /** Returns an absolute path under `dir` for the given filename. */
  pathOf(filename: string): string;
  /** Recursively delete the workspace. Idempotent — safe to call twice. */
  cleanup(): Promise<void>;
}
