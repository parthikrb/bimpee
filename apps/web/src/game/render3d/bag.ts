/** Collects GPU resources so a whole renderer can be torn down in one call. */
export interface Disposable {
  dispose(): void;
}

export class Bag {
  private items: Disposable[] = [];
  private disposed = false;

  track<T extends Disposable>(x: T): T {
    if (this.disposed) {
      // created after teardown (async init racing destroy): free immediately
      try {
        x.dispose();
      } catch {
        /* ignore */
      }
      return x;
    }
    this.items.push(x);
    return x;
  }

  /** Register a plain teardown callback (listeners, observers...). */
  add(fn: () => void) {
    this.track({ dispose: fn });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i]!.dispose();
      } catch {
        /* keep going: one bad resource must not leak the rest */
      }
    }
    this.items = [];
  }

  get isDisposed() {
    return this.disposed;
  }
}
