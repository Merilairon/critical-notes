/**
 * Clean shutdown on SIGTERM and SIGINT (Task M3.7), whether or not scheduled backups are on. Kept apart from `main.ts` so it can
 * be tested without a global signal handler.
 *
 * First signal: stop accepting connections, close idle keep-alive connections, give in-flight requests a moment (`httpDrainMs`,
 * then the rest are cut), stop the scheduler and wait up to `backupWaitMs` (8 s) for a backup of this process (scheduled OR
 * started from the web page), close both databases, exit 0. An unfinished backup publishes nothing: its partial files and lock are
 * removed before exit (`abortBackup`). A second signal cannot do that; the age-based sweep at a later start covers it. A second signal exits at once (143 for SIGTERM, 130 for SIGINT).
 * A signal before the server is armed (still indexing) also exits at once: nothing is open yet that needs closing.
 * Handlers use `process.on`, never `once`, so that a second signal is seen when Node is PID 1 too.
 */

export interface ShutdownDeps {
  server: { close(cb?: (err?: Error) => void): unknown; closeIdleConnections?(): void; closeAllConnections?(): void };
  /** Tells every open event stream to reconnect (`bye: restart`) and ends it. Called first: an SSE connection is never idle. */
  closeStreams?: () => void;
  /** Stops the scheduler; resolves when its run in progress (if any) has ended. */
  stopScheduler: () => Promise<void>;
  /** True while this process runs a backup, from any trigger. */
  backupRunning: () => boolean;
  /** Called when a backup is still running after the wait: removes its partial files and lock (nothing is published). */
  abortBackup?: () => void;
  closeDatabases: () => void;
  log?: (message: string) => void;
  /** Longest wait for a running backup (default 8 s). */
  backupWaitMs?: number;
  /** In-flight requests get this long before their connections are cut (default 2 s). */
  httpDrainMs?: number;
}

export interface ShutdownOptions {
  exit?: (code: number) => void;
}

export const BACKUP_WAIT_MS = 8000;
export const HTTP_DRAIN_MS = 2000;
const POLL_MS = 25;

const forcedCode = (signal: NodeJS.Signals) => (signal === 'SIGINT' ? 130 : 143);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createShutdown(opts: ShutdownOptions = {}) {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let deps: ShutdownDeps | null = null;
  let stopping = false;

  async function run(d: ShutdownDeps): Promise<void> {
    const log = d.log ?? ((m: string) => console.log(m));
    const deadline = Date.now() + (d.backupWaitMs ?? BACKUP_WAIT_MS);
    let drained = false;
    try {
      d.closeStreams?.();
    } catch {
      // best effort; the drain timer cuts what is left
    }
    const drainTimer = setTimeout(() => {
      d.server.closeAllConnections?.();
      drained = true;
    }, d.httpDrainMs ?? HTTP_DRAIN_MS);
    try {
      d.server.close(() => {
        drained = true;
      });
      d.server.closeIdleConnections?.();
    } catch {
      drained = true; // not listening (yet or any more)
    }
    let schedulerDone = false;
    void d.stopScheduler().then(
      () => (schedulerDone = true),
      () => (schedulerDone = true),
    );
    let announced = false;
    while (Date.now() < deadline && !(drained && schedulerDone && !d.backupRunning())) {
      if (!announced && d.backupRunning()) {
        announced = true;
        log('Shutting down: waiting for the running backup to finish (up to 8 s)');
      }
      await sleep(POLL_MS);
    }
    clearTimeout(drainTimer);
    if (d.backupRunning()) {
      try {
        d.abortBackup?.();
      } catch {
        // best effort
      }
      log('Shutting down: the running backup did not finish in time; it was stopped, nothing was published and its partial files and lock were removed');
    }
    try {
      d.closeDatabases();
    } catch {
      // closing is best effort; the process exits right after
    }
    exit(0);
  }

  return {
    /** From now on a first signal runs the clean shutdown. */
    arm(d: ShutdownDeps): void {
      deps = d;
    },
    get stopping(): boolean {
      return stopping;
    },
    handle(signal: NodeJS.Signals): void {
      if (stopping || !deps) {
        exit(forcedCode(signal));
        return;
      }
      stopping = true;
      void run(deps).catch(() => exit(0));
    },
  };
}

/** Installs the SIGTERM and SIGINT handlers (`on`, so every signal is seen); returns a function that removes them. */
export function installSignalHandlers(shutdown: Pick<ReturnType<typeof createShutdown>, 'handle'>, proc: Pick<NodeJS.Process, 'on' | 'off'> = process): () => void {
  const onTerm = () => shutdown.handle('SIGTERM');
  const onInt = () => shutdown.handle('SIGINT');
  proc.on('SIGTERM', onTerm);
  proc.on('SIGINT', onInt);
  return () => {
    proc.off('SIGTERM', onTerm);
    proc.off('SIGINT', onInt);
  };
}
