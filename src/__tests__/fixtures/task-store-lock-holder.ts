import fs from 'node:fs';
import { join } from 'node:path';

const [projectDir, signalsDir, lockName] = process.argv.slice(2);
if (!projectDir || !signalsDir || !lockName) throw new Error('Missing lock holder arguments');

const marker = (name: string) => join(signalsDir, name);

fs.writeFileSync(marker('holder-ready'), 'ready');

function waitSync(name: string, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(marker(name))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

const { runPrivateFileExclusive } = await import('../../shared/utils/private-file-lock.js');

const lockPath = join(projectDir, '.takt', lockName);
try {
  runPrivateFileExclusive(lockPath, () => {
    fs.writeFileSync(marker('lock-held'), 'held');
    waitSync('release-lock');
  });
  fs.writeFileSync(marker('lock-released'), 'released');
} catch (error) {
  fs.writeFileSync(marker('lock-holder-error'), String(error));
  throw error;
}
