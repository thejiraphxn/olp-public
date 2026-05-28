import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TempDir, Workspace } from '../../domain/ports/Workspace.js';

class OsTempDir implements TempDir {
  constructor(public readonly dir: string) {}

  pathOf(filename: string): string {
    return path.join(this.dir, filename);
  }

  async cleanup(): Promise<void> {
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }
}

export class OsTmpWorkspace implements Workspace {
  async create(prefix: string): Promise<TempDir> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
    return new OsTempDir(dir);
  }
}
