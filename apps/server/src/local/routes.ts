// API хранилищ локального режима: только администратор и только при запуске командой локального режима. В обычном сервере
// маршрутов нет, адрес отвечает 404: хранилища сервера задаются файлом настроек и переменными окружения.
// Токены приходят только в запросе: ответ, журнал и ошибки их не содержат.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { LocalStorageErrorBody, LocalStorageErrorCode, LocalStorageInfo, LocalStoragesResponse, ProbeResponse } from '@threadline/core';
import { BackendError } from '@threadline/core/backend';
import { Backends } from '../backends/registry.ts';
import type { ResolvedConfig } from '../config/load.ts';
import { checkStorage, present, type LocalStorages } from './storages.ts';

/** Хранилище из формы — несколько коротких строк. */
export const STORAGE_BODY_LIMIT = 16 * 1024;
/** Идентификатор проверки подключения без своего: в ответ он не попадает. */
const DRAFT_ID = 'draft';

export interface LocalRoutesContext {
  storages: LocalStorages;
  backends: Backends;
  config: ResolvedConfig;
  /** Среды проектов на хранилище: «проект/среда». */
  usedBy: (store: string) => string[];
  clientSignal: (reply: FastifyReply) => AbortSignal;
  now?: () => number;
}

function send(reply: FastifyReply, status: number, code: LocalStorageErrorCode, fields?: Record<string, string>): FastifyReply {
  return reply.code(status).send({ error: { code, ...(fields ? { fields } : {}) } } satisfies LocalStorageErrorBody);
}

const idOf = (body: unknown): string => (typeof body === 'object' && body !== null && typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id.trim() : '');

export function registerLocalRoutes(app: FastifyInstance, ctx: LocalRoutesContext): void {
  const { storages, backends, config } = ctx;
  const now = ctx.now ?? Date.now;
  const info = (id: string): LocalStorageInfo => present(id, storages.get(id)!, ctx.usedBy(id));

  app.get('/api/local/storages', { config: { access: 'editSettings' } }, async (): Promise<LocalStoragesResponse> => ({
    storages: storages.list().map(([id]) => info(id)),
    file: storages.file,
    realStores: Object.values(config.backends).filter((b) => b.type !== 'mock').length,
  }));

  // Проверка до сохранения: тот же check, что у «Проверить подключение» страницы сервиса, на временном хранилище.
  app.post('/api/local/storages/check', { config: { access: 'editSettings' }, bodyLimit: STORAGE_BODY_LIMIT }, async (req, reply): Promise<ProbeResponse | FastifyReply> => {
    const checked = checkStorage(idOf(req.body) || DRAFT_ID, req.body, new Date(now()).toISOString());
    if (!checked.ok) return send(reply, 422, 'storage-invalid', checked.fields);
    const draft = new Backends({ path: config.path, config: config.config, backends: { [checked.id]: checked.resolved } });
    try {
      return await draft.probe(checked.id, undefined, ctx.clientSignal(reply));
    } catch (e) {
      if (e instanceof BackendError && e.code === 'cancelled') return reply.code(499).send({ error: { code: 'cancelled' } });
      throw e;
    }
  });

  app.post('/api/local/storages', { config: { access: 'editSettings' }, bodyLimit: STORAGE_BODY_LIMIT }, async (req, reply): Promise<LocalStorageInfo | FastifyReply> => {
    const id = idOf(req.body);
    const checked = checkStorage(id, req.body, new Date(now()).toISOString());
    if (!checked.ok) return send(reply, 422, 'storage-invalid', checked.fields);
    // Имя занято хранилищем файла настроек или уже подключённым: замена шла бы мимо сред, которые на нём стоят.
    if (Object.hasOwn(config.backends, id) || storages.has(id)) return send(reply, 409, 'storage-exists', { id: `хранилище «${id}» уже есть: выберите другое имя или удалите прежнее` });
    try {
      await storages.add(id, checked.stored);
    } catch (e) {
      req.log.error({ code: (e as NodeJS.ErrnoException).code }, 'локальное хранилище не записано в файл');
      return send(reply, 500, 'storage-save-failed');
    }
    backends.setStore(id, checked.resolved);
    req.log.info(`подключено хранилище «${id}» (${checked.stored.type})`);
    return reply.code(201).send(info(id));
  });

  app.delete<{ Params: { id: string } }>('/api/local/storages/:id', { config: { access: 'editSettings' } }, async (req, reply) => {
    const { id } = req.params;
    // Хранилища файла настроек здесь не удаляются: только подключённые из интерфейса.
    if (!storages.has(id)) return send(reply, 404, 'storage-not-found');
    try {
      await storages.remove(id);
    } catch (e) {
      req.log.error({ code: (e as NodeJS.ErrnoException).code }, 'локальное хранилище не удалено из файла');
      return send(reply, 500, 'storage-save-failed');
    }
    backends.setStore(id, null);
    req.log.info(`удалено хранилище «${id}»`);
    return reply.code(204).send();
  });
}
