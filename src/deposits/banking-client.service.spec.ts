import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BankingClientService } from './banking-client.service';

const KEY = 'clave-interna-de-deposit-para-pruebas-012345';
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);

/**
 * Cuenta del cliente (con su token) y abono de la recarga en el ledger. El abono NO
 * lanza excepciones: devuelve la respuesta para que quien llama distinga un rechazo
 * definitivo (4xx) de una falla incierta (5xx o sin respuesta).
 */
describe('BankingClientService de deposit', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const build = (env: Record<string, string> = {}) =>
    new BankingClientService(new ConfigService({ INTERNAL_API_KEY: KEY, ...env }));
  const cashIn = { accountId: 'a1', amount: 50_000, idempotencyKey: 'k1', description: 'Recarga Wompi' };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('la cuenta se consulta con el token del cliente; si no es suya o no existe, la respuesta es la misma (403)', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { id: 'a/1', accountNumber: '10000000001', currency: 'COP' }));
    const account = await build({ ACCOUNT_SERVICE_URL: 'http://account.interno:3002//' }).getOwnedAccount(
      'a/1',
      'token-cliente',
    );

    expect(account.id).toBe('a/1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://account.interno:3002/accounts/a%2F1');
    expect(init.headers.Authorization).toBe('Bearer token-cliente');

    for (const status of [403, 404]) {
      fetchMock.mockReturnValueOnce(reply(status, { message: 'detalle interno' }));
      await expect(build().getOwnedAccount('a1', 't')).rejects.toThrow(
        new ForbiddenException('No tienes acceso a esta cuenta.'),
      );
    }
  });

  it('si account-service falla (503 con un reintento) es 503 con el mensaje de validar la cuenta', async () => {
    fetchMock.mockReturnValue(reply(503));
    await expect(build().getOwnedAccount('a1', 't')).rejects.toThrow('No se pudo validar la cuenta');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('el abono manda la clave interna y la de idempotencia y devuelve la respuesta del ledger tal cual', async () => {
    fetchMock.mockReturnValueOnce(reply(201, { id: 'tx-1' }));
    const ok = await build({ LEDGER_SERVICE_URL: 'http://ledger.interno:3006/' }).cashIn(cashIn);
    expect(ok).toMatchObject({ ok: true, status: 201, body: { id: 'tx-1' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ledger.interno:3006/ledger/internal/cash-ins');
    expect(init.headers['x-internal-key']).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual(cashIn);

    fetchMock.mockReturnValueOnce(reply(400, { message: 'La cuenta de destino no está activa.' }));
    expect(await build().cashIn(cashIn)).toMatchObject({ ok: false, status: 400 });
  });

  it('sin respuesta del ledger devuelve null (falla incierta) y el abono no se reintenta solo', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await build().cashIn(cashIn)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sin INTERNAL_API_KEY no sale ningún abono', async () => {
    await expect(new BankingClientService(new ConfigService({})).cashIn(cashIn)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
