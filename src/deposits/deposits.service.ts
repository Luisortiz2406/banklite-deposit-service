import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, IsNull, LessThan, MoreThan, Or, Repository } from 'typeorm';
import { PaymentGatewayMetrics, PaymentResult } from '../metrics/payment-gateway-metrics';
import { WOMPI_CONFIG, WompiClient, WompiTransaction, WompiUnavailableError } from '../wompi/wompi.client';
import { WompiConfig } from '../wompi/wompi.config';
import { integritySignature, isValidEventSignature, uuidV5, WompiEvent } from '../wompi/wompi.signatures';
import { BankingClientService } from './banking-client.service';
import { CreateDepositDto } from './dto/deposit.dto';
import { Deposit, DepositStatus } from './entities/deposit.entity';

const DEFAULT_MIN_AMOUNT = 10_000;
const DEFAULT_MAX_AMOUNT = 2_000_000;
const CURRENCY = 'COP';
// Tiempo para pagar en el widget (va en la firma de integridad: Wompi no acepta pagos después).
const CHECKOUT_TTL_MS = 30 * 60 * 1000;
// Recargas pendientes que puede tener abiertas un cliente a la vez.
const MAX_OPEN_DEPOSITS = 5;
// Proceso de pendientes: revisa las que llevan más de 10 min, hasta 50 por vuelta.
const STALE_AFTER_MS = 10 * 60 * 1000;
const RECONCILE_BATCH = 50;
// Sin ninguna transacción en Wompi una hora después del vencimiento: la recarga expira.
const EXPIRE_GRACE_MS = 60 * 60 * 1000;
// Espacio de nombres (UUID v5) de las claves de idempotencia de los abonos: id de Wompi → clave del ledger.
const LEDGER_KEY_NAMESPACE = '6f1c2a4e-3b7d-4e8a-9c5f-0d2e4b6a8c10';
const REFERENCE_PREFIX = 'BL-';

const FINAL_WOMPI_STATUSES: Record<string, DepositStatus> = {
  DECLINED: 'DECLINED',
  VOIDED: 'VOIDED',
  ERROR: 'ERROR',
};

// Resultado de métricas (lista cerrada) de cada estado final de la pasarela.
const RESULT_BY_STATUS: Partial<Record<DepositStatus, PaymentResult>> = {
  DECLINED: 'declined',
  VOIDED: 'voided',
  ERROR: 'error',
};

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Tarjeta',
  PSE: 'PSE',
  NEQUI: 'Nequi',
  BANCOLOMBIA_TRANSFER: 'Botón Bancolombia',
  BANCOLOMBIA_QR: 'QR Bancolombia',
  DAVIPLATA: 'Daviplata',
};

/** El ledger no respondió o falló de forma incierta: la recarga sigue pendiente y se reintenta con la misma clave. */
export class RetryLaterError extends Error {}

export type EventOutcome = 'processed' | 'ignored';

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    @InjectRepository(Deposit) private readonly deposits: Repository<Deposit>,
    private readonly banking: BankingClientService,
    private readonly wompi: WompiClient,
    @Inject(WOMPI_CONFIG) private readonly wompiConfig: WompiConfig,
    private readonly config: ConfigService,
    private readonly metrics: PaymentGatewayMetrics,
  ) {}

  /**
   * Cuenta el resultado de un pago en payment_gateway_payments_total. NUNCA puede romper un pago ni un
   * webhook: se llama después de guardar el cambio de estado y cualquier fallo se ignora.
   */
  private countPayment(result: PaymentResult | undefined) {
    if (!result) return;
    try {
      this.metrics.record(result);
    } catch {
      // ignorar: la métrica no es parte del pago
    }
  }

  getConfig() {
    return {
      minAmount: this.minAmount(),
      maxAmount: this.maxAmount(),
      currency: CURRENCY,
      environment: this.wompiConfig.environment,
    };
  }

  /** Crea la recarga PENDING con su referencia y la firma de integridad para el widget. */
  async create(userId: string, accessToken: string, dto: CreateDepositDto) {
    const min = this.minAmount();
    const max = this.maxAmount();
    if (dto.amount < min || dto.amount > max) {
      throw new BadRequestException(`El monto de la recarga debe estar entre ${min} y ${max} pesos.`);
    }

    const account = await this.banking.getOwnedAccount(dto.accountId, accessToken);
    if (account.status !== 'active') throw new BadRequestException('La cuenta no está activa.');
    if (account.currency !== CURRENCY) throw new BadRequestException('Las recargas solo están disponibles en pesos.');

    const open = await this.deposits.count({
      where: { userId, status: 'PENDING', expiresAt: MoreThan(new Date()), wompiTransactionId: IsNull() },
    });
    if (open >= MAX_OPEN_DEPOSITS) {
      throw new BadRequestException('Tienes demasiadas recargas sin pagar. Espera unos minutos e inténtalo de nuevo.');
    }

    const deposit = await this.deposits.save(
      this.deposits.create({
        reference: `${REFERENCE_PREFIX}${randomUUID()}`,
        userId,
        accountId: account.id,
        amount: dto.amount.toFixed(2),
        amountInCents: String(dto.amount * 100),
        currency: CURRENCY,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
      }),
    );
    return { ...this.toView(deposit), checkout: this.checkoutFor(deposit) };
  }

  async list(userId: string) {
    const rows = await this.deposits.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 20 });
    return rows.map((d) => this.toView(d));
  }

  async get(userId: string, id: string) {
    return this.toView(await this.owned(userId, id));
  }

  /**
   * Revisa en Wompi una recarga del cliente (al cerrar el widget). El id de
   * transacción que manda el navegador solo dice dónde buscar: se consulta a
   * Wompi y se exige que la referencia sea la de esta recarga.
   */
  async sync(userId: string, id: string, transactionId?: string) {
    const deposit = await this.owned(userId, id);
    if (deposit.status !== 'PENDING') return this.toView(deposit);
    try {
      const updated = await this.checkWithWompi(deposit, transactionId);
      return this.toView(updated);
    } catch (err) {
      if (err instanceof WompiUnavailableError || err instanceof RetryLaterError) {
        // Sigue pendiente: el webhook o el proceso de pendientes la terminan.
        return this.toView(deposit);
      }
      throw err;
    }
  }

  /**
   * Webhook de Wompi. Verifica la firma con el secreto de eventos y luego
   * consulta la transacción a la API de Wompi: el cuerpo del evento nunca se
   * usa como fuente del estado ni del monto. Lanza 401 si la firma no es válida
   * y 503 si hay que reintentar (Wompi reenvía el evento).
   */
  async handleEvent(event: WompiEvent, headerChecksum: string | undefined): Promise<EventOutcome> {
    if (!isValidEventSignature(event, headerChecksum, this.wompiConfig.eventsSecret)) {
      this.logger.warn('Evento de Wompi con firma inválida: descartado.');
      throw new UnauthorizedException('Firma inválida.');
    }
    const expectedEnvironment = this.wompiConfig.environment === 'sandbox' ? 'test' : 'prod';
    if (event.environment !== expectedEnvironment) {
      this.logger.warn(`Evento de Wompi del ambiente "${String(event.environment)}": descartado.`);
      return 'ignored';
    }
    const transactionId = event.data?.transaction?.id;
    if (event.event !== 'transaction.updated' || typeof transactionId !== 'string' || !transactionId) {
      return 'ignored';
    }

    let transaction: WompiTransaction | null;
    try {
      transaction = await this.wompi.getTransaction(transactionId);
    } catch (err) {
      if (err instanceof WompiUnavailableError) {
        this.logger.warn(`No se pudo consultar la transacción ${transactionId} en Wompi: ${err.message}`);
        throw new ServiceUnavailableException('No se pudo confirmar la transacción. Reintenta.');
      }
      throw err;
    }
    if (!transaction) {
      this.logger.warn(`Wompi no conoce la transacción ${transactionId} del evento: descartado.`);
      return 'ignored';
    }

    const deposit = await this.deposits.findOne({ where: { reference: transaction.reference } });
    if (!deposit) {
      this.logger.warn(`Transacción ${transaction.id} con una referencia que no es de una recarga: descartada.`);
      return 'ignored';
    }
    try {
      await this.apply(deposit, transaction);
    } catch (err) {
      if (err instanceof RetryLaterError) {
        throw new ServiceUnavailableException('No se pudo abonar la recarga todavía. Reintenta.');
      }
      throw err;
    }
    return 'processed';
  }

  /**
   * Proceso de pendientes: recargas PENDING de más de 10 minutos (el webhook no
   * llegó o el abono falló). Si Wompi no responde, se detiene hasta la próxima vuelta.
   */
  async reconcilePending(now = new Date()): Promise<{ checked: number }> {
    const stale = new Date(now.getTime() - STALE_AFTER_MS);
    const pending = await this.deposits.find({
      where: { status: 'PENDING', createdAt: LessThan(stale), lastCheckedAt: Or(IsNull(), LessThan(stale)) },
      order: { lastCheckedAt: { direction: 'ASC', nulls: 'FIRST' } },
      take: RECONCILE_BATCH,
    });

    let checked = 0;
    for (const deposit of pending) {
      await this.deposits.update(deposit.id, { lastCheckedAt: now, checkAttempts: deposit.checkAttempts + 1 });
      try {
        await this.checkWithWompi(deposit, undefined, now);
        checked++;
      } catch (err) {
        if (err instanceof WompiUnavailableError) {
          this.logger.warn(`Proceso de pendientes: Wompi no está disponible (${err.message}). Se reintenta luego.`);
          break;
        }
        if (err instanceof RetryLaterError) {
          this.logger.warn(`Proceso de pendientes: el abono de la recarga ${deposit.id} queda para la próxima vuelta.`);
          continue;
        }
        this.logger.error(`Proceso de pendientes: falló la recarga ${deposit.id}: ${(err as Error).message}`);
      }
    }
    return { checked };
  }

  /** Busca en Wompi la transacción de la recarga (por id si se conoce, si no por referencia) y la aplica. */
  private async checkWithWompi(deposit: Deposit, hintTransactionId?: string, now = new Date()): Promise<Deposit> {
    const knownId = deposit.wompiTransactionId ?? hintTransactionId;
    let transaction: WompiTransaction | null = null;
    if (knownId) {
      const found = await this.wompi.getTransaction(knownId);
      if (found && found.reference === deposit.reference) transaction = found;
    }
    if (!transaction) transaction = this.pick(await this.wompi.findByReference(deposit.reference));

    if (!transaction) {
      if (now.getTime() > deposit.expiresAt.getTime() + EXPIRE_GRACE_MS) {
        await this.transition(deposit, { status: 'EXPIRED', statusMessage: 'No se recibió ningún pago en Wompi.' });
        this.logger.log(`Recarga ${deposit.id} expirada: sin transacción en Wompi.`);
      }
      return this.reload(deposit);
    }
    return this.apply(deposit, transaction);
  }

  /** De varias transacciones con la misma referencia: la aprobada; si no, una final; si no, la pendiente. */
  private pick(transactions: WompiTransaction[]): WompiTransaction | null {
    return (
      transactions.find((t) => t.status === 'APPROVED') ??
      transactions.find((t) => t.status !== 'PENDING') ??
      transactions[0] ??
      null
    );
  }

  /**
   * Aplica a la recarga el estado de una transacción ya consultada a Wompi.
   * Idempotente: una recarga final no cambia (salvo la anulación de una ya
   * abonada, que pasa a revisión) y el abono usa una clave derivada del id de
   * la transacción, así que repetirlo nunca abona dos veces.
   */
  async apply(deposit: Deposit, transaction: WompiTransaction): Promise<Deposit> {
    if (transaction.reference !== deposit.reference) {
      throw new BadRequestException('La transacción no corresponde a esta recarga.');
    }

    if (deposit.status !== 'PENDING') {
      if (
        deposit.status === 'APPROVED' &&
        transaction.id === deposit.wompiTransactionId &&
        transaction.status === 'VOIDED'
      ) {
        const changed = await this.transition(
          deposit,
          { status: 'REVIEW', statusMessage: 'Wompi anuló una recarga ya abonada.' },
          ['APPROVED'],
        );
        if (changed) this.countPayment('voided');
        this.logger.error(`Recarga ${deposit.id}: Wompi anuló la transacción ${transaction.id} ya abonada. Revisar.`);
      }
      return this.reload(deposit);
    }
    if (deposit.wompiTransactionId && deposit.wompiTransactionId !== transaction.id) {
      this.logger.warn(
        `Recarga ${deposit.id}: llegó la transacción ${transaction.id} pero ya tiene ${deposit.wompiTransactionId}. Se ignora.`,
      );
      return deposit;
    }
    if (transaction.status === 'PENDING') return deposit;

    const details = {
      wompiTransactionId: transaction.id,
      paymentMethodType: transaction.paymentMethodType,
      statusMessage: transaction.statusMessage,
    };

    if (transaction.currency !== deposit.currency || transaction.amountInCents !== Number(deposit.amountInCents)) {
      await this.transition(deposit, {
        ...details,
        status: 'AMOUNT_MISMATCH',
        statusMessage: `Wompi reportó ${transaction.amountInCents / 100} ${transaction.currency} y la recarga es de ${Number(deposit.amount)} ${deposit.currency}.`,
      });
      this.logger.error(
        `Recarga ${deposit.id}: el monto de la transacción ${transaction.id} no coincide (${transaction.status}). No se abona.`,
      );
      return this.reload(deposit);
    }

    const finalStatus = FINAL_WOMPI_STATUSES[transaction.status];
    if (finalStatus) {
      const changed = await this.transition(deposit, { ...details, status: finalStatus });
      if (changed) this.countPayment(RESULT_BY_STATUS[finalStatus]);
      this.logger.log(`Recarga ${deposit.id}: ${finalStatus} en Wompi (${transaction.id}). No se abona.`);
      return this.reload(deposit);
    }

    // APPROVED: primero se guarda qué transacción la aprobó y después se abona.
    await this.deposits.update({ id: deposit.id, status: 'PENDING' }, details);
    const method = METHOD_LABELS[transaction.paymentMethodType ?? ''];
    const response = await this.banking.cashIn({
      accountId: deposit.accountId,
      amount: Number(deposit.amount),
      idempotencyKey: uuidV5(transaction.id, LEDGER_KEY_NAMESPACE),
      description: method ? `Recarga Wompi · ${method}` : 'Recarga Wompi',
    });

    if (response?.ok) {
      const changed = await this.transition(deposit, {
        status: 'APPROVED',
        ledgerTransactionId: response.body.id,
        creditedAt: new Date(),
      });
      if (changed) this.countPayment('approved');
      this.logger.log(`Recarga ${deposit.id} abonada (Wompi ${transaction.id}, ledger ${response.body.id}).`);
      return this.reload(deposit);
    }
    if (response && response.status >= 400 && response.status < 500 && response.status !== 401) {
      // Rechazo definitivo del ledger (p. ej. cuenta bloqueada): el pago entró a Wompi pero no se abonó.
      await this.transition(deposit, {
        status: 'REVIEW',
        statusMessage: `El ledger rechazó el abono: ${response.message || response.status}`.slice(0, 200),
      });
      this.logger.error(`Recarga ${deposit.id}: el ledger rechazó el abono (${response.status}). Revisar.`);
      return this.reload(deposit);
    }
    // Sin respuesta, 5xx o clave interna rechazada: incierto. Se reintenta con la misma clave.
    this.logger.warn(
      `Recarga ${deposit.id}: el ledger no confirmó el abono (${response ? response.status : 'sin respuesta'}).`,
    );
    throw new RetryLaterError('El ledger no confirmó el abono.');
  }

  /** Cambia el estado solo si la recarga sigue en uno de los estados esperados (evita pisar otra actualización). */
  private async transition(
    deposit: Deposit,
    changes: Partial<Deposit>,
    from: DepositStatus[] = ['PENDING'],
  ): Promise<boolean> {
    const result = await this.deposits.update({ id: deposit.id, status: In(from) }, changes);
    // true solo si ESTA llamada cambió el estado: así cada resultado se cuenta una vez aunque el webhook,
    // el cierre del widget y el proceso de pendientes coincidan.
    return (result?.affected ?? 1) > 0;
  }

  private async reload(deposit: Deposit): Promise<Deposit> {
    return (await this.deposits.findOne({ where: { id: deposit.id } })) ?? deposit;
  }

  private async owned(userId: string, id: string): Promise<Deposit> {
    const deposit = await this.deposits.findOne({ where: { id, userId } });
    if (!deposit) throw new NotFoundException('Recarga no encontrada.');
    return deposit;
  }

  /** Datos para abrir el widget de Wompi (la llave pública no es secreta). */
  private checkoutFor(deposit: Deposit) {
    const expirationTime = deposit.expiresAt.toISOString();
    const amountInCents = Number(deposit.amountInCents);
    return {
      publicKey: this.wompiConfig.publicKey,
      currency: deposit.currency,
      amountInCents,
      reference: deposit.reference,
      expirationTime,
      signature: {
        integrity: integritySignature({
          reference: deposit.reference,
          amountInCents,
          currency: deposit.currency,
          expirationTime,
          integritySecret: this.wompiConfig.integritySecret,
        }),
      },
    };
  }

  private toView(deposit: Deposit) {
    return {
      id: deposit.id,
      reference: deposit.reference,
      accountId: deposit.accountId,
      amount: Number(deposit.amount),
      currency: deposit.currency,
      status: deposit.status,
      paymentMethodType: deposit.paymentMethodType,
      statusMessage: deposit.statusMessage,
      ledgerTransactionId: deposit.ledgerTransactionId,
      expiresAt: deposit.expiresAt,
      createdAt: deposit.createdAt,
      creditedAt: deposit.creditedAt,
    };
  }

  private minAmount(): number {
    return this.amountSetting('DEPOSIT_MIN_AMOUNT', DEFAULT_MIN_AMOUNT);
  }

  private maxAmount(): number {
    return this.amountSetting('DEPOSIT_MAX_AMOUNT', DEFAULT_MAX_AMOUNT);
  }

  private amountSetting(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
