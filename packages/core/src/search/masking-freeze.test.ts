// Сверка masking.ts со снимком: выражения, наборы и пределы не меняются.
// Снимок снят до правок файла. Новые выражения и другой порядок шагов этот тест назовёт.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CARD_FIELD_NAMES, isAuthName, isPanName, isSecretName, SECRET_FIELD_NAMES } from './masking.ts';

const here = (name: string) => new URL(name, import.meta.url);
const SOURCE = readFileSync(here('./masking.ts'), 'utf8');
const SNAPSHOT = here('./masking-freeze.snapshot.json');
const AST = ts.createSourceFile('masking.ts', SOURCE, ts.ScriptTarget.ESNext, true);

/** Значение верхнего уровня как текст: выражение со своими флагами, набор по алфавиту, вложенное — по именам. */
function frozen(v: unknown): unknown {
  if (v instanceof RegExp) return `/${v.source}/${v.flags}`;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (v instanceof Set) return [...(v as Set<string>)].sort();
  if (Array.isArray(v)) return v.map(frozen);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, frozen(x)]));
  return null;
}

/** Значения всех const верхнего уровня: файл собирается заново, импорт номера Луна заменён заглушкой. */
function runtimeValues(): Record<string, unknown> {
  const names = AST.statements.filter(ts.isVariableStatement).flatMap((s) => s.declarationList.declarations.map((d) => d.name.getText()));
  const js = ts.transpileModule(`${SOURCE}\nexport const __values = { ${names.join(', ')} };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  const exports: { __values?: Record<string, unknown> } = {};
  // Код из этого же репозитория: иначе закрытые выражения не прочитать.
  new Function('exports', 'require', js)(exports, () => ({ luhnValid: () => false }));
  return exports.__values!;
}

/** Выражения в тексте файла: литералы и new RegExp внутри функций, у них часть значения приходит параметром. */
function expressionsInText(): { literals: string[]; constructed: string[] } {
  const literals: string[] = [];
  const constructed: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isRegularExpressionLiteral(n)) literals.push(n.getText());
    if (ts.isNewExpression(n) && n.expression.getText() === 'RegExp') constructed.push(n.getText().replace(/\s+/g, ' '));
    ts.forEachChild(n, visit);
  };
  visit(AST);
  return { literals: literals.sort(), constructed: constructed.sort() };
}

function functionText(name: string): string {
  const f = AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!f) throw new Error(`нет функции ${name}`);
  return f.getText();
}

/** Порядок шагов maskText: вызовы проходов по порядку текста. */
function maskTextSteps(): string[] {
  return [...functionText('maskText').matchAll(/\b(maskUserinfo|maskJsonKeys|maskXmlTags|maskNamedTags|maskXmlTagsEncoded|maskNamedTagsEncoded|maskPairs|AUTH_HTTP_HEADERS|AUTH_SCHEME\b|PAN_AFTER_ESCAPE|PAN_PATTERN|PAN_GROUPED)\b/g)].map((m) => m[1]!);
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function capture() {
  const values = Object.fromEntries(
    Object.entries(runtimeValues())
      .map(([k, v]) => [k, frozen(v)] as const)
      .filter(([, v]) => v !== null),
  );
  return {
    values,
    ...expressionsInText(),
    steps: maskTextSteps(),
    classifyName: sha(functionText('classifyName')),
    maskPan: sha(functionText('maskPan')),
    maskingTest: sha(readFileSync(here('./masking.test.ts'), 'utf8')),
  };
}

const NEW_VALUES = new Set(['CARD_FIELD_NAMES', 'SECRET_FIELD_NAMES']);

describe('masking.ts заморожен', () => {
  const want = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as ReturnType<typeof capture>;
  const got = capture();

  it('значения верхнего уровня те же, новые только разрешённые и без выражений', () => {
    expect(got.values).toMatchObject(want.values);
    for (const k of Object.keys(got.values)) if (!(k in want.values)) expect(NEW_VALUES.has(k), k).toBe(true);
  });

  it('литералы и new RegExp в тексте те же', () => {
    expect(got.literals).toEqual(want.literals);
    expect(got.constructed).toEqual(want.constructed);
  });

  it('порядок шагов maskText тот же', () => {
    expect(got.steps).toEqual(want.steps);
    expect(got.steps.length).toBeGreaterThan(10);
  });

  it('classifyName, maskPan и masking.test.ts без единой правки', () => {
    expect(got.classifyName).toBe(want.classifyName);
    expect(got.maskPan).toBe(want.maskPan);
    expect(got.maskingTest).toBe(want.maskingTest);
  });
});

describe('списки имён для раздела сверены с распознаванием', () => {
  const tails = runtimeValues() as { SECRET_TAILS: Set<string>; PAN_TAILS: Set<string> };
  const compact = (names: readonly string[]) => new Set(names.map((n) => n.replace(/[_-]/g, '').toLowerCase()));

  it.each(SECRET_FIELD_NAMES)('%s: секрет', (name) => {
    expect(isSecretName(name) || isAuthName(name)).toBe(true);
    expect(isPanName(name)).toBe(false);
  });

  it.each(CARD_FIELD_NAMES)('%s: номер карты', (name) => {
    expect(isPanName(name)).toBe(true);
    expect(isSecretName(name) || isAuthName(name)).toBe(false);
  });

  it('каждый хвост распознавания назван в списке', () => {
    const secrets = compact(SECRET_FIELD_NAMES);
    const cards = compact(CARD_FIELD_NAMES);
    expect([...tails.SECRET_TAILS].filter((t) => !secrets.has(t))).toEqual([]);
    expect([...tails.PAN_TAILS].filter((t) => !cards.has(t))).toEqual([]);
  });
});
