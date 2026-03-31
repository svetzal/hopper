import { mkdir, rm } from "node:fs/promises";

export interface InitGateway {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rmrf(path: string): Promise<void>;
}

export function createInitGateway(): InitGateway {
  return {
    async exists(path: string): Promise<boolean> {
      return Bun.file(path).exists();
    },
    async readText(path: string): Promise<string> {
      return Bun.file(path).text();
    },
    async writeFile(path: string, content: string): Promise<void> {
      await Bun.write(path, content);
    },
    async mkdirp(path: string): Promise<void> {
      await mkdir(path, { recursive: true });
    },
    async rmrf(path: string): Promise<void> {
      await rm(path, { recursive: true });
    },
  };
}
