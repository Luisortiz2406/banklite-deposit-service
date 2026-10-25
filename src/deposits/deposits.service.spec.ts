import { createHash, randomUUID } from 'crypto';
import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { WompiClient, WompiTransaction, WompiUnavailableError } from '../wompi/wompi.client';
import { readWompiConfig } from '../wompi/wompi.config';
import { integritySignature, WompiEvent } from '../wompi/wompi.signatures';
import { BankingClientService } from './banking-client.service';
import { DepositsService } from './deposits.service';
import { Deposit } from './entities/deposit.entity';

/**
 * Reglas de las recargas con Wompi contra un PostgreSQL real. Wompi y el ledger
 * se simulan: Wompi con un mapa de transacciones (lo que respondería su API) y
 * el ledger contando los abonos por clave de idempotencia, como hace el real.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const wompiConfig = readWompiConfig({
  WOMPI_ENV: 'sandbox',
  WOMPI_PUBLIC_KEY: 'pub_test_publica0123456789',
  WOMPI_PRIVATE_KEY: 'prv_test_privada0123456789',
  WOMPI_INTEGRITY_SECRET: 'test_integrity_integridad0123456789',
  WOMPI_EVENTS_SECRET: 'test_events_eventos0123456789',
});
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describeWithDb('DepositsService (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let repo: Repository<Deposit>;
  let service: DepositsService;

  // Wompi simulado: transacciones por id; `down` simula que no responde.
  let wompiTransactions: Map<string, WompiTransaction>;
  let wompiDown: boolean;
  const wompi = {
    getTransaction: jest.fn(async (id: string) => {
      if (wompiDown) throw new WompiUnavailableError('sin respuesta');
      return wompiTransactions.get(id) ?? null;
    }),
    findByReference: jest.fn(async (reference: string) => {
      if (wompiDown) throw new WompiUnavailableError('sin respuesta');
      return [...wompiTransactions.values()].filter((t) => t.reference === reference);
    }),
  };

  // Ledger simulado: idempotente por clave, como el real. `ledgerReply` fuerza una respuesta.
  let ledgerByKey: Map<string, string>;
  let ledgerReply: { status: number; message?: string } | null | undefined;
  const banking = {
    getOwnedAccount: jest.fn(async (accountId: string, token: string) => {
      if (token !== USER || accountId !== ACCOUNT) throw new BadRequestException('No tienes acceso a esta cuenta.');
      return { id: ACCOUNT, accountNumber: '10000000001', currency: 'COP', status: 'active' };
    }),
    cashIn: jest.fn(async (params: { idempotencyKey: string }) => {
      if (ledgerReply === null) return null;
      if (ledgerReply) {
        return { status: ledgerReply.status, ok: false, body: {}, message: ledgerReply.message ?? '' };
      }
      if (!ledgerByKey.has(params.idempotencyKey)) ledgerByKey.set(params.idempotencyKey, randomUUID());
      return { status: 201, ok: true, body: { id: ledgerByKey.get(params.idempotencyKey)! }, message: '' };
    }),
  };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('deposit', [Deposit]));
    repo = dataSource.getRepository(Deposit);
    service = new DepositsService(
      repo,
      banking as unknown as BankingClientService,
      wompi as unknown as WompiClient,
      wompiConfig,
      new ConfigService({ DEPOSIT_MIN_AMOUNT: '10000', DEPOSIT_MAX_AMOUNT: '2000000' }),
    );
  });

  afterAll(() => drop?.());

  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.clearAllMocks();
    wompiTransactions = new Map();
    wompiDown = false;
    ledgerByKey = new Map();
    ledgerReply = undefined;
  });

  const createDeposit = (amount = 50_000) => service.create(USER, USER, { accountId: ACCOUNT, amount });

  /** Registra en el Wompi simulado una transacción para la recarga. */
  const wompiTx = (reference: string, overrides: Partial<WompiTransaction> = {}): WompiTransaction => {
    const tx: WompiTransaction = {
      id: `tx-${randomUUID()}`,
      reference,
      amountInCents: 5_000_000,
      currency: 'COP',
      status: 'APPROVED',
      statusMessage: null,
      paymentMethodType: 'CARD',
      ...overrides,
    };
    wompiTransactions.set(tx.id, tx);
    return tx;
  };

  /** Evento transaction.updated firmado con el secreto de eventos (lo que manda Wompi). */
  const event = (tx: { id: string; status: string; amountInCents: number }, environment = 'test'): WompiEvent => {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      event: 'transaction.updated',
      data: { transaction: { id: tx.id, status: tx.status, amount_in_cents: tx.amountInCents } },
      environment,
      signature: {
        properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
        checksum: sha256(`${tx.id}${tx.status}${tx.amountInCents}${timestamp}${wompiConfig.eventsSecret}`),
      },
      timestamp,
    };
  };
  const statusOf = async (id: string) => (await repo.findOneByOrFail({ id })).status;

  describe('crear la recarga', () => {
    it('queda PENDING con referencia única y la firma de integridad del monto fijado por el servidor', async () => {
      const created = await createDeposit(50_000);

      expect(created.status).toBe('PENDING');
      expect(created.reference).toMatch(/^BL-[0-9a-f-]{36}$/);
      expect(created.checkout).toMatchObject({
        publicKey: wompiConfig.publicKey,
        currency: 'COP',
        amountInCents: 5_000_000,
        reference: created.reference,
      });
      expect(created.checkout.signature.integrity).toBe(
        integritySignature({
          reference: created.reference,
          amountInCents: 5_000_000,
          currency: 'COP',
          expirationTime: created.checkout.expirationTime,
          integritySecret: wompiConfig.integritySecret,
        }),
      );
      expect((await createDeposit()).reference).not.toBe(created.reference);
    });

    it('respeta el mínimo y el máximo', async () => {
      await expect(createDeposit(9_999)).rejects.toThrow('entre 10000 y 2000000');
      await expect(createDeposit(2_000_001)).rejects.toThrow('entre 10000 y 2000000');
      expect(await repo.count()).toBe(0);
    });

    it('solo a una cuenta propia', async () => {
      await expect(service.create(OTHER_USER, OTHER_USER, { accountId: ACCOUNT, amount: 50_000 })).rejects.toThrow(
        'No tienes acceso',
      );
      expect(await repo.count()).toBe(0);
    });

    it('un cliente no ve las recargas de otro', async () => {
      const created = await createDeposit();
      await expect(service.get(OTHER_USER, created.id)).rejects.toThrow('Recarga no encontrada');
    });
  });

  describe('webhook', () => {
    it('firma inválida: 401, no consulta a Wompi y no abona', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference);
      const forged = event(tx);
      forged.signature!.checksum = sha256('cualquier cosa');

      await expect(service.handleEvent(forged, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(wompi.getTransaction).not.toHaveBeenCalled();
      expect(banking.cashIn).not.toHaveBeenCalled();
      expect(await statusOf(created.id)).toBe('PENDING');
    });

    it('aprobada: consulta a Wompi y abona el monto de la recarga una sola vez', async () => {
      const created = await createDeposit(50_000);
      const tx = wompiTx(created.reference);

      expect(await service.handleEvent(event(tx), undefined)).toBe('processed');

      expect(wompi.getTransaction).toHaveBeenCalledWith(tx.id);
      expect(banking.cashIn).toHaveBeenCalledTimes(1);
      expect(banking.cashIn).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ACCOUNT, amount: 50_000, description: 'Recarga Wompi · Tarjeta' }),
      );
      const saved = await repo.findOneByOrFail({ id: created.id });
      expect(saved).toMatchObject({ status: 'APPROVED', wompiTransactionId: tx.id, paymentMethodType: 'CARD' });
      expect(saved.ledgerTransactionId).toBe([...ledgerByKey.values()][0]);
    });

    it('webhook duplicado: no abona dos veces', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference);

      await service.handleEvent(event(tx), undefined);
      await service.handleEvent(event(tx), undefined);
      await Promise.all([service.handleEvent(event(tx), undefined), service.handleEvent(event(tx), undefined)]);

      expect(ledgerByKey.size).toBe(1);
      expect(await statusOf(created.id)).toBe('APPROVED');
    });

    it('si el ledger no responde: 503 para que Wompi reintente, y el reintento usa la misma clave', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference);

      ledgerReply = null;
      await expect(service.handleEvent(event(tx), undefined)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await statusOf(created.id)).toBe('PENDING');

      ledgerReply = undefined;
      await service.handleEvent(event(tx), undefined);
      const keys = banking.cashIn.mock.calls.map(([params]) => params.idempotencyKey);
      expect(new Set(keys).size).toBe(1);
      expect(await statusOf(created.id)).toBe('APPROVED');
    });

    it('rechazada: queda DECLINED y no abona', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference, { status: 'DECLINED', paymentMethodType: 'NEQUI' });

      await service.handleEvent(event(tx), undefined);

      expect(banking.cashIn).not.toHaveBeenCalled();
      expect(await statusOf(created.id)).toBe('DECLINED');
    });

    it('anulada o con error: queda VOIDED / ERROR y no abona', async () => {
      const voided = await createDeposit();
      const errored = await createDeposit();
      await service.handleEvent(event(wompiTx(voided.reference, { status: 'VOIDED' })), undefined);
      await service.handleEvent(event(wompiTx(errored.reference, { status: 'ERROR' })), undefined);

      expect(banking.cashIn).not.toHaveBeenCalled();
      expect(await statusOf(voided.id)).toBe('VOIDED');
      expect(await statusOf(errored.id)).toBe('ERROR');
    });

    it('monto alterado: queda AMOUNT_MISMATCH y no abona', async () => {
      const created = await createDeposit(50_000);
      const tx = wompiTx(created.reference, { amountInCents: 100 });

      await service.handleEvent(event(tx), undefined);

      expect(banking.cashIn).not.toHaveBeenCalled();
      expect(await statusOf(created.id)).toBe('AMOUNT_MISMATCH');
    });

    it('el estado sale de la API de Wompi, no del cuerpo del evento', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference, { status: 'DECLINED' });

      // El evento (bien firmado) dice APPROVED, pero Wompi responde DECLINED.
      await service.handleEvent(event({ ...tx, status: 'APPROVED' }), undefined);

      expect(banking.cashIn).not.toHaveBeenCalled();
      expect(await statusOf(created.id)).toBe('DECLINED');
    });

    it('descarta eventos de otro ambiente y de referencias ajenas', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference);
      const foreign = wompiTx('PEDIDO-DE-OTRA-TIENDA');

      expect(await service.handleEvent(event(tx, 'prod'), undefined)).toBe('ignored');
      expect(await service.handleEvent(event(foreign), undefined)).toBe('ignored');
      expect(banking.cashIn).not.toHaveBeenCalled();
      expect(await statusOf(created.id)).toBe('PENDING');
    });

    it('si Wompi no responde: 503 y la recarga sigue pendiente', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference);
      wompiDown = true;

      await expect(service.handleEvent(event(tx), undefined)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await statusOf(created.id)).toBe('PENDING');
    });

    it('anulación de una recarga ya abonada: pasa a REVIEW sin mover dinero', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference);
      await service.handleEvent(event(tx), undefined);

      tx.status = 'VOIDED';
      await service.handleEvent(event(tx), undefined);

      expect(banking.cashIn).toHaveBeenCalledTimes(1);
      expect(await statusOf(created.id)).toBe('REVIEW');
    });

    it('si el ledger rechaza el abono (4xx): REVIEW', async () => {
      const created = await createDeposit();
      const tx = wompiTx(created.reference);
      ledgerReply = { status: 400, message: 'La cuenta de destino no está activa.' };

      await service.handleEvent(event(tx), undefined);

      const saved = await repo.findOneByOrFail({ id: created.id });
      expect(saved.status).toBe('REVIEW');
      expect(saved.statusMessage).toContain('no está activa');
    });
  });

  describe('proceso de pendientes', () => {
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    it('abona una recarga aprobada cuyo webhook no llegó (buscando por referencia)', async () => {
      const created = await createDeposit();
      wompiTx(created.reference, { paymentMethodType: 'PSE' });

      await service.reconcilePending(later(15));

      expect(wompi.findByReference).toHaveBeenCalledWith(created.reference);
      expect(banking.cashIn).toHaveBeenCalledWith(expect.objectContaining({ description: 'Recarga Wompi · PSE' }));
      expect(await statusOf(created.id)).toBe('APPROVED');
    });

    it('no toca las recargas recientes', async () => {
      const created = await createDeposit();
      wompiTx(created.reference);

      await service.reconcilePending(later(1));

      expect(wompi.findByReference).not.toHaveBeenCalled();
      expect(await statusOf(created.id)).toBe('PENDING');
    });

    it('sin ninguna transacción después del vencimiento: EXPIRED', async () => {
      const created = await createDeposit();

      await service.reconcilePending(later(20));
      expect(await statusOf(created.id)).toBe('PENDING');

      await service.reconcilePending(later(30 + 61));
      expect(await statusOf(created.id)).toBe('EXPIRED');
    });

    it('si Wompi no responde, la recarga sigue pendiente para la próxima vuelta', async () => {
      const created = await createDeposit();
      wompiTx(created.reference);
      wompiDown = true;

      await service.reconcilePending(later(15));

      expect(await statusOf(created.id)).toBe('PENDING');
      expect((await repo.findOneByOrFail({ id: created.id })).checkAttempts).toBe(1);
    });
  });

  it('sync: el id que manda el navegador solo sirve si la transacción es de esa recarga', async () => {
    const mine = await createDeposit();
    const other = await createDeposit();
    const othersTx = wompiTx(other.reference);

    const result = await service.sync(USER, mine.id, othersTx.id);

    expect(result.status).toBe('PENDING');
    expect(banking.cashIn).not.toHaveBeenCalled();
  });
});
