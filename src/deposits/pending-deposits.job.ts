import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DepositsService } from './deposits.service';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 30 * 1000;

/**
 * Cada PENDING_CHECK_INTERVAL_MS (5 min por defecto) revisa en Wompi las
 * recargas pendientes de más de 10 minutos: cubre los webhooks que no llegaron
 * y los abonos que el ledger no confirmó. Es el único lugar donde se reintenta
 * hablar con Wompi; una vuelta nunca se superpone con la anterior.
 */
@Injectable()
export class PendingDepositsJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PendingDepositsJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly deposits: DepositsService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get<string>('PENDING_CHECK_ENABLED') === 'false') {
      this.logger.warn('Proceso de recargas pendientes deshabilitado (PENDING_CHECK_ENABLED=false).');
      return;
    }
    const configured = Number(this.config.get<string>('PENDING_CHECK_INTERVAL_MS'));
    const interval = Number.isFinite(configured) && configured >= MIN_INTERVAL_MS ? configured : DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.run(), interval);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const { checked } = await this.deposits.reconcilePending();
      if (checked) this.logger.log(`Proceso de pendientes: ${checked} recarga(s) revisada(s) en Wompi.`);
    } catch (err) {
      this.logger.error(`Proceso de pendientes falló: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
