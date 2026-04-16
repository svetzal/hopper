import { describe, expect, mock, test } from "bun:test";
import type { ClaudeGateway } from "../gateways/claude-gateway.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import type { ClaimedItem } from "../store.ts";
import type { WorkerConfig } from "../worker-workflow.ts";
import { makeClaimedItem } from "./test-helpers.ts";
import { runWorkerLoop, type WorkerLoopDeps } from "./worker-loop.ts";

const HOPPER_HOME = "/tmp/test-hopper";

function makeGatewayDeps(): {
  git: GitGateway;
  claude: ClaudeGateway;
  fs: FsGateway;
  shell: ShellGateway;
} {
  return {
    git: {} as GitGateway,
    claude: {} as ClaudeGateway,
    fs: {} as FsGateway,
    shell: {} as ShellGateway,
  };
}

function makeRunOnceConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return {
    agentName: "test-agent",
    pollInterval: 60,
    runOnce: true,
    concurrency: 1,
    ...overrides,
  };
}

function makeContinuousConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return {
    agentName: "test-agent",
    pollInterval: 60,
    runOnce: false,
    concurrency: 1,
    ...overrides,
  };
}

describe("runWorkerLoop", () => {
  test("run-once with no work available: claims once, logs 'No work available.', exits", async () => {
    const logs: string[] = [];
    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => null),
      processItem: mock(async () => {}),
      sleep: mock(async () => ({ cancelled: false })),
      log: (msg) => logs.push(msg),
      onSignal: mock(() => {}),
    };

    await runWorkerLoop(makeRunOnceConfig(), HOPPER_HOME, makeGatewayDeps(), loopDeps);

    expect(loopDeps.claimNext).toHaveBeenCalledTimes(1);
    expect(loopDeps.processItem).not.toHaveBeenCalled();
    expect(logs).toContain("No work available.");
  });

  test("run-once with work available: claims one item, processes it, exits", async () => {
    const item = makeClaimedItem();
    const logs: string[] = [];
    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => item),
      processItem: mock(async () => {}),
      sleep: mock(async () => ({ cancelled: false })),
      log: (msg) => logs.push(msg),
      onSignal: mock(() => {}),
    };

    await runWorkerLoop(makeRunOnceConfig(), HOPPER_HOME, makeGatewayDeps(), loopDeps);

    expect(loopDeps.claimNext).toHaveBeenCalledTimes(1);
    expect(loopDeps.processItem).toHaveBeenCalledTimes(1);
    expect(loopDeps.sleep).not.toHaveBeenCalled();
  });

  test("continuous mode with no work: sleeps for pollInterval ms, then SIGINT stops the loop", async () => {
    let shutdownHandler: (() => void) | undefined;
    const logs: string[] = [];

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => null),
      processItem: mock(async () => {}),
      sleep: mock(async (_ms: number) => {
        // Trigger shutdown from within the sleep so the loop exits after waking
        shutdownHandler?.();
        return { cancelled: true };
      }),
      log: (msg) => logs.push(msg),
      onSignal: mock((_signal: "SIGINT" | "SIGTERM", handler: () => void) => {
        shutdownHandler = handler;
      }),
    };

    await runWorkerLoop(
      makeContinuousConfig({ pollInterval: 30 }),
      HOPPER_HOME,
      makeGatewayDeps(),
      loopDeps,
    );

    // Sleep was called with the correct poll interval (in ms)
    const sleepMock = loopDeps.sleep as ReturnType<typeof mock>;
    expect(sleepMock).toHaveBeenCalledWith(30 * 1000);

    // After waking from sleep, shutdown was triggered so the loop exited
    const shutdownLog = logs.find((l) => l.includes("Shutting down"));
    expect(shutdownLog).toBeDefined();
  });

  test("SIGINT triggers graceful shutdown: loop stops after current tasks finish", async () => {
    let shutdownHandler: (() => void) | undefined;
    const logs: string[] = [];
    let resolveProcessItem: (() => void) | undefined;

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => makeClaimedItem()),
      processItem: mock(
        async (_item: ClaimedItem) =>
          new Promise<void>((resolve) => {
            resolveProcessItem = resolve;
          }),
      ),
      sleep: mock(async () => ({ cancelled: false })),
      log: (msg) => logs.push(msg),
      onSignal: mock((_signal: "SIGINT" | "SIGTERM", handler: () => void) => {
        shutdownHandler = handler;
      }),
    };

    const loopPromise = runWorkerLoop(
      makeContinuousConfig(),
      HOPPER_HOME,
      makeGatewayDeps(),
      loopDeps,
    );

    // Wait until processItem is in-flight
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (resolveProcessItem) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });

    // Send SIGINT — loop should stop trying to claim more work
    shutdownHandler?.();

    // Allow the in-flight task to complete
    resolveProcessItem?.();

    await loopPromise;

    // processItem ran exactly once (no second claim after shutdown)
    expect(loopDeps.processItem).toHaveBeenCalledTimes(1);
    const shutdownLog = logs.find((l) => l.includes("Shutting down"));
    expect(shutdownLog).toBeDefined();
  });
});
