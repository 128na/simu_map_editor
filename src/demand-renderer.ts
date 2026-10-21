interface RenderOptions {
  update: (seconds: number) => boolean;
  render: () => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

/** Draw on invalidation, continuing only while camera/input motion changes the scene. */
export class DemandRenderer {
  private frame: number | null = null;
  private dirty = false;
  private suspended = false;
  private disposed = false;
  private previous: number | undefined;
  private readonly request: (callback: FrameRequestCallback) => number;
  private readonly cancel: (id: number) => void;

  private readonly options: RenderOptions;

  constructor(options: RenderOptions) {
    this.options = options;
    this.request = options.requestFrame ?? (callback => requestAnimationFrame(callback));
    this.cancel = options.cancelFrame ?? (id => cancelAnimationFrame(id));
  }

  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (!this.suspended && !this.disposed && this.frame === null) this.frame = this.request(this.tick);
  }

  private readonly tick = (time: number): void => {
    this.frame = null;
    const requested = this.dirty;
    this.dirty = false;
    const seconds = this.previous === undefined ? 1 / 60 : Math.min(.05, Math.max(0, (time - this.previous) / 1000));
    this.previous = time;
    const moving = this.options.update(seconds);
    if (requested || moving) this.options.render();
    if (moving || this.dirty) this.schedule();
    else this.previous = undefined;
  };

  setSuspended(value: boolean): void {
    if (this.disposed || this.suspended === value) return;
    this.suspended = value;
    this.previous = undefined;
    if (value) {
      if (this.frame !== null) this.cancel(this.frame);
      this.frame = null;
    } else this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
  }
}
