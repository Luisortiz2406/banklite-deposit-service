import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, HTTP_TIMEOUTS, requestService, ServiceResponse } from '../common/http/internal-http';

export interface OwnedAccount {
  id: string;
  accountNumber: string;
  currency: string;
  status: string;
}

export interface LedgerTransactionRef {
  id: string;
}

/**
 * Llamadas a otros servicios de BankLite: la cuenta del cliente en
 * account-service (con el token del propio cliente, así account-service valida
 * que sea suya) y el abono en ledger-service (con la INTERNAL_API_KEY propia de
 * deposit-service). Errores: regla común de common/http/internal-http.ts.
 */
@Injectable()
export class BankingClientService {
  constructor(private readonly config: ConfigService) {}

  /** La cuenta, solo si es del cliente del token (403 y 404 se responden igual). */
  async getOwnedAccount(accountId: string, accessToken: string): Promise<OwnedAccount> {
    const noAccess = () => new ForbiddenException('No tienes acceso a esta cuenta.');
    return callService<OwnedAccount>(
      `${this.url('ACCOUNT_SERVICE_URL', 'http://localhost:3002')}/accounts/${encodeURIComponent(accountId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      {
        service: 'Account Service',
        internal: false,
        unavailable: 'No se pudo validar la cuenta. Inténtalo de nuevo.',
        on: { 403: noAccess, 404: noAccess },
      },
    );
  }

  /**
   * Abono de la recarga en el ledger (contra la cuenta Compensación Wompi). No
   * lanza excepciones: devuelve la respuesta (o null si no hubo) para que quien
   * llama distinga un rechazo definitivo (4xx) de una falla incierta.
   */
  async cashIn(params: {
    accountId: string;
    amount: number;
    idempotencyKey: string;
    description: string;
  }): Promise<ServiceResponse<LedgerTransactionRef> | null> {
    return requestService<LedgerTransactionRef>(
      `${this.url('LEDGER_SERVICE_URL', 'http://localhost:3006')}/ledger/internal/cash-ins`,
      {
        method: 'POST',
        headers: this.internalHeaders(),
        body: JSON.stringify(params),
        timeoutMs: HTTP_TIMEOUTS.slow,
      },
    );
  }

  private url(key: string, fallback: string) {
    return this.config.get<string>(key, fallback).replace(/\/+$/, '');
  }

  private internalHeaders() {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Deposit Service.');
    return { 'Content-Type': 'application/json', 'x-internal-key': key };
  }
}
