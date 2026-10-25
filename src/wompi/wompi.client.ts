import { Inject, Injectable, Logger } from '@nestjs/common';
import { WompiConfig } from './wompi.config';

export const WOMPI_CONFIG = Symbol('WOMPI_CONFIG');

// Wompi responde en milisegundos; si tarda más, se deja para el proceso de pendientes.
const WOMPI_TIMEOUT_MS = 5_000;

export type WompiStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';

/** Lo que BankLite usa de una transacción de Wompi. */
export interface WompiTransaction {
  id: string;
  reference: string;
  amountInCents: number;
  currency: string;
  status: WompiStatus;
  statusMessage: string | null;
  paymentMethodType: string | null;
}

/** Wompi no respondió, respondió 5xx o con un cuerpo que no se entiende: se reintenta después. */
export class WompiUnavailableError extends Error {}

const STATUSES = new Set<WompiStatus>(['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR']);

/**
 * Consultas a la API de Wompi con la llave privada (solo desde el servidor).
 * Tiempo máximo corto y sin reintentos: si Wompi no responde, la recarga sigue
 * pendiente y el proceso de pendientes la vuelve a consultar más tarde.
 */
@Injectable()
export class WompiClient {
  private readonly logger = new Logger(WompiClient.name);

  constructor(@Inject(WOMPI_CONFIG) private readonly config: WompiConfig) {}

  /** La transacción por su id, o null si Wompi no la conoce. */
  async getTransaction(id: string): Promise<WompiTransaction | null> {
    const body = await this.get(`/transactions/${encodeURIComponent(id)}`);
    if (body === null) return null;
    return this.parse(body?.data);
  }

  /** Las transacciones que Wompi tiene con esta referencia (normalmente una o ninguna). */
  async findByReference(reference: string): Promise<WompiTransaction[]> {
    const body = await this.get(`/transactions?reference=${encodeURIComponent(reference)}`);
    if (body === null) return [];
    if (!Array.isArray(body?.data)) throw new WompiUnavailableError('Respuesta de Wompi sin lista de transacciones.');
    return body.data.map((item: unknown) => this.parse(item));
  }

  private async get(path: string): Promise<any | null> {
    let response: Response;
    try {
      response = await fetch(`${this.config.apiUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.config.privateKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(WOMPI_TIMEOUT_MS),
      });
    } catch {
      throw new WompiUnavailableError('Wompi no respondió (red o tiempo agotado).');
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      // 401/403 es un problema de llaves: se registra el estado, nunca la llave.
      this.logger.warn(`Wompi respondió ${response.status} a la consulta de transacciones.`);
      throw new WompiUnavailableError(`Wompi respondió ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new WompiUnavailableError('Wompi respondió con un cuerpo que no es JSON.');
    }
  }

  private parse(raw: any): WompiTransaction {
    const amountInCents = Number(raw?.amount_in_cents);
    if (
      typeof raw?.id !== 'string' ||
      typeof raw?.reference !== 'string' ||
      !Number.isSafeInteger(amountInCents) ||
      typeof raw?.currency !== 'string' ||
      !STATUSES.has(raw?.status)
    ) {
      throw new WompiUnavailableError('Transacción de Wompi con un formato inesperado.');
    }
    return {
      id: raw.id,
      reference: raw.reference,
      amountInCents,
      currency: raw.currency,
      status: raw.status,
      statusMessage: typeof raw.status_message === 'string' ? raw.status_message.slice(0, 200) : null,
      paymentMethodType: typeof raw.payment_method_type === 'string' ? raw.payment_method_type.slice(0, 30) : null,
    };
  }
}
