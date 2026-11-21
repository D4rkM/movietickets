import { EventEmitter } from "node:events";
import { settleWithin, shutdownOnSignal, SignalProcess } from "./shutdown-on-signal";

class FakeProcess extends EventEmitter implements SignalProcess {
  pid = 1234;
  kill = jest.fn();
  exit = jest.fn();
}

/** Lets pending promise callbacks (and fake timers, if any) run. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

describe("shutdownOnSignal", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("should flush telemetry and re-raise the signal when nobody else listens to it", async () => {
    // ARRANGE
    const proc = new FakeProcess();
    const shutdown = jest.fn().mockResolvedValue(undefined);
    shutdownOnSignal(shutdown, { proc });

    // ACT
    proc.emit("SIGTERM");
    await flushPromises();

    // ASSERT
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith(1234, "SIGTERM");
    expect(proc.exit).toHaveBeenCalledWith(143);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("should not re-raise the signal when another listener (e.g. Nest) handles shutdown", async () => {
    // ARRANGE
    const proc = new FakeProcess();
    const nestListener = jest.fn();
    proc.on("SIGINT", nestListener);
    shutdownOnSignal(jest.fn().mockResolvedValue(undefined), { proc });

    // ACT
    proc.emit("SIGINT");
    await flushPromises();

    // ASSERT
    expect(nestListener).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it("should give up waiting for a hung shutdown after the timeout", async () => {
    // ARRANGE
    jest.useFakeTimers();
    const proc = new FakeProcess();
    shutdownOnSignal(() => new Promise(() => undefined), { proc, timeoutMs: 5000 });

    // ACT
    proc.emit("SIGTERM");
    await flushPromises();
    const killedBeforeTimeout = proc.kill.mock.calls.length;
    await jest.advanceTimersByTimeAsync(5000);

    // ASSERT
    expect(killedBeforeTimeout).toBe(0);
    expect(proc.kill).toHaveBeenCalledWith(1234, "SIGTERM");
  });

  it("should still re-raise the signal when shutdown rejects", async () => {
    // ARRANGE
    const proc = new FakeProcess();
    shutdownOnSignal(() => Promise.reject(new Error("exporter down")), { proc });

    // ACT
    proc.emit("SIGINT");
    await flushPromises();

    // ASSERT
    expect(proc.kill).toHaveBeenCalledWith(1234, "SIGINT");
    expect(proc.exit).toHaveBeenCalledWith(130);
  });
});

describe("settleWithin", () => {
  it("should resolve as soon as the work settles", async () => {
    // ARRANGE
    const work = Promise.resolve("done");

    // ACT
    const result = settleWithin(work, 60_000);

    // ASSERT
    await expect(result).resolves.toBeUndefined();
  });
});
