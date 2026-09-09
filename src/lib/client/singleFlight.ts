/**
 * One request at a time.
 *
 * Used twice: a slow poll must not stack up behind itself, and the second tap of
 * a double tap must not send a second action pinned to the same
 * `expectedVersion` (the first would win and the second come back 409). A call
 * made while a task is running is *dropped*, not queued — the second tap is a
 * duplicate, not a second intent.
 *
 * A ref rather than React state, because `setBusy(true)` lands a render too late
 * to stop the tap that is already on its way.
 */
export class SingleFlight {
  private busy = false;

  /**
   * Runs `task` unless one is already running. The gate is released even if the
   * task throws, and the rejection is passed on to the caller.
   */
  async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await task();
    } finally {
      this.busy = false;
    }
  }
}
