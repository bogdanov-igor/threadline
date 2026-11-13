// Действие SOAP и JSON-RPC по телу обмена.
// Заголовок SOAPAction не используется: у многих SOAP-сервисов он называет сервис, а не действие.

// Первый дочерний элемент Body с любым префиксом; имя должно быть дописано до конца тега.
const SOAP_BODY = /<(?:[\w.-]+:)?Body\b[^>]*>(?:\s|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)*<(?:[\w.-]+:)?([\w.-]+)[\s/>]/;

/** Действие обмена или '' — тело не SOAP и не JSON-RPC или не разобралось. response — тело ответа без отправки. */
export function rpcAction(body: string | null, opts: { response?: boolean } = {}): string {
  if (!body) return '';
  const s = body.trimStart();
  if (s.startsWith('<')) {
    const name = SOAP_BODY.exec(s)?.[1] ?? '';
    return opts.response && name.length > 'Response'.length && name.endsWith('Response') ? name.slice(0, -'Response'.length) : name;
  }
  if (s.startsWith('{')) {
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      return '';
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if ('jsonrpc' in o && typeof o.method === 'string') return o.method.trim().slice(0, 128);
    }
  }
  return '';
}
