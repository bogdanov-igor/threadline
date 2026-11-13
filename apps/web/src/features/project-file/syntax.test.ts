import { describe, expect, it } from 'vitest';
import { convertFileText } from './convert.ts';
import { checkSyntax, inspectText } from './syntax.ts';

const PAN = '4111111234557893';
const SCHEMA = '# yaml-language-server: $schema=./catalog.schema.json';

describe('синтаксис в браузере', () => {
  it('отступ в YAML: строка и столбец', () => {
    const r = checkSyntax('version: 1\nproject: pay\n  bad: 1\n', 'yaml');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBeGreaterThan(1);
  });

  it('лишняя запятая в JSON: ошибка у места, хотя yaml её пропускает', () => {
    const text = '{\n  "version": 1,\n}\n';
    const r = checkSyntax(text, 'json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBe(3);
    expect(checkSyntax(text, 'yaml').ok).toBe(true);
  });

  it('повтор ключа: у повтора, как на сервере', () => {
    const r = checkSyntax('a: 1\nb: 2\na: 3\n', 'yaml');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBe(3);
  });

  it('больше 100 ссылок: ошибка без позиции и без падения', () => {
    const r = checkSyntax(`a: &a [1]\nb: [${Array.from({ length: 150 }, () => '*a').join(', ')}]\n`, 'yaml');
    expect(r).toEqual({ ok: false, line: null, col: null });
  });

  it('глубокая вложенность: страница не падает', () => {
    const r = checkSyntax('['.repeat(200_000), 'json');
    expect(r.ok).toBe(false);
  });

  it('файл с номером карты: наружу только позиция, цитаты нет', () => {
    for (const [text, format] of [[`version: 1\nproject: [pay ${PAN}\n`, 'yaml'], [`{ "a": ${PAN}x }`, 'json']] as const) {
      const r = checkSyntax(text, format);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(PAN);
      expect(Object.keys(r).sort()).toEqual(['col', 'line', 'ok']);
    }
  });

  it('{ в режиме YAML разбирается как YAML, а не угадывается', () => {
    expect(checkSyntax('{ "a": 1, }\n', 'yaml').ok).toBe(true);
    expect(checkSyntax('{ "a": 1, }\n', 'json').ok).toBe(false);
  });
});

describe('путь ошибки в строку', () => {
  const yamlText = `${SCHEMA}\nversion: 1\nproject: pay\nsettings:\n  name: Demo Pay\n  environments:\n    - id: prod\n      selector:\n        - { label: namespace, op: '=', value: x }\nsystems:\n  - key: a\n    methods:\n      - http: GET\n        path: /a\n`;
  const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;

  it('YAML: точное поле, в том числе от settings', () => {
    const { locations } = inspectText(yamlText, 'yaml', ['systems.0.methods.0.path', 'settings.environments.0.selector.0.value', 'settings.name']);
    expect(lineOf(yamlText, locations['systems.0.methods.0.path']!.from)).toBe(14);
    expect(lineOf(yamlText, locations['settings.environments.0.selector.0.value']!.from)).toBe(9);
    expect(lineOf(yamlText, locations['settings.name']!.from)).toBe(5);
  });

  it('JSON одной строкой и с табуляцией', () => {
    const text = '{\n\t"version": 1,\n\t"systems": [{ "key": "a", "name": "A" }]\n}\n';
    const { locations } = inspectText(text, 'json', ['systems.0.name']);
    expect(text.slice(locations['systems.0.name']!.from, locations['systems.0.name']!.to)).toBe('"A"');
  });

  it('поля нет в тексте: родитель; нет и родителя: только в списке', () => {
    const { locations } = inspectText(yamlText, 'yaml', ['systems.0.methods.0.name', 'nothing.here']);
    expect(lineOf(yamlText, locations['systems.0.methods.0.name']!.from)).toBe(13);
    expect(locations['nothing.here']).toBeUndefined();
  });

  it('замаскированный и пустой путь только в списке', () => {
    const { locations } = inspectText(yamlText, 'yaml', ['systems.0.***', '']);
    expect(locations).toEqual({});
  });
});

describe('комментарии', () => {
  it('строка схемы из выгрузки комментарием не считается', () => {
    expect(inspectText(`${SCHEMA}\nversion: 1\n`, 'yaml', []).hasComments).toBe(false);
  });
  it('настоящий комментарий считается, а # внутри строки нет', () => {
    expect(inspectText(`${SCHEMA}\n# мой\nversion: 1\n`, 'yaml', []).hasComments).toBe(true);
    expect(inspectText(`${SCHEMA}\nversion: 1 # рядом\n`, 'yaml', []).hasComments).toBe(true);
    expect(inspectText(`${SCHEMA}\nname: "a # b"\n`, 'yaml', []).hasComments).toBe(false);
  });
});

describe('преобразование форматов', () => {
  it('туда и обратно с тем же текстом; строка схемы снова вверху', () => {
    const y = `${SCHEMA}\nversion: 1\nproject: pay\n`;
    const j = convertFileText(y, 'yaml', 'json');
    expect(j).toBe('{\n  "version": 1,\n  "project": "pay"\n}\n');
    expect(convertFileText(j, 'json', 'yaml')).toBe(y);
  });
});
