// Хранилище браузера может быть запрещено (приватный режим, политика): каждое обращение в try/catch.

export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): boolean {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
};

const LAST = 'threadline.last';

export interface LastChoice {
  project: string;
  env: string;
  stand?: string;
}

export function readLastChoice(): LastChoice | null {
  const raw = storage.get(LAST);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastChoice>;
    if (typeof v.project !== 'string' || typeof v.env !== 'string') return null;
    return { project: v.project, env: v.env, ...(typeof v.stand === 'string' ? { stand: v.stand } : {}) };
  } catch {
    return null;
  }
}

export function writeLastChoice(choice: LastChoice): void {
  storage.set(LAST, JSON.stringify(choice));
}
