// Один выход ответов с данными: маршруты зовут эти функции последним шагом с запросом.
// Бизнесу уходит ответ из списка разрешённых полей, остальным ролям та же ссылка на объект, без копирования.

import type { FastifyRequest } from 'fastify';
import type { ConnectionResponse, ProjectsResponse } from '@threadline/core';
import type { CatalogState, RequestDetail, SearchState } from '@threadline/core/search';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { businessCatalogState, businessConnection, businessDetail, businessProjects, businessState } from '@threadline/core/view/business';
import { isBusiness } from './access.ts';

export const presentState = <T extends SearchState>(req: FastifyRequest, state: T): T | SearchState => (isBusiness(req) ? businessState(state) : state);

export const presentDetail = <T extends RequestDetail>(req: FastifyRequest, detail: T): T | RequestDetail => (isBusiness(req) ? businessDetail(detail) : detail);

export const presentProjects = (req: FastifyRequest, res: ProjectsResponse): ProjectsResponse => (isBusiness(req) ? businessProjects(res, DEFAULT_VIEW) : res);

export const presentConnection = <T extends ConnectionResponse>(req: FastifyRequest, res: T): T | ConnectionResponse => (isBusiness(req) ? businessConnection(res) : res);

export const presentCatalogState = <T extends CatalogState>(req: FastifyRequest, state: T): T | CatalogState => (isBusiness(req) ? businessCatalogState(state) : state);
