import { describe, expect, it } from 'vitest';
import { catalogRecovered } from './CatalogBanner.tsx';

describe('возврат справочника', () => {
  it('открытые результаты обновляются только при переходе из недоступного состояния в ok', () => {
    expect(catalogRecovered('connecting', 'ok')).toBe(true);
    expect(catalogRecovered('stale', 'ok')).toBe(true);
    expect(catalogRecovered(undefined, 'ok')).toBe(false);
    expect(catalogRecovered('ok', 'ok')).toBe(false);
    expect(catalogRecovered('ok', 'stale')).toBe(false);
    expect(catalogRecovered('off', 'ok')).toBe(false);
  });
});
