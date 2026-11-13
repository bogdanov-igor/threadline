// Профили формата проектов: собираются один раз при старте сервера.

import type { ThreadlineConfig } from '@threadline/core/config';
import { compileProfile, profileSource, type CompiledProfile } from '@threadline/core/profile';

/** Не чаще одной записи в журнал за это время на профиль: битый формат не должен залить журнал на каждой строке. */
export const PARSE_ERROR_LOG_MS = 60_000;

/** Профиль каждого проекта; проекты с одним форматом делят один собранный профиль. */
export function compileProjectProfiles(
  config: ThreadlineConfig,
  warn: (message: string) => void,
  now: () => number = Date.now,
): Map<string, CompiledProfile> {
  const byFormat = new Map<string, CompiledProfile>();
  const out = new Map<string, CompiledProfile>();
  for (const [pid, project] of Object.entries(config.projects)) {
    const format = project.format;
    let profile = byFormat.get(format);
    if (!profile) {
      const source = profileSource(format, config.formats);
      if (!source) throw new Error(`у проекта «${pid}» неизвестный формат «${format}»`);
      let last = -Infinity;
      let skipped = 0;
      profile = compileProfile(format, source, {
        onError: (message) => {
          const t = now();
          if (t - last < PARSE_ERROR_LOG_MS) {
            skipped++;
            return;
          }
          warn(skipped > 0 ? `${message} (и ещё ${skipped} за минуту)` : message);
          last = t;
          skipped = 0;
        },
      });
      byFormat.set(format, profile);
    }
    out.set(pid, profile);
  }
  return out;
}
