/**
 * Background-safe timers. Browsers throttle main-thread setTimeout to >=1s in
 * hidden tabs; dedicated Worker timers are not throttled that way. We also hold
 * a Screen Wake Lock and a silent AudioContext while armed so the tab is not
 * frozen or deprioritised.
 */
type Cb = () => void;

let worker: Worker | null = null;
let nextId = 1;
const callbacks = new Map<number, Cb>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  const src = `
    const t = new Map();
    onmessage = (e) => {
      const { op, id, ms } = e.data;
      if (op === "set") t.set(id, setTimeout(() => { t.delete(id); postMessage(id); }, ms));
      else if (op === "clear") { clearTimeout(t.get(id)); t.delete(id); }
    };`;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = (e: MessageEvent<number>) => {
      const cb = callbacks.get(e.data);
      callbacks.delete(e.data);
      cb?.();
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function setPreciseTimeout(cb: Cb, ms: number): () => void {
  const w = getWorker();
  if (!w) {
    const t = setTimeout(cb, ms);
    return () => clearTimeout(t);
  }
  const id = nextId++;
  callbacks.set(id, cb);
  w.postMessage({ op: "set", id, ms: Math.max(0, ms) });
  return () => {
    callbacks.delete(id);
    w.postMessage({ op: "clear", id });
  };
}

export function setPreciseInterval(cb: Cb, ms: number): () => void {
  let cancel = () => {};
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    cb();
    cancel = setPreciseTimeout(tick, ms);
  };
  cancel = setPreciseTimeout(tick, ms);
  return () => {
    stopped = true;
    cancel();
  };
}

export const preciseSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (signal?.aborted) return rej(new DOMException("aborted", "AbortError"));
    const cancel = setPreciseTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      cancel();
      rej(new DOMException("aborted", "AbortError"));
    });
  });

/** Keep the tab awake & un-throttled while armed. Returns a release function. */
export async function holdAwake(): Promise<() => void> {
  let lock: { release: () => Promise<void> } | null = null;
  let ctx: AudioContext | null = null;
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    lock = (await nav.wakeLock?.request("screen")) ?? null;
  } catch {
    /* not supported / denied */
  }
  try {
    ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001; // inaudible; audible-playing tabs are exempt from intensive throttling
    osc.connect(gain).connect(ctx.destination);
    osc.start();
  } catch {
    ctx = null;
  }
  return () => {
    lock?.release().catch(() => {});
    ctx?.close().catch(() => {});
  };
}
