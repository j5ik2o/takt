import { execFileSync } from 'node:child_process';

interface ProcessEntry {
  pid: number;
  group: number;
  started: string;
}

const exitWait = new Int32Array(new SharedArrayBuffer(4));
const cloneProcesses = new Map<string, Set<OwnedGitProcess>>();

function inspectProcesses(file: string): string {
  return execFileSync(file, ['-axo', 'pid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 1_000, killSignal: 'SIGKILL',
  });
}

function processTable(): ProcessEntry[] {
  let output: string;
  try {
    output = inspectProcesses('ps');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    output = inspectProcesses('/bin/ps');
  }
  return output.split('\n').flatMap((line) => {
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
      return;
    }
    // While our child leads its process group, cancellation needs no ps lookup.
    if (!this.closed || this.remaining(processTable()).length > 0) signalPid(-this.pid, signal);
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
    if (!this.closed || members.length === 0) return members;
    // A new live leader proves the number was reused. Without that leader or
    // an identity we observed, the group could still contain our descendants.
    if (members.some(({ pid }) => pid === this.pid)) return [];
    if (this.groupInspectionError !== undefined || !members.some(({ pid, started }) => this.members.get(pid) === started)) {
      throw new Error(`Could not identify Caccia Git process group ${this.pid}`, { cause: this.groupInspectionError });
    }
    return members;
  }
}

/** Own Git processes from allocation until the temporary clone is safe to remove. */
export function registerCacciaCloneGit(cwd: string): () => void {
  const children = new Set<OwnedGitProcess>();
  cloneProcesses.set(cwd, children);
  return () => {
    if (children.size > 0) {
      for (const child of children) child.signal('SIGKILL');
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
