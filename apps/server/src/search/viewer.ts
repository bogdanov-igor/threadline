// Кто смотрит скрытые значения: одна функция на сервере. Таблица видов решает, что открыто этому зрителю.
import type { FastifyRequest } from 'fastify';
import type { MaskViewer } from '@threadline/core/search';
import { isNoLogin } from '../auth/access.ts';

/** Без входа и при auth: off — no-login, иначе роль сессии. Вошедший без роли данных не получает, поэтому ему не открыто ничего. */
export function viewerOf(req: FastifyRequest): MaskViewer {
  if (isNoLogin(req) || !req.viewer) return 'no-login';
  return req.viewer.role ?? 'business';
}
