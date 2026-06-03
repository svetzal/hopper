export function resolveBinOnPath(name: string, installHint: string): string {
  const resolved = Bun.which(name, { PATH: process.env.PATH });
  if (!resolved) {
    throw new Error(`${name} executable not found on PATH. ${installHint}`);
  }
  return resolved;
}
