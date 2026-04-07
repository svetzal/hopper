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
