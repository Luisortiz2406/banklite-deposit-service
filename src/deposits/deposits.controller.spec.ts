import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DepositsController, WompiEventsController } from './deposits.controller';
import { DepositsService } from './deposits.service';
import { PendingDepositsJob } from './pending-deposits.job';

const guardsOf = (controller: object) => Reflect.getMetadata('__guards__', controller) ?? [];

describe('DepositsController', () => {
  const service = {
    getConfig: jest.fn().mockReturnValue({ min: 10_000 }),
    list: jest.fn().mockResolvedValue(['d1']),
    create: jest.fn().mockResolvedValue({ id: 'd1' }),
    get: jest.fn().mockResolvedValue({ id: 'd1' }),
    sync: jest.fn().mockResolvedValue({ status: 'APPROVED' }),
    handleEvent: jest.fn().mockResolvedValue('applied'),
  };
  const request = { user: { idUser: 'user-1' }, accessToken: 'token-1' } as never;
  const controller = new DepositsController(service as unknown as DepositsService);

  it('las recargas del cliente exigen sesión y siempre usan al cliente de la sesión', async () => {
    expect(guardsOf(DepositsController)).toContain(JwtAuthGuard);

    expect(controller.config()).toEqual({ min: 10_000 });
    expect(await controller.list(request)).toEqual(['d1']);
    expect(service.list).toHaveBeenCalledWith('user-1');
    const dto = { accountId: 'a1', amount: 50_000 } as never;
    await controller.create(dto, request);
    expect(service.create).toHaveBeenCalledWith('user-1', 'token-1', dto);
    await controller.get('d1', request);
    expect(service.get).toHaveBeenCalledWith('user-1', 'd1');
    await controller.sync('d1', { transactionId: 'tx-1' }, request);
    expect(service.sync).toHaveBeenCalledWith('user-1', 'd1', 'tx-1');
  });

  it('el webhook de Wompi no usa sesión (la firma del evento es la autenticidad) y pasa la firma tal cual', async () => {
    const events = new WompiEventsController(service as unknown as DepositsService);
    expect(guardsOf(WompiEventsController)).toEqual([]);

    expect(await events.events({ event: 'transaction.updated' } as never, 'checksum-1')).toEqual({
      received: true,
      outcome: 'applied',
    });
    expect(service.handleEvent).toHaveBeenCalledWith({ event: 'transaction.updated' }, 'checksum-1');

    await events.events(undefined as never, undefined);
    expect(service.handleEvent).toHaveBeenLastCalledWith({}, undefined);
  });
});

describe('PendingDepositsJob', () => {
  afterEach(() => jest.useRealTimers());
  const build = (env: Record<string, string> = {}, reconcile = jest.fn().mockResolvedValue({ checked: 2 })) => {
    const deposits = { reconcilePending: reconcile };
    return { job: new PendingDepositsJob(deposits as unknown as DepositsService, new ConfigService(env)), reconcile };
  };

  it('revisa las recargas pendientes cada 5 minutos por defecto y se detiene al cerrar el módulo', async () => {
    jest.useFakeTimers();
    const { job, reconcile } = build();

    job.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(reconcile).toHaveBeenCalledTimes(1);

    job.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('el intervalo se puede configurar, pero uno menor a 30 s o inválido vuelve al de 5 minutos', async () => {
    jest.useFakeTimers();
    const fast = build({ PENDING_CHECK_INTERVAL_MS: '60000' });
    fast.job.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fast.reconcile).toHaveBeenCalledTimes(1);
    fast.job.onModuleDestroy();

    for (const bad of ['1000', 'abc']) {
      const slow = build({ PENDING_CHECK_INTERVAL_MS: bad });
      slow.job.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(slow.reconcile).not.toHaveBeenCalled();
      slow.job.onModuleDestroy();
    }
  });

  it('se puede apagar con PENDING_CHECK_ENABLED=false', async () => {
    jest.useFakeTimers();
    const { job, reconcile } = build({ PENDING_CHECK_ENABLED: 'false' });

    job.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(reconcile).not.toHaveBeenCalled();
  });

  it('una vuelta nunca se superpone con la anterior, y un error se registra sin detener el proceso', async () => {
    let release!: () => void;
    const slow = jest.fn(
      () => new Promise<{ checked: number }>((resolve) => (release = () => resolve({ checked: 0 }))),
    );
    const { job, reconcile } = build({}, slow);

    const first = job.run();
    await job.run(); // la segunda se salta
    expect(reconcile).toHaveBeenCalledTimes(1);
    release();
    await first;

    reconcile.mockRejectedValueOnce(new Error('Wompi caído'));
    await expect(job.run()).resolves.toBeUndefined();
    reconcile.mockResolvedValueOnce({ checked: 1 });
    await job.run();
    expect(reconcile).toHaveBeenCalledTimes(3);
  });
});
