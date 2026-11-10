// Cooperative time slicing: long loops call tick() and give the event loop a turn every few
// milliseconds, so indexing never freezes the app (its UI server runs in the same process).

export function yieldNow(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export class Slicer {
  private t = performance.now();
  constructor(private budgetMs = 12) {}

  async tick(): Promise<void> {
    if (performance.now() - this.t < this.budgetMs) return;
    await yieldNow();
    this.t = performance.now();
  }
}
