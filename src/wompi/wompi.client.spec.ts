import { WompiClient, WompiUnavailableError } from './wompi.client';
import { WompiConfig } from './wompi.config';

/**
 * Consultas a Wompi con la llave privada (fetch simulado). Una respuesta rara nunca se
 * interpreta como aprobada: ante la duda la recarga sigue pendiente y se vuelve a consultar.
 */
const config: WompiConfig = {
  environment: 'sandbox',
  apiUrl: 'https://sandbox.wompi.co/v1',
  publicKey: 'pub_test_x',
  privateKey: 'prv_test_llave-privada',
  integritySecret: 'test_integrity_x',
  eventsSecret: 'test_events_x',
};
const reply = (status: number, body: unknown) =>
  Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  } as unknown as Response);
const wompiTransaction = (overrides: Record<string, unknown> = {}) => ({
  id: '1234-abc',
  reference: 'dep-1',
  amount_in_cents: 5_000_000,
  currency: 'COP',
  status: 'APPROVED',
  status_message: 'Aprobada',
  payment_method_type: 'CARD',
  ...overrides,
});

describe('WompiClient', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const client = new WompiClient(config);

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('consulta la transacción por id con la llave privada y la traduce a lo que BankLite usa', async () => {
    fetchMock.mockReturnValue(reply(200, { data: wompiTransaction() }));

    const result = await client.getTransaction('12/34');

    expect(result).toEqual({
      id: '1234-abc',
      reference: 'dep-1',
      amountInCents: 5_000_000,
      currency: 'COP',
      status: 'APPROVED',
      statusMessage: 'Aprobada',
      paymentMethodType: 'CARD',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sandbox.wompi.co/v1/transactions/12%2F34');
    expect(init.headers.Authorization).toBe('Bearer prv_test_llave-privada');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('una transacción que Wompi no conoce (404) es null, no un error', async () => {
    fetchMock.mockReturnValue(reply(404, {}));
    expect(await client.getTransaction('no-existe')).toBeNull();
    expect(await client.findByReference('dep-x')).toEqual([]);
  });

  it('busca por referencia y devuelve todas las transacciones, con los campos opcionales recortados', async () => {
    fetchMock.mockReturnValue(
      reply(200, {
        data: [
          wompiTransaction({ status: 'DECLINED', status_message: 'x'.repeat(500), payment_method_type: undefined }),
          wompiTransaction({ id: 'otra', status: 'PENDING' }),
        ],
      }),
    );

    const result = await client.findByReference('dep 1&x');

    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.wompi.co/v1/transactions?reference=dep%201%26x');
    expect(result.map((t) => t.status)).toEqual(['DECLINED', 'PENDING']);
    expect(result[0].statusMessage).toHaveLength(200);
    expect(result[0].paymentMethodType).toBeNull();
  });

  it('sin respuesta, con 5xx o con 401 (llaves mal puestas) queda como no disponible', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(client.getTransaction('1')).rejects.toThrow(WompiUnavailableError);

    fetchMock.mockReturnValueOnce(reply(500, {}));
    await expect(client.getTransaction('1')).rejects.toThrow('Wompi respondió 500');

    fetchMock.mockReturnValueOnce(reply(401, {}));
    await expect(client.findByReference('r')).rejects.toThrow('Wompi respondió 401');
  });

  it('un cuerpo que no es JSON o sin la lista esperada no se acepta', async () => {
    fetchMock.mockReturnValueOnce(reply(200, new Error('Unexpected token')));
    await expect(client.getTransaction('1')).rejects.toThrow('no es JSON');

    fetchMock.mockReturnValueOnce(reply(200, { data: 'no-es-lista' }));
    await expect(client.findByReference('r')).rejects.toThrow('sin lista de transacciones');
  });

  it('una transacción con formato inesperado (estado desconocido, monto raro, campos faltantes) se rechaza', async () => {
    const malformed = [
      { status: 'APROBADA' },
      { amount_in_cents: '5000000.5' },
      { amount_in_cents: 1.5 },
      { amount_in_cents: undefined },
      { id: 123 },
      { reference: undefined },
      { currency: undefined },
    ];
    for (const overrides of malformed) {
      fetchMock.mockReturnValueOnce(reply(200, { data: wompiTransaction(overrides) }));
      await expect(client.getTransaction('1')).rejects.toThrow('formato inesperado');
    }
    fetchMock.mockReturnValueOnce(reply(200, {}));
    await expect(client.getTransaction('1')).rejects.toThrow('formato inesperado');
  });
});
