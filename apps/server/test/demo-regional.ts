// Настройка тестов с региональными правилами демо-проекта, как в config/threadline.yaml: телефон без кода страны,
// паспорт и личный номер в тексте записей. Без них голый номер 447700900101 и документы в тексте остаются открытыми.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, type ResolvedConfig } from '../src/config/load.ts';
import { CONFIG_YAML, tempConfig } from './catalog/fixture.ts';

export const DEMO_REGIONAL = `regional:
  phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }
  patterns:
    passport: ['[A-Z]{2}\\d{7}']
    national_id: ['[A-Z]{2}\\d{6}[A-D]']
`;

/** Настройка tempConfig с разделом regional демо-проекта; справочник — как у tempConfig. */
export async function demoConfig(opts: { catalog?: string } = {}): Promise<{ dir: string; config: ResolvedConfig }> {
  const { dir } = await tempConfig(opts);
  const path = join(dir, 'threadline.yaml');
  await writeFile(path, `${CONFIG_YAML}${DEMO_REGIONAL}`);
  return { dir, config: await loadConfig({ path, env: {} }) };
}
