import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { Backends } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';
import { fakeGrafana, grafana85 } from './fake-grafana.ts';

const SERVER_DIR = resolve(import.meta.dirname, '..');
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#123"/></svg>';

/** Настоящий заголовок PNG: подпись и IHDR с размерами. */
function png(width: number, height: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const YAML = (logo: string) => `
auth: off
defaults: { project: acme, environment: demo }
backends:
  demo: { type: mock }
projects:
  acme:
    name: Acme
${logo ? `    logo: ${logo}\n` : ''}    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: "=", value: acme }] }
`;

const dirs: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function configDir(logo: string, files: Record<string, string | Buffer> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-logo-'));
  dirs.push(dir);
  await writeFile(join(dir, 'threadline.yaml'), YAML(logo));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}

const load = (dir: string) => loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });

async function appFor(dir: string) {
  const config = await load(dir);
  const app = await buildApp({ config, backends: new Backends(config) });
  cleanups.push(() => app.close());
  return app;
}

async function rejected(file: string, body: string | Buffer) {
  const c = await load(await configDir(`{ light: ${file} }`, { [file]: body }));
  expect(c.logos?.has('acme')).toBe(false);
  return c.warnings!.map((w) => `${w.path}: ${w.message}`).join('\n');
}

describe('проверка файла логотипа', () => {
  it('файла нет: предупреждает с путём к полю, запуск не останавливается', async () => {
    const c = await load(await configDir('{ light: logos/nope.svg }'));
    expect(c.logos?.has('acme')).toBe(false);
    expect(c.warnings).toEqual([
      { path: 'projects.acme.logo.light', message: expect.stringContaining('файла нет') },
    ]);
  });

  it('вместо файла папка', async () => {
    const dir = await configDir('{ light: logos.svg }');
    await mkdir(join(dir, 'logos.svg'));
    expect((await load(dir)).warnings![0]!.message).toContain('не обычный файл');
  });

  it('именованный канал не вешает запуск', { timeout: 5000 }, async () => {
    const dir = await configDir('{ light: pipe.svg }');
    execFileSync('mkfifo', [join(dir, 'pipe.svg')]);
    expect((await load(dir)).warnings![0]!.message).toContain('не обычный файл');
  });

  it('файл без прав на чтение', async () => {
    const dir = await configDir('{ light: a.svg }', { 'a.svg': SVG });
    await chmod(join(dir, 'a.svg'), 0o000);
    expect((await load(dir)).warnings![0]!.message).toContain('нет прав');
  });

  it('разреженный файл на 1 ГБ не читается: размер и предел в предупреждении', async () => {
    const dir = await configDir('{ light: big.png }');
    const f = await open(join(dir, 'big.png'), 'w');
    await f.truncate(1024 ** 3);
    await f.close();
    const { message } = (await load(dir)).warnings![0]!;
    expect(message).toContain('1048576 КБ');
    expect(message).toContain('256 КБ');
  });

  it('пустой файл', async () => {
    expect(await rejected('a.svg', '')).toContain('пуст');
  });

  it('поддельный PNG: нет подписи, нет блока размеров, нулевой размер', async () => {
    expect(await rejected('a.png', '<svg></svg>')).toContain('подписи PNG');
    const noHeader = png(10, 10);
    noHeader.write('IDAT', 12, 'latin1');
    expect(await rejected('b.png', noHeader)).toContain('размерами');
    expect(await rejected('c.png', png(0, 10))).toContain('нулевой');
  });

  for (const [name, body, found] of [
    ['скрипт', '<svg viewBox="0 0 1 1"><script>x</script></svg>', '<script'],
    ['обработчик', '<svg viewBox="0 0 1 1" onload="x()"></svg>', 'on…='],
    ['foreignObject', '<svg viewBox="0 0 1 1"><foreignObject/></svg>', '<foreignObject'],
    ['image', '<svg viewBox="0 0 1 1"><image/></svg>', '<image'],
    ['внешний href', '<svg viewBox="0 0 1 1"><use href="https://x.example/a#b"/></svg>', 'href'],
    ['внешний url()', '<svg viewBox="0 0 1 1"><rect fill="url(https://x.example/a)"/></svg>', 'url()'],
  ] as const) {
    it(`SVG: ${name} назван в предупреждении`, async () => {
      expect(await rejected('a.svg', body)).toContain(found);
    });
  }

  it('ссылки на свой #id не считаются внешними, stroke-width не считается шириной', async () => {
    const c = await load(
      await configDir('{ light: a.svg }', {
        'a.svg': '<svg viewBox="0 0 2 1" stroke-width="9"><use href="#a"/><rect fill="url(#g)"/></svg>',
      }),
    );
    expect(c.logos?.get('acme')?.ratio).toBe(2);
  });

  for (const [name, body] of [
    ['без размера', '<svg></svg>'],
    ['нулевая ширина', '<svg width="0" height="10"></svg>'],
    ['нулевой viewBox', '<svg viewBox="0 0 0 10"></svg>'],
    ['размер в процентах', '<svg width="100%" height="100%"></svg>'],
  ] as const) {
    it(`SVG ${name}: пропорцию узнать негде`, async () => {
      expect(await rejected('a.svg', body)).toContain('пропорцию');
    });
  }

  it('SVG из редактора: BOM, заголовок XML, комментарий и DOCTYPE', async () => {
    const body =
      '\uFEFF<?xml version="1.0"?>\n<!-- Generator: Illustrator -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg width="30px" height="10"><g/></svg>';
    const c = await load(await configDir('{ light: a.svg }', { 'a.svg': body }));
    expect(c.warnings).toEqual([]);
    expect(c.logos?.get('acme')?.ratio).toBe(3);
  });

  it('ссылка наружу не читается, ссылка внутри папки принимается', async () => {
    const outside = await configDir('');
    await writeFile(join(outside, 'secret.svg'), SVG);
    const dir = await configDir('{ light: out.svg }');
    await symlink(join(outside, 'secret.svg'), join(dir, 'out.svg'));
    expect((await load(dir)).warnings![0]!.message).toContain('за пределы');

    const inside = await configDir('{ light: logos/link.svg }', { 'data/real.svg': SVG });
    await mkdir(join(inside, 'logos'));
    await symlink('../data/real.svg', join(inside, 'logos/link.svg'));
    expect((await load(inside)).logos?.has('acme')).toBe(true);
  });

  it('одна плохая версия из двух: логотипа нет целиком', async () => {
    const c = await load(await configDir('{ light: a.svg, dark: b.svg }', { 'a.svg': SVG, 'b.svg': '' }));
    expect(c.logos?.has('acme')).toBe(false);
    expect(c.warnings!.map((w) => w.path)).toEqual(['projects.acme.logo.dark']);
  });

  it('разные пропорции: берётся более широкая', async () => {
    const c = await load(
      await configDir('{ light: a.png, dark: b.png }', { 'a.png': png(10, 10), 'b.png': png(30, 10) }),
    );
    expect(c.logos?.get('acme')?.ratio).toBe(3);
  });
});

describe('предупреждения в журнале и команде проверки', () => {
  const SECRET_BODY = 'SYNTHETIC-LOGO-BODY';

  /** Запуск с явными пустыми токеном и базой: .env не подставит настоящие значения. */
  function run(args: string[], dir: string, until?: RegExp) {
    return new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          THREADLINE_CONFIG: join(dir, 'threadline.yaml'),
          THREADLINE_GRAFANA_TOKEN: '',
          THREADLINE_GRAFANA_URL: '',
          THREADLINE_ALLOW_NO_LOGIN: '1',
          THREADLINE_DATABASE_URL: '',
          THREADLINE_WEB_DIST: 'apps/web/no-such-dist',
          PORT: '0',
          THREADLINE_SHUTDOWN_TIMEOUT_SECONDS: '1',
          LOG_LEVEL: 'info',
        },
      });
      let out = '';
      const onData = (d: Buffer) => {
        out += String(d);
        if (until?.test(out)) child.kill('SIGTERM');
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', (code) => done({ code, out }));
    });
  }

  it(
    'сервер и команда проверки называют поле и причину, содержимого файла нет, код завершения прежний',
    { timeout: 30_000 },
    async () => {
      const dir = await configDir('{ light: a.svg }', {
        'a.svg': `<svg viewBox="0 0 1 1"><script>${SECRET_BODY}</script></svg>`,
      });
      const server = await run(['src/main.ts'], dir, /Threadline запущен/);
      expect(server.out).toContain('projects.acme.logo.light');
      expect(server.out).toContain('<script');
      expect(server.out).not.toContain(SECRET_BODY);

      const check = await run(['src/cli/check.ts', '--project', 'acme', '--env', 'demo'], dir);
      expect(check.code).toBe(0);
      expect(check.out).toContain('projects.acme.logo.light');
      expect(check.out).not.toContain(SECRET_BODY);
    },
  );
});

describe('раздача логотипа', () => {
  const urlsOf = async (app: Awaited<ReturnType<typeof appFor>>) =>
    (await app.inject('/api/projects')).json().projects[0].logo as
      { light: string; dark: string; ratio: number } | undefined;

  it('типы, nosniff, своя политика песочницы, общая политика на остальных ответах', async () => {
    const app = await appFor(
      await configDir('{ light: a.svg, dark: b.png }', { 'a.svg': SVG, 'b.png': png(10, 10) }),
    );
    const urls = (await urlsOf(app))!;
    const svg = await app.inject(urls.light);
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    expect(svg.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(svg.body).toBe(SVG);
    expect((await app.inject(urls.dark)).headers['content-type']).toBe('image/png');
    expect((await app.inject('/api/health')).headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect((await app.inject('/api/projects/acme/logo/sepia')).headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
  });

  it('верный хеш кэшируется надолго, неверный и отсутствующий нет', async () => {
    const app = await appFor(await configDir('{ light: a.svg }', { 'a.svg': SVG }));
    const { light } = (await urlsOf(app))!;
    expect((await app.inject(light)).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject('/api/projects/acme/logo/light?v=000000000000')).headers['cache-control']).toBe(
      'no-cache',
    );
    expect((await app.inject('/api/projects/acme/logo/light')).headers['cache-control']).toBe('no-cache');
  });

  it('файл заменён и сервер перезапущен: адрес новый; удалён без перезапуска: прежний логотип', async () => {
    const dir = await configDir('{ light: a.svg }', { 'a.svg': SVG });
    const first = await appFor(dir);
    const before = (await urlsOf(first))!.light;
    await rm(join(dir, 'a.svg'));
    expect((await first.inject(before)).body).toBe(SVG);

    await writeFile(join(dir, 'a.svg'), SVG.replace('#123', '#456'));
    const second = await appFor(dir);
    expect((await urlsOf(second))!.light).not.toBe(before);
  });

  it('404, а не 502: нет логотипа, неизвестный проект и тема, __proto__, constructor', async () => {
    const withLogo = await appFor(await configDir('{ light: a.svg }', { 'a.svg': SVG }));
    const noLogo = await appFor(await configDir(''));
    expect((await noLogo.inject('/api/projects/acme/logo/light')).statusCode).toBe(404);
    for (const path of [
      '/api/projects/nope/logo/light',
      '/api/projects/__proto__/logo/light',
      '/api/projects/constructor/logo/dark',
      '/api/projects/acme/logo/sepia',
      '/api/projects/acme/logo/__proto__',
    ]) {
      expect((await withLogo.inject(path)).statusCode, path).toBe(404);
    }
  });

  it('обход пути и файлы папки настройки не отдаются', async () => {
    const app = await appFor(await configDir('{ light: logos/a.svg }', { 'logos/a.svg': SVG }));
    for (const path of [
      '/api/projects/acme/logo/..%2F..%2Fthreadline.yaml',
      '/api/projects/acme/logo/%2e%2e%2fthreadline.yaml',
      '/api/projects/..%2F/logo/light',
      '/config/threadline.yaml',
      '/logos/a.svg',
      '/threadline.yaml',
    ]) {
      const r = await app.inject(path);
      expect(r.statusCode, path).toBeGreaterThanOrEqual(400);
      expect(r.body, path).not.toContain('backends');
      expect(r.body, path).not.toContain('<svg');
    }
  });

  it('логотип и список проектов не обращаются к Grafana', async () => {
    const g = await fakeGrafana(grafana85({ values: ['pay', 'pay-pr-92', 'pay-pr-105', 'pay-pr-test'] }));
    cleanups.push(() => g.close());
    const dir = await configDir('{ light: a.svg }', { 'a.svg': SVG });
    await writeFile(
      join(dir, 'threadline.yaml'),
      YAML('{ light: a.svg }').replace(
        'backends:\n  demo: { type: mock }',
        `backends:\n  demo: { type: loki-grafana, url: ${g.url}, tokenEnv: THREADLINE_LOGO_TEST_TOKEN }`,
      ),
    );
    const config = await loadConfig({
      path: join(dir, 'threadline.yaml'),
      env: { THREADLINE_LOGO_TEST_TOKEN: 'synthetic' },
    });
    const app = await buildApp({ config, backends: new Backends(config) });
    cleanups.push(() => app.close());
    const { light } = (await urlsOf(app))!;
    expect((await app.inject(light)).statusCode).toBe(200);
    expect(g.requests).toEqual([]);
  });
});

describe('логотип в списке проектов', () => {
  it('адреса с хешем и пропорция, путей на диске нет', async () => {
    const app = await appFor(
      await configDir('{ light: logos/a.svg, dark: logos/b.png }', {
        'logos/a.svg': SVG,
        'logos/b.png': png(10, 10),
      }),
    );
    const { body } = await app.inject('/api/projects');
    const { logo } = JSON.parse(body).projects[0];
    expect(logo.light).toMatch(/^\/api\/projects\/acme\/logo\/light\?v=[0-9a-f]{12}$/);
    expect(logo.dark).toMatch(/^\/api\/projects\/acme\/logo\/dark\?v=[0-9a-f]{12}$/);
    expect(logo.ratio).toBe(2);
    expect(body).not.toContain('logos/');
    expect(body).not.toContain(tmpdir());
  });

  it('одна версия: адреса совпадают; без логотипа и с плохим файлом поля нет', async () => {
    const one = await appFor(await configDir('{ light: a.svg }', { 'a.svg': SVG }));
    const { logo } = (await one.inject('/api/projects')).json().projects[0];
    expect(logo.dark).toBe(logo.light);
    const none = await appFor(await configDir(''));
    expect((await none.inject('/api/projects')).json().projects[0]).not.toHaveProperty('logo');
    const broken = await appFor(await configDir('{ light: a.svg }', { 'a.svg': '' }));
    expect((await broken.inject('/api/projects')).json().projects[0]).not.toHaveProperty('logo');
  });
});

describe('документация', () => {
  it('пример из config/README.md проходит loadConfig', async () => {
    const readme = await readFile(resolve(SERVER_DIR, '../../config/README.md'), 'utf8');
    const example = /### Логотип проекта\s+```yaml\n([\s\S]*?)```/.exec(readme)![1]!;
    const dir = await mkdtemp(join(tmpdir(), 'threadline-logo-'));
    dirs.push(dir);
    await writeFile(
      join(dir, 'threadline.yaml'),
      `auth: off\ndefaults: { project: acme, environment: demo }\nbackends:\n  demo: { type: mock }\n${example}`,
    );
    await mkdir(join(dir, 'logos'));
    await writeFile(join(dir, 'logos/acme-light.svg'), SVG);
    await writeFile(join(dir, 'logos/acme-dark.svg'), SVG);
    const c = await load(dir);
    expect(c.warnings).toEqual([]);
    expect(c.logos?.has('acme')).toBe(true);
  });
});
