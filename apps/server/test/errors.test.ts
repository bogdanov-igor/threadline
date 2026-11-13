import { describe, expect, it } from 'vitest';
import { classifyFetchError, classifyHttp, redact } from '../src/backends/errors.ts';

const err = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('классификация ошибок', () => {
  it.each([
    ['ENOTFOUND', 'network'],
    ['ECONNREFUSED', 'network'],
    ['ECONNRESET', 'network'],
    ['UND_ERR_CONNECT_TIMEOUT', 'network'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'certificate'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate'],
    ['CERT_HAS_EXPIRED', 'certificate'],
  ])('%s → %s', (code, expected) => {
    expect(classifyFetchError(err(code), []).code).toBe(expected);
  });

  it('отличает тайм-аут от отмены', () => {
    expect(classifyFetchError(new DOMException('t', 'TimeoutError'), []).code).toBe('timeout');
    expect(classifyFetchError(new DOMException('a', 'AbortError'), []).code).toBe('cancelled');
  });

  it.each([
    [401, 'application/json', '{"message":"Invalid API key"}', 'unauthorized'],
    [403, 'application/json', '{"message":"Permission denied"}', 'forbidden'],
    [404, 'application/json', '{"message":"Data source not found"}', 'not-found'],
    [200, 'text/html; charset=utf-8', '<html>login</html>', 'forbidden'],
    [503, 'text/plain', 'unavailable', 'overloaded'],
    [400, 'text/plain', 'max entries limit per query exceeded, limit > max_entries_limit (10000 > 5000)', 'limit'],
    [400, 'text/plain', 'maximum of series (500) reached for a single query', 'limit'],
    [400, 'text/plain', 'the query time range exceeds the limit (query length: 745h, limit: 721h)', 'limit'],
    [500, 'text/plain', 'boom', 'unknown'],
  ])('HTTP %i %s → %s', (status, ct, body, expected) => {
    expect(classifyHttp(status, ct, body, null, []).code).toBe(expected);
  });

  it('берёт срок повтора из Retry-After', () => {
    expect(classifyHttp(429, 'text/plain', 'too many outstanding requests', '7', []).retryAfterSeconds).toBe(7);
  });

  it('называет код неизвестной ошибки', () => {
    expect(classifyHttp(502, 'text/plain', 'bad gateway', null, []).details).toContain('HTTP 502');
  });
});

describe('вырезание секретов', () => {
  it('убирает токен и заголовки авторизации', () => {
    const token = 'eyJrIjoiT0tTcG1pUlY2RnVKZTFVaDFsNFZXdE9ZWmNrMkZYbk';
    const t = redact(`echo: Authorization: Bearer ${token}; Basic Z3c6cGFzcw==; key=${token}; glsa_abc_123`, [token]);
    expect(t).not.toContain(token);
    expect(t).not.toContain('Z3c6cGFzcw==');
    expect(t).not.toContain('glsa_abc_123');
  });

  it('не показывает токен в тексте ошибки HTTP', () => {
    const e = classifyHttp(500, 'text/plain', 'auth header was Bearer s3cr3t-token', null, ['s3cr3t-token']);
    expect(e.details).not.toContain('s3cr3t-token');
  });
});
