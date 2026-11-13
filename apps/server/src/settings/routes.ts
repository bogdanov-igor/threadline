// API настроек сервиса: право editSettings. Контакт поддержки читает любой вошедший, ответ только из двух полей.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { isSettingKey, SETTINGS, validSetting, type ServiceSettingsResponse, type SettingDef, type SettingErrorBody, type SettingErrorCode, type SupportContact } from '@threadline/core/settings';
import { DbError, isConnectionError } from '../catalog/db.ts';
import { CatalogUnavailable } from '../catalog/service.ts';
import { SettingConflict, type SettingsService } from './service.ts';

const BODY_LIMIT = 4 * 1024;
const FIELDS = new Set(['value', 'updatedAt']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function send(reply: FastifyReply, status: number, code: SettingErrorCode, extra: Omit<SettingErrorBody['error'], 'code'> = {}): FastifyReply {
  return reply.code(status).send({ error: { code, ...extra } } satisfies SettingErrorBody);
}

const invalid = (reply: FastifyReply, path: string, message: string) => send(reply, 422, 'setting-invalid', { fields: { [path]: message } });

function valueRule(def: SettingDef): string {
  if (def.kind === 'int') return `целое число от ${def.min} до ${def.max}, null — значение по умолчанию`;
  return `${def.https ? 'ссылка https' : 'строка без управляющих символов'} до ${def.maxLength} символов, null — значение по умолчанию`;
}

export function registerSettingsRoutes(app: FastifyInstance, service: SettingsService): void {
  app.get('/api/settings', { config: { access: 'editSettings' } }, async (): Promise<ServiceSettingsResponse> => service.list());

  app.get('/api/support-contact', { config: { access: 'signed-in' } }, async (): Promise<SupportContact> => service.supportContact());

  app.put<{ Params: { key: string } }>('/api/settings/:key', { bodyLimit: BODY_LIMIT, config: { access: 'editSettings' } }, async (req, reply) => {
    const { key } = req.params;
    if (!isSettingKey(key)) return send(reply, 404, 'setting-not-found');
    const b: unknown = req.body;
    if (!isObject(b)) return invalid(reply, 'value', 'нужен объект JSON');
    for (const name of Object.keys(b)) if (!FIELDS.has(name)) return invalid(reply, name, `неизвестное поле «${name}»`);
    const def = SETTINGS[key];
    if (b.value !== null && !validSetting(def, b.value)) return invalid(reply, 'value', valueRule(def));
    if (b.updatedAt !== null && typeof b.updatedAt !== 'string') return invalid(reply, 'updatedAt', 'нет метки версии');
    try {
      return await service.save(key, b.value, b.updatedAt);
    } catch (e) {
      if (e instanceof SettingConflict) return send(reply, 409, 'setting-conflict', { current: e.current });
      if (e instanceof CatalogUnavailable || (e instanceof DbError && isConnectionError(e))) return send(reply, 503, 'settings-unavailable');
      throw e;
    }
  });
}
