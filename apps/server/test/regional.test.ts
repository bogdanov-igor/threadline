// Раздел regional файла настроек: правила ставятся при чтении настроек и запуске сервера, интерфейс получает их со списком проектов.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectsResponse } from '@threadline/core';
import { detectTerm, maskKindsText, ALL_KINDS_MASKING, regional, setRegional } from '@threadline/core/search';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { Backends } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';

const REGIONAL = `
regional:
  phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }
  patterns:
    passport: ['[A-Z]{2}\\d{7}']
`;

const yaml = (extra = '') => `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    environments:
      demo:
        name: Демо
        backend: demo
        selector: [{ label: namespace, op: "=", value: pay }]
${extra}`;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  setRegional(null);
});

async function setup(extra = '') {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-regional-'));
  await writeFile(join(dir, 'threadline.yaml'), yaml(extra));
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  return config;
}

describe('региональные правила сервиса', () => {
  it('чтение настроек ставит правила: маска и поиск команды работают по ним', async () => {
    await setup(REGIONAL);
    expect(regional().phone).toEqual({ countryCode: '44', nationalDigits: 10, trunkPrefix: '0' });
    expect(maskKindsText('client 447700900001 passport ZZ0000101', ALL_KINDS_MASKING.strict, new Set())).toBe('client ********0001 passport ZZ*****01');
    expect(detectTerm('07700 900001')).toMatchObject({ kind: 'phone', value: '447700900001', local: true });
  });

  it('сервер ставит правила своих настроек и отдаёт их со списком проектов', async () => {
    const config = await setup(REGIONAL);
    setRegional(null);
    const app = await buildApp({ config, backends: new Backends(config), logger: false });
    closers.push(() => app.close());
    const body = (await app.inject('/api/projects')).json() as ProjectsResponse;
    expect(body.regional).toEqual({ phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }, patterns: { passport: ['[A-Z]{2}\\d{7}'] } });
  });

  it('без раздела — международные правила, поля regional в ответе нет', async () => {
    setRegional({ phone: { countryCode: '44', nationalDigits: 10 }, patterns: {} });
    const config = await setup();
    expect(regional().phone).toBeNull();
    const app = await buildApp({ config, backends: new Backends(config), logger: false });
    closers.push(() => app.close());
    const body = (await app.inject('/api/projects')).json() as ProjectsResponse;
    expect(body).not.toHaveProperty('regional');
    expect(detectTerm('447700900001')).toMatchObject({ kind: 'text' });
  });

  it('неверный образец — сервер не запускается, путь в ошибке', async () => {
    await expect(setup(`
regional:
  patterns:
    passport: ['(?=AB)\\d{7}']
`)).rejects.toMatchObject({ issues: [expect.objectContaining({ path: 'regional.patterns.passport.0' })] });
  });
});
