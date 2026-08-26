/**
 * On-page GPU diagnostics: turns silent failures (black canvas) into readable
 * messages. Captures window errors, unhandled rejections, console errors
 * (three.js reports WebGPU validation failures there), device loss, and
 * uncaptured GPU errors. Auto-opens on the first captured problem; `?diag=1`
 * also shows adapter info immediately.
 */
export class Diag {
  /** Complete capture (uncapped) — bundled into debug reports. */
  readonly entries: string[] = [];
  private el: HTMLDivElement;
  private lines: string[] = [];
  private seen = new Set<string>();
  private capped = false;

  constructor(private verbose: boolean) {
    this.el = document.createElement('div');
    this.el.id = 'vw-diag';
    this.el.style.cssText =
      'position:fixed;left:8px;right:8px;bottom:8px;z-index:50;display:none;' +
      'background:rgba(120,20,20,0.92);color:#ffe;font:11px/1.5 ui-monospace,monospace;' +
      'padding:10px 12px;border-radius:8px;white-space:pre-wrap;word-break:break-word;max-height:45vh;overflow:auto;';
    document.body.appendChild(this.el);

    window.addEventListener('error', (e) => this.log('error', e.message ?? String(e)));
    window.addEventListener('unhandledrejection', (e) =>
      this.log('promise', String((e as PromiseRejectionEvent).reason).slice(0, 400)),
    );
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      origError(...args);
      this.log('console', args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 400));
    };
  }

  /** Informational line — shown only in verbose (?diag=1) mode. */
  info(msg: string): void {
    this.entries.push(`i ${new Date().toISOString().slice(11, 23)} ${msg}`);
    if (!this.verbose) return;
    this.push(`ℹ ${msg}`);
    this.el.style.background = 'rgba(20,40,70,0.92)';
    this.el.style.display = 'block';
  }

  log(tag: string, msg: string): void {
    if (this.entries.length < 400) {
      this.entries.push(`x ${new Date().toISOString().slice(11, 23)} [${tag}] ${msg}`);
    }
    if (this.capped) return;
    const key = `${tag}:${msg.slice(0, 80)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.push(`✖ [${tag}] ${msg}`);
    this.el.style.background = 'rgba(120,20,20,0.92)';
    this.el.style.display = 'block';
    if (this.lines.length >= 10) {
      this.push('… (further errors suppressed)');
      this.capped = true;
    }
  }

  private push(line: string): void {
    this.lines.push(line);
    this.el.textContent = this.lines.join('\n');
  }

  /** Hook GPU device fault channels once the renderer is up. */
  attachDevice(device: GPUDevice | undefined, adapterDesc: string): void {
    this.info(`adapter: ${adapterDesc}`);
    if (!device) return;
    device.lost?.then((info) => this.log('device-lost', `${info.reason ?? ''} ${info.message ?? ''}`));
    try {
      (device as unknown as EventTarget).addEventListener?.('uncapturederror', (ev) => {
        const e = ev as unknown as { error?: { message?: string } };
        this.log('gpu', e.error?.message ?? 'uncaptured GPU error');
      });
    } catch {
      /* older UAs without the event */
    }
  }
}
