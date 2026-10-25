import { createHash } from 'crypto';
import { readWompiConfig } from './wompi.config';
import { integritySignature, isValidEventSignature, uuidV5, WompiEvent } from './wompi.signatures';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const EVENTS_SECRET = 'test_events_abcdefghijklmnopqrstuvwxyz';

/** Evento firmado igual que Wompi: valores de las propiedades + timestamp + secreto de eventos. */
function signedEvent(overrides: Partial<{ id: string; status: string; amount: number }> = {}): WompiEvent {
  const transaction = {
    id: overrides.id ?? '1234-1610641025-49201',
    status: overrides.status ?? 'APPROVED',
    amount_in_cents: overrides.amount ?? 4_490_000,
    reference: 'BL-ref',
  };
  const timestamp = 1530291411;
  return {
    event: 'transaction.updated',
    data: { transaction },
    environment: 'test',
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: sha256(
        `${transaction.id}${transaction.status}${transaction.amount_in_cents}${timestamp}${EVENTS_SECRET}`,
      ),
    },
    timestamp,
  };
}

describe('firma de los eventos de Wompi', () => {
  it('acepta un evento firmado con el secreto de eventos (en el cuerpo o en X-Event-Checksum)', () => {
    const event = signedEvent();
    expect(isValidEventSignature(event, undefined, EVENTS_SECRET)).toBe(true);
    expect(isValidEventSignature(event, (event.signature!.checksum as string).toUpperCase(), EVENTS_SECRET)).toBe(true);
  });

  it('rechaza una firma hecha con otro secreto', () => {
    expect(isValidEventSignature(signedEvent(), undefined, 'test_events_otro_secreto_distinto')).toBe(false);
  });

  it('rechaza un evento alterado después de firmado (estado o monto)', () => {
    const event = signedEvent({ status: 'DECLINED' });
    event.data!.transaction.status = 'APPROVED';
    expect(isValidEventSignature(event, undefined, EVENTS_SECRET)).toBe(false);

    const altered = signedEvent();
    altered.data!.transaction.amount_in_cents = 1;
    expect(isValidEventSignature(altered, undefined, EVENTS_SECRET)).toBe(false);
  });

  it('rechaza eventos sin firma, sin timestamp o con propiedades raras', () => {
    const noSignature = signedEvent();
    delete noSignature.signature;
    expect(isValidEventSignature(noSignature, undefined, EVENTS_SECRET)).toBe(false);

    const noTimestamp = signedEvent();
    delete noTimestamp.timestamp;
    expect(isValidEventSignature(noTimestamp, undefined, EVENTS_SECRET)).toBe(false);

    const weird = signedEvent();
    weird.signature!.properties = ['transaction.__proto__'];
    expect(isValidEventSignature(weird, undefined, EVENTS_SECRET)).toBe(false);

    expect(isValidEventSignature(signedEvent(), 'no-es-un-hash', EVENTS_SECRET)).toBe(false);
  });
});

describe('firma de integridad del widget', () => {
  it('es SHA256 de referencia + centavos + moneda + vencimiento + secreto', () => {
    const params = {
      reference: 'BL-1',
      amountInCents: 5_000_000,
      currency: 'COP',
      expirationTime: '2026-10-25T18:00:00.000Z',
      integritySecret: 'test_integrity_secreto',
    };
    expect(integritySignature(params)).toBe(sha256('BL-15000000COP2026-10-25T18:00:00.000Ztest_integrity_secreto'));
    expect(integritySignature({ ...params, amountInCents: 5_000_001 })).not.toBe(integritySignature(params));
  });
});

describe('uuidV5', () => {
  it('coincide con el vector de la RFC 4122 y es determinístico', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
    expect(uuidV5('tx-1', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      uuidV5('tx-1', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    );
  });
});

describe('configuración de Wompi', () => {
  const sandbox = {
    WOMPI_ENV: 'sandbox',
    WOMPI_PUBLIC_KEY: 'pub_test_AAAAAAAAAAAAAAAA',
    WOMPI_PRIVATE_KEY: 'prv_test_BBBBBBBBBBBBBBBB',
    WOMPI_INTEGRITY_SECRET: 'test_integrity_CCCCCCCCCCCCCCCC',
    WOMPI_EVENTS_SECRET: 'test_events_DDDDDDDDDDDDDDDD',
  };

  it('con llaves de sandbox usa la API de sandbox', () => {
    expect(readWompiConfig(sandbox).apiUrl).toBe('https://sandbox.wompi.co/v1');
  });

  it('no arranca con llaves de producción mientras WOMPI_ENV sea sandbox', () => {
    expect(() => readWompiConfig({ ...sandbox, WOMPI_PRIVATE_KEY: 'prv_prod_BBBBBBBBBBBBBBBB' })).toThrow(
      /WOMPI_PRIVATE_KEY es una llave de PRODUCCIÓN/,
    );
    expect(() => readWompiConfig({ ...sandbox, WOMPI_PUBLIC_KEY: 'pub_prod_AAAAAAAAAAAAAAAA' })).toThrow(
      /WOMPI_PUBLIC_KEY es una llave de PRODUCCIÓN/,
    );
  });

  it('no arranca si falta una llave, si WOMPI_ENV no es válido o con llaves de prueba en producción', () => {
    expect(() => readWompiConfig({ ...sandbox, WOMPI_EVENTS_SECRET: '' })).toThrow(
      /WOMPI_EVENTS_SECRET es obligatoria/,
    );
    expect(() => readWompiConfig({ ...sandbox, WOMPI_ENV: 'test' })).toThrow(/WOMPI_ENV/);
    expect(() => readWompiConfig({ ...sandbox, WOMPI_ENV: 'production' })).toThrow(/debe empezar por pub_prod_/);
  });

  it('los errores nunca muestran el valor de una llave', () => {
    try {
      readWompiConfig({ ...sandbox, WOMPI_PRIVATE_KEY: 'prv_prod_SECRETO123456789' });
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRETO123456789');
    }
    expect.assertions(1);
  });
});
