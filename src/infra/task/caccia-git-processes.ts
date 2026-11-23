import { execFileSync } from 'node:child_process';

interface ProcessEntry {
  pid: number;
  group: number;
  started: string;
}

const exitWait = new Int32Array(new SharedArrayBuffer(4));
const cloneProcesses = new Map<string, Set<OwnedGitProcess>>();

function processTable(): ProcessEntry[] {
  return execFileSync('ps', ['-axo', 'pid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 1_000, killSignal: 'SIGKILL',
  }).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match || match[3]!.startsWith('Z')) return [];
    return [{
      pid: Number(match[1]), group: Number(match[2]), started: match[4]!,
    }];
  });
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

class OwnedGitProcess {
  private readonly members = new Map<number, string>();
  private closed = false;
  private groupInspectionError: unknown;
  constructor(private readonly pid: number, private readonly signalLeader: (signal: NodeJS.Signals) => unknown) {}

  signal(signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      if (!this.closed) this.signalLeader(signal);
    } else {
      if (this.remaining(processTable()).length > 0) signalPid(-this.pid, signal);
    }
  }

  onLeaderExit(): boolean {
    this.closed = true;
    if (process.platform === 'win32') return true;
    try {
      process.kill(-this.pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
      this.groupInspectionError = error;
      throw error;
    }
    let members: ProcessEntry[];
    try {
      members = processTable().filter(({ group }) => group === this.pid);
    } catch (error) {
      this.groupInspectionError = error;
      throw error;
    }
    // A live leader with this PID after our child exited belongs to a different group.
    if (members.some(({ pid }) => pid === this.pid)) return true;
    for (const { pid, started } of members) this.members.set(pid, started);
    return members.length === 0;
  }

  remaining(table: ProcessEntry[]): ProcessEntry[] {
    const members = table.filter(({ group }) => group === this.pid);
    if (members.length > 0 && this.groupInspectionError !== undefined) {
      throw new Error(`Could not identify Caccia Git process group ${this.pid}`, { cause: this.groupInspectionError });
    }
    return !this.closed || members.some(({ pid, started }) => this.members.get(pid) === started) ? members : [];
  }

  kill(entries: ProcessEntry[]): void {
    if (process.platform === 'win32') {
      if (!this.closed) this.signalLeader('SIGKILL');
    } else if (entries.length > 0) {
      // Preserve the identities we observed even if the leader is reaped during cleanup.
      for (const { pid, started } of entries) this.members.set(pid, started);
      signalPid(-this.pid, 'SIGKILL');
    }
  }
}

/** Own Git processes from allocation until the temporary clone is safe to remove. */
export function registerCacciaCloneGit(cwd: string): () => void {
  const children = new Set<OwnedGitProcess>();
  cloneProcesses.set(cwd, children);
  return () => {
    if (children.size > 0) {
      const table = process.platform === 'win32' ? [] : processTable();
      for (const child of children) {
        child.kill(child.remaining(table));
      }
      if (process.platform !== 'win32') {
        const deadline = performance.now() + 2_000;
        let remaining: ProcessEntry[];
        do {
          const current = processTable();
          remaining = [...children].flatMap((child) => child.remaining(current));
          if (remaining.length === 0) break;
          Atomics.wait(exitWait, 0, 0, 10);
        } while (performance.now() < deadline);
        if (remaining.length > 0) {
          throw new Error(`Caccia Git processes still running: ${remaining.map(({ pid }) => pid).join(', ')}`);
        }
      }
    }
    children.clear();
    cloneProcesses.delete(cwd);
  };
}

export function trackCacciaCloneGit(
  cwd: string, pid: number | undefined, signalLeader: (signal: NodeJS.Signals) => unknown, onExit: (callback: () => void) => void,
): ((signal: NodeJS.Signals) => void) | undefined {
  const children = cloneProcesses.get(cwd);
  if (children === undefined || pid === undefined) return undefined;
  const owned = new OwnedGitProcess(pid, signalLeader);
  children.add(owned);
  onExit(() => {
    try {
      if (owned.onLeaderExit()) children.delete(owned);
    } catch {
      // Retain ownership so teardown can report a failed process check.
    }
  });
  return (signal) => { if (children.has(owned)) owned.signal(signal); };
}
