import { describe, expect, it } from 'vitest';
import { rpcAction } from './rpc.ts';

describe('действие SOAP и JSON-RPC', () => {
  it('SOAP с префиксами и без', () => {
    expect(rpcAction('<soapenv:Envelope><soapenv:Body><is:getCardNumber><CARD/></is:getCardNumber></soapenv:Body></soapenv:Envelope>')).toBe('getCardNumber');
    expect(rpcAction('<?xml version="1.0"?><Envelope><Body>\n  <readItems/></Body></Envelope>')).toBe('readItems');
  });

  it('ответ без отправки: окончание Response отбрасывается', () => {
    const body = '<S:Envelope><S:Body><ns:getCardNumberResponse/></S:Body></S:Envelope>';
    expect(rpcAction(body, { response: true })).toBe('getCardNumber');
    expect(rpcAction(body)).toBe('getCardNumberResponse');
  });

  it('JSON-RPC — поле method; без jsonrpc — не действие', () => {
    expect(rpcAction('{"jsonrpc":"2.0","method":"cards.get","id":1}')).toBe('cards.get');
    expect(rpcAction('{"method":"cards.get"}')).toBe('');
  });

  it('тело не JSON и не XML, обрезанный XML, пусто', () => {
    expect(rpcAction('plain text')).toBe('');
    expect(rpcAction('<Envelope><Body><getRea')).toBe('');
    expect(rpcAction('{"jsonrpc":')).toBe('');
    expect(rpcAction(null)).toBe('');
  });
});
