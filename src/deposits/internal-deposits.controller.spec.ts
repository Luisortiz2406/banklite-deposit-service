import { randomUUID } from 'crypto';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { Deposit, DepositStatus } from './entities/deposit.entity';
import { InternalDepositsController } from './internal-deposits.controller';

const asAccount = { internalCaller: 'account' } as never;

describeWithDb('Resumen de recargas para cancelar la cuenta (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let repo: Repository<Deposit>;
  let controller: InternalDepositsController;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('deposit_cierre', [Deposit]));
    repo = dataSource.getRepository(Deposit);
    controller = new InternalDepositsController(repo);
  });
  afterAll(() => drop?.());
  beforeEach(() => truncateAll(dataSource));

  const minutes = (m: number) => new Date(Date.now() + m * 60_000);
  const deposit = (userId: string, status: DepositStatus, expiresAt: Date, wompiTransactionId: string | null = null) =>
    repo.save(
      repo.create({
        reference: `BL-${randomUUID()}`,
        userId,
        accountId: randomUUID(),
        amount: '50000.00',
        amountInCents: '5000000',
        status,
        expiresAt,
        wompiTransactionId,
      }),
    );

  it('sin recargas: nada impide cancelar', async () => {
    expect(await controller.resumenCierre(randomUUID(), asAccount)).toEqual({
      recargasPendientes: 0,
      recargasEnRevision: 0,
      sinPendientes: true,
    });
  });

  it('cuenta las que aún pueden abonarse y las que están en revisión', async () => {
    const user = randomUUID();
    await deposit(user, 'PENDING', minutes(-120), 'tx-con-pago'); // pago iniciado: aunque venció
    await deposit(user, 'PENDING', minutes(20)); // widget abierto
    await deposit(user, 'PENDING', minutes(-30)); // venció hace poco: Wompi aún puede avisar
    await deposit(user, 'PENDING', minutes(-90)); // venció hace más de 1 h sin pago: no impide
    await deposit(user, 'REVIEW', minutes(-500), 'tx-revision');
    await deposit(user, 'APPROVED', minutes(-500), 'tx-ok');
    await deposit(user, 'DECLINED', minutes(-500), 'tx-no');
    await deposit(randomUUID(), 'PENDING', minutes(20)); // otro cliente

    expect(await controller.resumenCierre(user, asAccount)).toEqual({
      recargasPendientes: 3,
      recargasEnRevision: 1,
      sinPendientes: false,
    });
  });

  it('solo recargas terminadas o vencidas hace más de 1 h: puede cancelar', async () => {
    const user = randomUUID();
    await deposit(user, 'APPROVED', minutes(-10), 'tx-a');
    await deposit(user, 'EXPIRED', minutes(-200));
    await deposit(user, 'PENDING', minutes(-61));
    expect((await controller.resumenCierre(user, asAccount)).sinPendientes).toBe(true);
  });
});

describe('GET /internal/deposits/users/:idUser/resumen-cierre (permisos)', () => {
  const ACCOUNT_KEY = 'a1'.repeat(32);
  const LEDGER_KEY = 'b2'.repeat(32);
  const guard = new InternalKeyGuard(
    new ConfigService({ INTERNAL_TRUSTED_KEYS: `account:${ACCOUNT_KEY},ledger:${LEDGER_KEY}` }),
  );
  const ctx = (key?: string) => {
    const request: any = { headers: key ? { 'x-internal-key': key } : {} };
    return { request, context: { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext };
  };

  it('sin clave o desconocida: 401; ledger con clave válida: 403', async () => {
    expect(() => guard.canActivate(ctx().context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx('c3'.repeat(32)).context)).toThrow(UnauthorizedException);
    const ledger = ctx(LEDGER_KEY);
    expect(guard.canActivate(ledger.context)).toBe(true);
    const controller = new InternalDepositsController({} as never);
    await expect(controller.resumenCierre(randomUUID(), ledger.request)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
