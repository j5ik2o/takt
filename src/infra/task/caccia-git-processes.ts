import { execFileSync, type ChildProcess } from 'node:child_process';

interface ProcessEntry {
  pid: number;
  parent: number;
  group: number;
  started: string;
}

const exitWait = new Int32Array(new SharedArrayBuffer(4));
const cloneProcesses = new Map<string, Set<OwnedGitProcess>>();

function processTable(): ProcessEntry[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 1_000, killSignal: 'SIGKILL',
  }).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match || match[4]!.startsWith('Z')) return [];
    return [{
      pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]),
      started: match[5]!,
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

function rememberTree(rootPid: number, table: ProcessEntry[], members: Map<number, string>): void {
  const parents = new Set([rootPid, ...table.filter(({ pid, started }) => members.get(pid) === started).map(({ pid }) => pid)]);
  let foundParent = true;
  while (foundParent) {
    foundParent = false;
    for (const { pid, parent, started } of table) {
      if (!parents.has(pid) && parents.has(parent)) {
        members.set(pid, started);
        parents.add(pid);
        foundParent = true;
      }
    }
  }
}

class OwnedGitProcess {
  private readonly members = new Map<number, string>();
  private closed = false;
  private groupInspectionError: unknown;
  private watch: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly child: ChildProcess, private readonly group: boolean, private readonly pid: number) {
    if (!group && process.platform !== 'win32') {
      // A terminal commit shares our group. Track only its own children.
      this.watch = setInterval(() => {
        try { rememberTree(pid, processTable(), this.members); } catch { /* Cleanup retries the snapshot. */ }
      }, 100);
      this.watch.unref();
    }
  }

  signal(signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      this.child.kill(signal);
    } else if (this.group) {
      signalPid(-this.pid, signal);
    } else {
      this.signalTree(this.remaining(processTable()), signal);
    }
  }

  private signalTree(entries: ProcessEntry[], signal: NodeJS.Signals): void {
    // Stop the leader first so it cannot start more children while they are signalled.
    if (!this.closed) this.child.kill(signal);
    for (const { pid } of entries) {
      if (pid !== this.pid) signalPid(pid, signal);
    }
  }

  onLeaderExit(): boolean {
    this.stopWatch();
    this.closed = true;
    if (process.platform === 'win32') return true;
    if (this.group) {
      try {
        process.kill(-this.pid, 0);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
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
    return this.members.size === 0;
  }

  stopWatch(): void {
    if (this.watch !== undefined) clearInterval(this.watch);
  }

  remaining(table: ProcessEntry[]): ProcessEntry[] {
    if (this.group) {
      const members = table.filter(({ group }) => group === this.pid);
      if (members.length > 0 && this.groupInspectionError !== undefined) {
        throw new Error(`Could not identify Caccia Git process group ${this.pid}`, { cause: this.groupInspectionError });
      }
      return !this.closed || members.some(({ pid, started }) => this.members.get(pid) === started) ? members : [];
    }
    if (!this.closed) rememberTree(this.pid, table, this.members);
    return table.filter(({ pid, started }) => (!this.closed && pid === this.pid) || this.members.get(pid) === started);
  }

  kill(entries: ProcessEntry[]): void {
    if (process.platform === 'win32') {
      if (!this.closed) this.child.kill('SIGKILL');
    } else if (entries.length > 0) {
      if (this.group) {
        // Preserve the identities we observed even if the leader is reaped during cleanup.
        for (const { pid, started } of entries) this.members.set(pid, started);
        signalPid(-this.pid, 'SIGKILL');
      } else {
        this.signalTree(entries, 'SIGKILL');
      }
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
        child.stopWatch();
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

export function trackCacciaCloneGit(cwd: string, child: ChildProcess, detached: boolean): ((signal: NodeJS.Signals) => void) | undefined {
  const children = cloneProcesses.get(cwd);
  if (children === undefined || child.pid === undefined) return undefined;
  const owned = new OwnedGitProcess(child, detached, child.pid);
  children.add(owned);
  child.once('exit', () => {
    try {
      if (owned.onLeaderExit()) children.delete(owned);
    } catch {
      // Retain ownership so teardown can report a failed process check.
    }
  });
  return (signal) => { if (children.has(owned)) owned.signal(signal); };
}
