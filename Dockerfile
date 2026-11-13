# Threadline: один образ — сервер, собранный интерфейс и команда миграций. Как запускать: README.ru.md.
# docker build -t threadline .
# С ревизией и датой сборки и из своего зеркала: README.ru.md, «Версия и сборка».

# Базовый образ всех стадий и реестр пакетов: в закрытой сети подставьте своё зеркало. Реестр нужен только стадиям сборки.
ARG NODE_IMAGE=node:24.22.1-alpine3.23
ARG NPM_REGISTRY=https://registry.npmjs.org/

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY
# npm ставит pnpm, pnpm ставит пакеты: переменные у них разные.
ENV npm_config_registry=$NPM_REGISTRY \
    pnpm_config_registry=$NPM_REGISTRY
WORKDIR /app
RUN npm install -g pnpm@12.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @threadline/web build

# Только зависимости сервера для работы: инструменты сборки и зависимости разработки здесь не ставятся.
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY
# npm ставит pnpm, pnpm ставит пакеты: переменные у них разные.
ENV npm_config_registry=$NPM_REGISTRY \
    pnpm_config_registry=$NPM_REGISTRY
WORKDIR /app
RUN npm install -g pnpm@12.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --prod --frozen-lockfile --filter "@threadline/server..."

# Каталог приложения. Права здесь: у файлов на машине разработчика бывает режим 600, а контейнер идёт под произвольным UID.
FROM ${NODE_IMAGE} AS app
WORKDIR /app
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/core/package.json packages/core/package.json
COPY --from=deps /app/packages/core/node_modules packages/core/node_modules
COPY --from=deps /app/apps/server/package.json apps/server/package.json
COPY --from=deps /app/apps/server/node_modules apps/server/node_modules
COPY packages/core/src packages/core/src
COPY apps/server/src apps/server/src
COPY config config
COPY --from=build /app/apps/web/dist apps/web/dist
RUN chmod -R a+rX,go-w /app

FROM ${NODE_IMAGE}
# Менеджеры пакетов для работы не нужны.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=app /app /app

# Что за сборка: показывают «О Threadline», «Сервис» и /api/health. Без аргументов этих сведений нет. Аргументы в последнем этапе: остальные этапы кэшируются.
ARG THREADLINE_REVISION=
ARG THREADLINE_BUILD_DATE=

# Внутри контейнера сервер слушает все адреса, иначе порт не пробросить. THREADLINE_STRICT_START=1: без базы и токенов сервер не запускается.
# Куча под предел пода 1 ГиБ: 640 МБ старого поколения, вместе с молодым 832 МБ, остальное на буферы и сам процесс. Треть кучи —
# память под результаты поиска. Под с другой памятью задаёт свою NODE_OPTIONS: README.ru.md, «Ресурсы».
ENV NODE_OPTIONS=--max-old-space-size=640
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    THREADLINE_STRICT_START=1 \
    THREADLINE_REVISION=$THREADLINE_REVISION \
    THREADLINE_BUILD_DATE=$THREADLINE_BUILD_DATE
# Число, а не имя: иначе runAsNonRoot в Kubernetes не проверить. Код работает и под любым другим UID.
USER 1000:1000
EXPOSE 8080
# Порт читается при запуске. -Y off: проверка не идёт через корпоративный прокси.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD wget -q -Y off -O /dev/null "http://127.0.0.1:${PORT}/health/readiness" || exit 1
# Выражения профилей формата: после 1000 возвратов V8 переходит на линейный движок (защита от перебора).
# Миграции другой командой без пересборки: docker run <образ> node --disable-warning=ExperimentalWarning apps/server/src/cli/migrate.ts
CMD ["node", "--enable-experimental-regexp-engine", "--enable-experimental-regexp-engine-on-excessive-backtracks", "--regexp-backtracks-before-fallback=1000", "--no-warnings", "apps/server/src/main.ts"]
