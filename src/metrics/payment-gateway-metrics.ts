import { Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from './metrics.service';

/**
 * Resultados de un pago de la pasarela: lista CERRADA (ningún nombre de proveedor).
 *   - approved: la pasarela aprobó el pago y el ledger abonó la recarga.
 *   - declined: la pasarela rechazó el pago.
 *   - voided: la pasarela anuló el pago (también si anuló uno que ya estaba abonado).
 *   - error: la pasarela reportó un error en el pago.
 */
export const PAYMENT_RESULTS = ['approved', 'declined', 'voided', 'error'] as const;
export type PaymentResult = (typeof PAYMENT_RESULTS)[number];

/**
 * payment_gateway_payments_total{result}: pagos de recargas por resultado. La única etiqueta es `result`
 * y solo toma los valores de la lista cerrada: nunca una referencia, un id de recarga o de transacción,
 * un monto, un correo, datos de tarjeta, el medio de pago ni el nombre del proveedor.
 *
 * CONTAR NUNCA ROMPE UN PAGO NI UN WEBHOOK: ni el constructor ni record() lanzan jamás; si prom-client
 * falla se deja un aviso en el log y el flujo del pago sigue como si nada.
 */
@Injectable()
export class PaymentGatewayMetrics {
  private readonly logger = new Logger('PaymentGatewayMetrics');
  private payments: Counter<'result'> | null = null;

  constructor(metrics: MetricsService) {
    try {
      const counter = new Counter({
        name: 'payment_gateway_payments_total',
        help: 'Pagos de recargas por resultado: approved, declined, voided o error.',
        labelNames: ['result'],
        registers: [metrics.registry],
      });
      // Todas las series existen desde el arranque (en 0): así increase() y rate() ven el primer evento.
      for (const result of PAYMENT_RESULTS) counter.inc({ result }, 0);
      this.payments = counter;
    } catch (error) {
      this.logger.warn(`No se pudo crear payment_gateway_payments_total: ${(error as Error).message}`);
    }
  }

  /** Suma 1 al resultado; si prom-client falla, solo avisa en el log (nunca lanza). */
  record(result: PaymentResult) {
    try {
      this.payments?.inc({ result });
    } catch (error) {
      this.logger.warn(`No se pudo contar el pago (${result}): ${(error as Error).message}`);
    }
  }
}
