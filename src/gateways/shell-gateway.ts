export interface ShellGateway {
  runCommand(
    command: string,
    cwd: string,
    auditFile: string,
  ): Promise<{ exitCode: number; result: string }>;
}

async function runCommand(
  command: string,
  cwd: string,
  auditFile: string,
): Promise<{ exitCode: number; result: string }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  await Bun.write(auditFile, stdout + stderr);

  return { exitCode, result: stdout.trim() };
}

export function createShellGateway(): ShellGateway {
  return { runCommand };
}
