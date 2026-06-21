import { describe, expect, mock, test } from "bun:test";
import type { AgentRunner } from "../gateways/agent-runner.ts";
import type { FsGateway } from "../gateways/fs-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import type { ProfilesGateway } from "../gateways/profiles-gateway.ts";
import type { ShellGateway } from "../gateways/shell-gateway.ts";
import type { WorkerShimGateway } from "../gateways/worker-shim-gateway.ts";
import type { ClaimedItem } from "../store.ts";
import { callArgs, makeClaimedItem, typedMock } from "../test-helpers.ts";
import type { WorkerConfig } from "../worker-workflow.ts";
import {
  createCancellableSleep,
  runWorkerLoop,
  type WorkerLoopDeps,
  workerCommand,
} from "./worker-loop.ts";

const noop = mock(async () => {});

const HOPPER_HOME = "/tmp/test-hopper";

function makeStubProfilesGateway(): ProfilesGateway {
  return {
    configPath: () => "/tmp/config.json",
    profilesDir: () => "/tmp/profiles",
    profilePath: (n) => `/tmp/profiles/${n}.json`,
    listProfileNames: async () => ["test"],
    loadProfile: async (n) => ({
      ok: true,
      profile: {
        name: n,
        runner: "claude",
        models: {
          deep: { model: "opus" },
          balanced: { model: "sonnet" },
          fast: { model: "haiku" },
        },
      },
    }),
    loadAllProfiles: async () => ({ profiles: [], errors: [] }),
    loadConfig: async () => ({ defaultProfile: "test" }),
    writeConfig: async () => {},
    writeProfile: async () => {},
    bootstrap: async () => false,
  };
}

function makeGatewayDeps(): {
  git: GitGateway;
  claude: AgentRunner;
  fs: FsGateway;
  shell: ShellGateway;
  profiles: ProfilesGateway;
} {
  return {
    git: {} as GitGateway,
    claude: {} as AgentRunner,
    fs: {} as FsGateway,
    shell: {} as ShellGateway,
    profiles: makeStubProfilesGateway(),
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
      requeueIfStillClaimed: noop,
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
      requeueIfStillClaimed: noop,
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
      requeueIfStillClaimed: noop,
    };

    await runWorkerLoop(
      makeContinuousConfig({ pollInterval: 30 }),
      HOPPER_HOME,
      makeGatewayDeps(),
      loopDeps,
    );

    // Sleep was called with the correct poll interval (in ms)
    expect(typedMock(loopDeps.sleep)).toHaveBeenCalledWith(30 * 1000);

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
        async () =>
          new Promise<void>((resolve) => {
            resolveProcessItem = resolve;
          }),
      ),
      sleep: mock(async () => ({ cancelled: false })),
      log: (msg) => logs.push(msg),
      onSignal: mock((_signal: "SIGINT" | "SIGTERM", handler: () => void) => {
        shutdownHandler = handler;
      }),
      requeueIfStillClaimed: noop,
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

  test("processItem rejects → requeueIfStillClaimed called with item id and error reason; loop continues", async () => {
    const item = makeClaimedItem();
    const requeueIfStillClaimed = mock(async (_id: string, _reason: string, _agent: string) => {});
    const logs: string[] = [];

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => item),
      processItem: mock(async () => {
        throw new Error("process exploded");
      }),
      sleep: mock(async () => ({ cancelled: false })),
      log: (msg) => logs.push(msg),
      onSignal: mock(() => {}),
      requeueIfStillClaimed,
    };

    await runWorkerLoop(makeRunOnceConfig(), HOPPER_HOME, makeGatewayDeps(), loopDeps);

    expect(requeueIfStillClaimed).toHaveBeenCalledTimes(1);
    const [calledId, reason] = callArgs(requeueIfStillClaimed, 0);
    expect(calledId).toBe(item.id);
    expect(reason).toContain("process exploded");
  });

  test("requeueIfStillClaimed rejects → loop logs the failure and does NOT crash", async () => {
    const item = makeClaimedItem();
    const logs: string[] = [];

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => item),
      processItem: mock(async () => {
        throw new Error("initial error");
      }),
      sleep: mock(async () => ({ cancelled: false })),
      log: (msg) => logs.push(msg),
      onSignal: mock(() => {}),
      requeueIfStillClaimed: mock(async () => {
        throw new Error("requeue itself failed");
      }),
    };

    // Should resolve without throwing even though requeueIfStillClaimed throws
    await expect(
      runWorkerLoop(makeRunOnceConfig(), HOPPER_HOME, makeGatewayDeps(), loopDeps),
    ).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Step 1 — Concurrent slot exhaustion
  // ---------------------------------------------------------------------------

  test("slot exhaustion: loop waits at concurrency=2 before claiming a 3rd item", async () => {
    const resolvers: Array<() => void> = [];
    const items = [
      makeClaimedItem({ id: "11111111-1111-1111-1111-111111111111" }),
      makeClaimedItem({ id: "22222222-2222-2222-2222-222222222222" }),
      makeClaimedItem({ id: "33333333-3333-3333-3333-333333333333" }),
    ];
    let itemIdx = 0;
    let shutdownHandler: (() => void) | undefined;

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => {
        if (itemIdx < items.length) return items[itemIdx++];
        return null;
      }),
      processItem: mock(async () => {
        await new Promise<void>((resolve) => resolvers.push(resolve));
      }),
      sleep: mock(async () => {
        shutdownHandler?.();
        return { cancelled: true };
      }),
      log: () => {},
      onSignal: mock((_signal, handler) => {
        shutdownHandler = handler;
      }),
      requeueIfStillClaimed: noop,
    };

    const loopPromise = runWorkerLoop(
      makeContinuousConfig({ concurrency: 2 }),
      HOPPER_HOME,
      makeGatewayDeps(),
      loopDeps,
    );

    // Wait until both concurrency slots are filled
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (resolvers.length >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });

    // Both slots full: 3rd item must NOT yet have been claimed
    expect(typedMock(loopDeps.claimNext).mock.calls.length).toBe(2);

    // Free one slot
    resolvers[0]?.();

    // Wait for the 3rd item to be claimed after the slot freed
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (resolvers.length >= 3) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });

    expect(typedMock(loopDeps.claimNext).mock.calls.length).toBeGreaterThanOrEqual(3);

    // Drain remaining tasks so the loop can exit
    for (const r of resolvers) r();
    await loopPromise;
  });

  test("slot exhaustion: active task count never exceeds concurrency=2", async () => {
    let activeCount = 0;
    let maxActiveObserved = 0;
    const resolvers: Array<() => void> = [];
    const items = [
      makeClaimedItem({ id: "11111111-1111-1111-1111-111111111111" }),
      makeClaimedItem({ id: "22222222-2222-2222-2222-222222222222" }),
      makeClaimedItem({ id: "33333333-3333-3333-3333-333333333333" }),
    ];
    let itemIdx = 0;
    let shutdownHandler: (() => void) | undefined;

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => {
        if (itemIdx < items.length) return items[itemIdx++];
        return null;
      }),
      processItem: mock(async () => {
        activeCount++;
        if (activeCount > maxActiveObserved) maxActiveObserved = activeCount;
        await new Promise<void>((resolve) => resolvers.push(resolve));
        activeCount--;
      }),
      sleep: mock(async () => {
        shutdownHandler?.();
        return { cancelled: true };
      }),
      log: () => {},
      onSignal: mock((_signal, handler) => {
        shutdownHandler = handler;
      }),
      requeueIfStillClaimed: noop,
    };

    const loopPromise = runWorkerLoop(
      makeContinuousConfig({ concurrency: 2 }),
      HOPPER_HOME,
      makeGatewayDeps(),
      loopDeps,
    );

    // Wait for all 3 tasks to start, resolving them one at a time
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (resolvers.length >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });

    resolvers[0]?.();

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (resolvers.length >= 3) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });

    for (const r of resolvers) r();
    await loopPromise;

    expect(maxActiveObserved).toBeLessThanOrEqual(2);
    expect(loopDeps.processItem).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------------------
  // Step 2 — Sleep cancellation and shutdown-during-claim tests
  // ---------------------------------------------------------------------------

  test("createCancellableSleep: cancel() resolves the promise immediately with {cancelled:true}", async () => {
    const { sleep, cancel } = createCancellableSleep();
    const promise = sleep(60_000);
    cancel();
    const result = await promise;
    expect(result).toEqual({ cancelled: true });
  });

  test("SIGINT during slow claimNext: loop exits after the in-flight claim completes", async () => {
    let resolveClaimNext: ((item: ClaimedItem | null) => void) | undefined;
    let shutdownHandler: (() => void) | undefined;
    const logs: string[] = [];

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(
        async () =>
          new Promise<ClaimedItem | null>((resolve) => {
            resolveClaimNext = resolve;
          }),
      ),
      processItem: mock(async () => {}),
      sleep: mock(async () => ({ cancelled: false })),
      log: (msg) => logs.push(msg),
      onSignal: mock((_signal, handler) => {
        shutdownHandler = handler;
      }),
      requeueIfStillClaimed: noop,
    };

    const loopPromise = runWorkerLoop(
      makeContinuousConfig(),
      HOPPER_HOME,
      makeGatewayDeps(),
      loopDeps,
    );

    // Wait until claimNext is pending
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (resolveClaimNext) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });

    // Trigger shutdown while claimNext is still awaiting
    shutdownHandler?.();

    // Release claimNext with null (no item) so the loop can proceed
    resolveClaimNext?.(null);

    await loopPromise;

    // Loop exited; no items were processed
    expect(loopDeps.processItem).not.toHaveBeenCalled();
    const shutdownLog = logs.find((l) => l.includes("Shutting down"));
    expect(shutdownLog).toBeDefined();
  });

  test("double SIGINT: no crash and only one shutdown message logged", async () => {
    let shutdownHandler: (() => void) | undefined;
    const logs: string[] = [];

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => null),
      processItem: mock(async () => {}),
      sleep: mock(async () => {
        // Fire the shutdown handler twice during the sleep
        shutdownHandler?.();
        shutdownHandler?.();
        return { cancelled: true };
      }),
      log: (msg) => logs.push(msg),
      onSignal: mock((_signal, handler) => {
        shutdownHandler = handler;
      }),
      requeueIfStillClaimed: noop,
    };

    await expect(
      runWorkerLoop(makeContinuousConfig(), HOPPER_HOME, makeGatewayDeps(), loopDeps),
    ).resolves.toBeUndefined();

    const shutdownLogs = logs.filter((l) => l.includes("Shutting down"));
    expect(shutdownLogs).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Step 3 — Shutdown timeout
  // ---------------------------------------------------------------------------

  test("shutdown timeout: loop resolves even when active tasks never complete", async () => {
    // Design: claim 2 items (never-resolving tasks) with concurrency=3.
    // After the 3rd claim returns null, the loop sleeps. The sleep mock fires
    // shutdown, loop exits the while, then the shutdown timeout (10 ms) fires
    // because the 2 active tasks never settle.
    const items = [
      makeClaimedItem({ id: "11111111-1111-1111-1111-111111111111" }),
      makeClaimedItem({ id: "22222222-2222-2222-2222-222222222222" }),
    ];
    let itemIdx = 0;
    let shutdownHandler: (() => void) | undefined;
    const logs: string[] = [];

    const loopDeps: WorkerLoopDeps = {
      claimNext: mock(async () => {
        if (itemIdx < items.length) return items[itemIdx++];
        return null;
      }),
      processItem: mock(async () => new Promise<void>(() => {})), // never resolves
      sleep: mock(async () => {
        shutdownHandler?.();
        return { cancelled: true };
      }),
      log: (msg) => logs.push(msg),
      onSignal: mock((_signal, handler) => {
        shutdownHandler = handler;
      }),
      requeueIfStillClaimed: noop,
    };

    const config: WorkerConfig = {
      agentName: "test-agent",
      pollInterval: 60,
      runOnce: false,
      concurrency: 3, // more than available items so the loop hits sleep
      shutdownTimeoutMs: 10,
    };

    await runWorkerLoop(config, HOPPER_HOME, makeGatewayDeps(), loopDeps);

    const timeoutLog = logs.find((l) => l.includes("shutdown timeout reached"));
    expect(timeoutLog).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// workerCommand — Windows shim skip warning
// ---------------------------------------------------------------------------

describe("workerCommand", () => {
  test("workerShim returning skipped-windows logs the PATH shims warning via log", async () => {
    const logs: string[] = [];

    const workerShim: WorkerShimGateway = {
      synchronize: mock(async () => ({ status: "skipped-windows" as const })),
    };

    const profiles: ProfilesGateway = {
      ...makeStubProfilesGateway(),
      bootstrap: mock(async () => false),
    };

    await workerCommand(
      { command: "worker", positional: [], flags: { once: true }, arrayFlags: {} },
      {
        log: (msg) => logs.push(msg),
        claimNext: async () => null,
        workerShim,
        profiles,
        claude: {} as AgentRunner,
        git: {} as GitGateway,
        fs: {} as FsGateway,
        shell: {} as ShellGateway,
      },
    );

    expect(logs.some((l) => l.includes("PATH shims are POSIX-only"))).toBe(true);
  });
});
