import { mkdir } from "node:fs/promises";

export interface FsGateway {
  ensureDir(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

export function createFsGateway(): FsGateway {
  return {
    ensureDir: async (path: string): Promise<void> => {
      await mkdir(path, { recursive: true });
    },
    writeFile: async (path: string, content: string): Promise<void> => {
      await Bun.write(path, content);
    },
  };
}
