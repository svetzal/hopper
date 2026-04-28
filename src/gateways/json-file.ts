import { mkdir } from "node:fs/promises";

export async function loadJsonFile<T>(
  filePath: string,
  transform?: (raw: unknown[]) => T[],
): Promise<T[]> {
  try {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const raw: unknown[] = await file.json();
      return transform ? transform(raw) : (raw as T[]);
    }
  } catch {
    // Corrupted or unreadable — start fresh
  }
  return [];
}

export async function saveJsonFile<T>(filePath: string, dir: string, data: T[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
