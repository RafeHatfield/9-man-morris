import { describe, expect, it } from 'vitest';

import { SingleFlight } from './singleFlight';

/** A promise the test resolves by hand, so two calls can genuinely overlap. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SingleFlight', () => {
  it('drops a call made while a task is running', async () => {
    const gate = new SingleFlight();
    const gate1 = deferred();
    let started = 0;

    const first = gate.run(async () => {
      started += 1;
      await gate1.promise;
    });

    // The second tap, while the first request is still out.
    await gate.run(async () => {
      started += 1;
    });
    expect(started).toBe(1);

    gate1.resolve();
    await first;
  });

  it('runs the next call once the first has finished', async () => {
    const gate = new SingleFlight();
    let runs = 0;
    await gate.run(async () => {
      runs += 1;
    });
    await gate.run(async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
  });

  it('releases the gate when a task throws, and passes the failure on', async () => {
    const gate = new SingleFlight();
    await expect(
      gate.run(() => Promise.reject(new Error('network'))),
    ).rejects.toThrow('network');

    let ran = false;
    await gate.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
