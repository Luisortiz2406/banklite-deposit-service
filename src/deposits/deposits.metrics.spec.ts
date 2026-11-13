import { createHash, randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Counter } from 'prom-client';
import { FindOperator, Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { PAYMENT_RESULTS, PaymentGatewayMetrics } from '../metrics/payment-gateway-metrics';
import { WompiClient, WompiTransaction } from '../wompi/wompi.client';
import { readWompiConfig } from '../wompi/wompi.config';
import { WompiEvent } from '../wompi/wompi.signatures';
import { BankingClientService } from './banking-client.service';
import { DepositsService, RetryLaterError } from './deposits.service';
import { Deposit, DepositStatus } from './entities/deposit.entity';

/**
 * payment_gateway_payments_total (repositorio, pasarela y ledger simulados, sin base de datos). Cada resultado se
 * cuenta UNA vez y solo cuando el cambio de estado se guardó; contar nunca rompe un pago ni un webhook.
 */
const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const wompiConfig = readWompiConfig({
  WOMPI_ENV: 'sandbox',
  WOMPI_PUBLIC_KEY: 'pub_test_publica0123456789',
  WOMPI_PRIVATE_KEY: 'prv_test_privada0123456789',
  WOMPI_INTEGRITY_SECRET: 'test_integrity_integridad0123456789',
  WOMPI_EVENTS_SECRET: 'test_events_eventos0123456789',
});
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Repositorio en memoria: findOne/update con la semántica condicional que usa el servicio (estado esperado). */
function fakeRepository() {
  const rows = new Map<string, Deposit>();
  const matches = (row: Deposit, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, expected]) => {
      const actual = (row as unknown as Record<string, unknown>)[key];
      if (expected instanceof FindOperator) return (expected.value as unknown[]).includes(actual);
      return actual === expected;
    });
  const repo = {
    rows,
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = [...rows.values()].find((r) => matches(r, where));
      return row ? { ...row } : null;
    }),
    update: jest.fn(async (where: Record<string, unknown>, changes: Partial<Deposit>) => {
      let affected = 0;
      for (const row of rows.values()) {
        if (matches(row, where)) {
          Object.assign(row, changes);
          affected++;
        }
      }
      return { affected };
    }),
  };
  return repo;
}

function setup() {
  const repo = fakeRepository();
  const wompi = { getTransaction: jest.fn(), findByReference: jest.fn().mockResolvedValue([]) };
  const banking = { cashIn: jest.fn() };
  const metricsService = new MetricsService(new ConfigService({}));
  const metrics = new PaymentGatewayMetrics(metricsService);
  const service = new DepositsService(
    repo as unknown as Repository<Deposit>,
    banking as unknown as BankingClientService,
    wompi as unknown as WompiClient,
    wompiConfig,
    new ConfigService({}),
    metrics,
  );
  banking.cashIn.mockImplementation(async () => ({ status: 201, ok: true, body: { id: randomUUID() }, message: '' }));
  const counter = () => metricsService.registry.getSingleMetric('payment_gateway_payments_total') as Counter;
  const counted = async () => {
    const { values } = await counter().get();
    return Object.fromEntries(values.filter((v) => v.value > 0).map((v) => [v.labels.result, v.value]));
  };
  const deposit = (over: Partial<Deposit> = {}): Deposit => {
    const row = {
      id: randomUUID(),
      reference: `BL-${randomUUID()}`,
      userId: USER,
      accountId: ACCOUNT,
      amount: '50000.00',
      amountInCents: '5000000',
      currency: 'COP',
      status: 'PENDING' as DepositStatus,
      wompiTransactionId: null,
      paymentMethodType: null,
      statusMessage: null,
      ledgerTransactionId: null,
      creditedAt: null,
      checkAttempts: 0,
      lastCheckedAt: null,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      createdAt: new Date(),
      ...over,
    } as unknown as Deposit;
    repo.rows.set(row.id, row);
    return { ...row };
  };
  const tx = (reference: string, over: Partial<WompiTransaction> = {}): WompiTransaction => ({
    id: `tx-${randomUUID()}`,
    reference,
    amountInCents: 5_000_000,
    currency: 'COP',
    status: 'APPROVED',
    statusMessage: null,
    paymentMethodType: 'CARD',
    ...over,
  });
  return { service, repo, wompi, banking, metricsService, counter, counted, deposit, tx };
}

describe('payment_gateway_payments_total', () => {
  describe('approved', () => {
    it('se cuenta cuando la pasarela aprobó y el ledger abonó la recarga (quedó APPROVED)', async () => {
      const { service, deposit, tx, counted } = setup();
      const d = deposit();

      const result = await service.apply(d, tx(d.reference));

      expect(result.status).toBe('APPROVED');
      expect(await counted()).toEqual({ approved: 1 });
    });

    it('si el ledger no responde no se cuenta (sigue pendiente); al reintentar y abonar, se cuenta una vez', async () => {
      const { service, banking, deposit, tx, counted } = setup();
      const d = deposit();
      const t = tx(d.reference);
      banking.cashIn.mockResolvedValueOnce(null);

      await expect(service.apply(d, t)).rejects.toBeInstanceOf(RetryLaterError);
      expect(await counted()).toEqual({});

      await service.apply(d, t);

      expect(await counted()).toEqual({ approved: 1 });
    });

    it('si el ledger rechaza el abono (4xx) la recarga queda en REVIEW y no cuenta como aprobada', async () => {
      const { service, banking, deposit, tx, counted } = setup();
      const d = deposit();
      banking.cashIn.mockResolvedValueOnce({ status: 403, ok: false, body: {}, message: 'Cuenta bloqueada' });

      const result = await service.apply(d, tx(d.reference));

      expect(result.status).toBe('REVIEW');
      expect(await counted()).toEqual({});
    });

    it('el mismo pago procesado dos veces a la vez (webhook y cierre del widget) se cuenta una sola vez', async () => {
      const { service, deposit, tx, counted } = setup();
      const d = deposit();
      const t = tx(d.reference);

      // Las dos parten de la recarga PENDING; solo una logra el cambio de estado.
      await Promise.all([service.apply({ ...d }, t), service.apply({ ...d }, t)]);

      expect(await counted()).toEqual({ approved: 1 });
    });

    it('repetir el pago sobre una recarga ya aprobada no vuelve a contar', async () => {
      const { service, deposit, tx, counted } = setup();
      const d = deposit();
      const t = tx(d.reference);
      await service.apply(d, t);
      await service.apply({ ...d, status: 'APPROVED', wompiTransactionId: t.id }, t);
      await service.apply(d, t);

      expect(await counted()).toEqual({ approved: 1 });
    });
  });

  describe('declined, voided y error', () => {
    it.each([
      ['DECLINED', 'declined'],
      ['VOIDED', 'voided'],
      ['ERROR', 'error'],
    ])('un pago %s de la pasarela se cuenta como %s, una sola vez, y no se abona', async (status, result) => {
      const { service, banking, deposit, tx, counted } = setup();
      const d = deposit();
      const t = tx(d.reference, { status: status as WompiTransaction['status'] });

      await service.apply({ ...d }, t);
      await service.apply({ ...d }, t); // otra entrega del mismo resultado

      expect(await counted()).toEqual({ [result]: 1 });
      expect(banking.cashIn).not.toHaveBeenCalled();
    });

    it('la pasarela anula una recarga YA abonada: pasa a REVIEW y se cuenta voided una sola vez', async () => {
      const { service, deposit, tx, counted, repo } = setup();
      const d = deposit();
      const t = tx(d.reference);
      await service.apply(d, t);
      const approved = { ...repo.rows.get(d.id)! };
      expect(approved.status).toBe('APPROVED');

      const voided = { ...t, status: 'VOIDED' as const };
      await service.apply({ ...approved }, voided);
      await service.apply({ ...approved }, voided);

      expect(repo.rows.get(d.id)!.status).toBe('REVIEW');
      expect(await counted()).toEqual({ approved: 1, voided: 1 });
    });
  });

  describe('lo que NO se cuenta', () => {
    it('pago pendiente, monto distinto, transacción de otra recarga y recarga expirada', async () => {
      const { service, deposit, tx, wompi, counted } = setup();
      const pending = deposit();
      await service.apply(pending, tx(pending.reference, { status: 'PENDING' }));

      const mismatch = deposit();
      const resultado = await service.apply(mismatch, tx(mismatch.reference, { amountInCents: 9_900_000 }));
      expect(resultado.status).toBe('AMOUNT_MISMATCH');

      const other = deposit();
      await expect(service.apply(other, tx(`BL-${randomUUID()}`))).rejects.toThrow('no corresponde');

      const old = deposit({ expiresAt: new Date(Date.now() - 3 * 60 * 60_000) });
      wompi.findByReference.mockResolvedValueOnce([]);
      expect((await service.sync(USER, old.id)).status).toBe('EXPIRED');

      expect(await counted()).toEqual({});
    });
  });

  describe('por el webhook', () => {
    const event = (t: { id: string; status: string; amountInCents: number }): WompiEvent => {
      const timestamp = Math.floor(Date.now() / 1000);
      return {
        event: 'transaction.updated',
        data: { transaction: { id: t.id, status: t.status, amount_in_cents: t.amountInCents } },
        environment: 'test',
        signature: {
          properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
          checksum: sha256(`${t.id}${t.status}${t.amountInCents}${timestamp}${wompiConfig.eventsSecret}`),
        },
        timestamp,
      };
    };

    it('un evento aprobado cuenta approved y el mismo evento repetido no lo cuenta otra vez', async () => {
      const { service, wompi, deposit, tx, counted } = setup();
      const d = deposit();
      const t = tx(d.reference);
      wompi.getTransaction.mockResolvedValue(t);
      const e = event(t);

      expect(await service.handleEvent(e, undefined)).toBe('processed');
      expect(await service.handleEvent(e, undefined)).toBe('processed');

      expect(await counted()).toEqual({ approved: 1 });
    });

    it('un evento con firma inválida o de otra referencia no cuenta nada', async () => {
      const { service, wompi, deposit, tx, counted } = setup();
      const d = deposit();
      const t = tx(`BL-${randomUUID()}`);
      wompi.getTransaction.mockResolvedValue(t);
      const e = event(t);

      await expect(service.handleEvent(e, 'firma-falsa')).rejects.toThrow();
      expect(await service.handleEvent(e, undefined)).toBe('ignored');

      expect(d.status).toBe('PENDING');
      expect(await counted()).toEqual({});
    });
  });

  describe('contar nunca rompe un pago ni un webhook', () => {
    it('si contar lanza, la recarga igual se abona y el pago termina APPROVED', async () => {
      const { service, deposit, tx, counter, banking, repo } = setup();
      jest.spyOn(counter(), 'inc').mockImplementation(() => {
        throw new Error('prom-client roto');
      });
      const d = deposit();

      const result = await service.apply(d, tx(d.reference));

      expect(result.status).toBe('APPROVED');
      expect(repo.rows.get(d.id)!.status).toBe('APPROVED');
      expect(banking.cashIn).toHaveBeenCalledTimes(1);
    });

    it('si contar lanza, el webhook responde procesado (la pasarela no reintenta) y un pago rechazado queda DECLINED', async () => {
      const { service, wompi, deposit, tx, counter, repo } = setup();
      jest.spyOn(counter(), 'inc').mockImplementation(() => {
        throw new Error('prom-client roto');
      });
      const d = deposit();
      const t = tx(d.reference, { status: 'DECLINED' });
      wompi.getTransaction.mockResolvedValue(t);
      const timestamp = Math.floor(Date.now() / 1000);
      const e: WompiEvent = {
        event: 'transaction.updated',
        data: { transaction: { id: t.id, status: t.status, amount_in_cents: t.amountInCents } },
        environment: 'test',
        signature: {
          properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
          checksum: sha256(`${t.id}${t.status}${t.amountInCents}${timestamp}${wompiConfig.eventsSecret}`),
        },
        timestamp,
      };

      expect(await service.handleEvent(e, undefined)).toBe('processed');
      expect(repo.rows.get(d.id)!.status).toBe('DECLINED');
    });

    it('si el servicio de métricas falla del todo (record lanza), el pago tampoco se rompe', async () => {
      const { service, deposit, tx, metricsService, repo } = setup();
      const dañado = {
        record: () => {
          throw new Error('métrica dañada');
        },
      } as unknown as PaymentGatewayMetrics;
      Object.assign(service, { metrics: dañado });
      const d = deposit();

      await expect(service.apply(d, tx(d.reference))).resolves.toMatchObject({ status: 'APPROVED' });

      expect(repo.rows.get(d.id)!.status).toBe('APPROVED');
      expect(metricsService).toBeDefined();
    });

    it('PaymentGatewayMetrics: ni el constructor ni record() lanzan (métrica duplicada o prom-client roto)', () => {
      const metricsService = new MetricsService(new ConfigService({}));
      const primera = new PaymentGatewayMetrics(metricsService);
      const segunda = new PaymentGatewayMetrics(metricsService); // ya estaba registrada
      jest
        .spyOn(metricsService.registry.getSingleMetric('payment_gateway_payments_total') as Counter, 'inc')
        .mockImplementation(() => {
          throw new Error('roto');
        });

      expect(() => segunda.record('approved')).not.toThrow();
      expect(() => primera.record('declined')).not.toThrow();
    });
  });

  describe('etiquetas: lista cerrada, sin datos sensibles ni nombres de proveedores', () => {
    it('las 4 series existen desde el arranque en 0 y solo hay la etiqueta result', async () => {
      const { counter } = setup();
      const { values } = await counter().get();

      expect(values.map((v) => v.labels.result).sort()).toEqual([...PAYMENT_RESULTS].sort());
      for (const v of values) {
        expect(Object.keys(v.labels)).toEqual(['result']);
        expect(v.value).toBe(0);
      }
    });

    it('tras pagos con referencias, ids, montos, medios de pago y mensajes, la métrica publicada no los contiene', async () => {
      const { service, deposit, tx, metricsService } = setup();
      const a = deposit();
      const b = deposit({ amount: '987654.00', amountInCents: '98765400' });
      const ta = tx(a.reference, {
        paymentMethodType: 'CARD',
        statusMessage: 'Tarjeta 4242 4242 4242 4242 de ana@correo.com',
      });
      const tb = tx(b.reference, { status: 'DECLINED', amountInCents: 98_765_400, paymentMethodType: 'NEQUI' });
      await service.apply(a, ta);
      await service.apply(b, tb);

      const text = await metricsService.registry.metrics();
      const lineas = text.split('\n').filter((l) => l.startsWith('payment_gateway_payments_total'));
      const etiquetas = lineas.map((l) => l.slice(l.indexOf('{'), l.indexOf('}') + 1)).join(' ');
      const propias = text
        .split('\n')
        .filter((l) => /^(# (HELP|TYPE) )?payment_gateway_payments_total/.test(l))
        .join('\n');

      expect(lineas).toHaveLength(PAYMENT_RESULTS.length);
      for (const dato of [
        a.reference,
        a.id,
        ta.id,
        tb.id,
        USER,
        ACCOUNT,
        '50000',
        '987654',
        '4242',
        'ana@',
        'CARD',
        'NEQUI',
        'BL-',
      ]) {
        expect(propias).not.toContain(dato);
      }
      for (const m of etiquetas.matchAll(/result="([^"]+)"/g)) expect(PAYMENT_RESULTS).toContain(m[1]);
      // Ningún nombre de proveedor ni de medio de pago real en la métrica, su ayuda ni sus etiquetas.
      expect(propias).not.toMatch(/wompi|nequi|bancolombia|daviplata|pse\b|visa|mastercard/i);
    });
  });
});
