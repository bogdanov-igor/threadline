// Общее для тестов развёртывания: приложение на имитации и запись журнала в память.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildApp, type AppOptions } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { loadConfig } from '../../src/config/load.ts';

export const MOCK_YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
  slow: { type: mock, latencyMs: 700 }
  broken: { type: mock, fail: network }
projects:
  pay:
    name: Demo Pay
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
      slow: { name: Медленно, backend: slow, selector: [{ label: namespace, op: '=', value: pay }] }
      broken: { name: Сбой, backend: broken, selector: [{ label: namespace, op: '=', value: pay }] }
`;

export async function configDir(yaml = MOCK_YAML): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-deploy-'));
  await writeFile(join(dir, 'threadline.yaml'), yaml);
  return dir;
}

export function memoryLog() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });
  return { lines, stream };
}

export async function mockApp(opts: Partial<AppOptions> = {}, yaml = MOCK_YAML) {
  const dir = await configDir(yaml);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  const app = await buildApp({ config, backends: new Backends(config), logger: false, ...opts });
  return { app, dir };
}
