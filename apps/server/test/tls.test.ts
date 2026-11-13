// Настоящий TLS с внутренним центром сертификации, как у Grafana во внутренней сети.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendError } from '@threadline/core/backend';
import type { ResolvedLoki } from '../src/config/load.ts';
import { LokiGrafanaBackend } from '../src/backends/loki-grafana.ts';
import { grafana85 } from './fake-grafana.ts';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('сертификат Grafana от внутреннего центра', () => {
  let url = '';
  let ca = '';
  let close = () => {};

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'threadline-tls-'));
    const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Threadline Test CA');
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=127.0.0.1');
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\n');
    run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '1', '-extfile', 'ext.cnf');
    ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
    const handler = grafana85();
    const server = createServer({ key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.pem')) }, (req, res) => handler(req, res, {} as never));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
    };
  });
  afterAll(() => close());

  const backend = (withCa: boolean) =>
    new LokiGrafanaBackend(
      {
        type: 'loki-grafana',
        url,
        datasource: { name: 'Loki' },
        tokenEnv: 'T',
        token: 't',
        ca: withCa ? ca : undefined,
        maxConcurrent: 4,
        queueTimeoutSeconds: 10,
        timeoutSeconds: 30,
      } satisfies ResolvedLoki,
      { env: {} },
    );

  it('без корневого сертификата: «сертификат не доверен»', async () => {
    const e = await backend(false).check(AbortSignal.timeout(5000)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect((e as BackendError).code).toBe('certificate');
  });

  it('со своим корневым сертификатом: подключение проходит проверку', async () => {
    expect((await backend(true).check(AbortSignal.timeout(5000))).labelNames).toContain('namespace');
  });
});
