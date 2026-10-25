import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

/** Recarga nueva. El mínimo y el máximo reales los fija el servidor (DEPOSIT_MIN_AMOUNT / DEPOSIT_MAX_AMOUNT). */
export class CreateDepositDto {
  @IsUUID()
  accountId: string;

  // Pesos enteros: Wompi cobra en centavos y la recarga no admite fracciones.
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amount: number;
}

/**
 * Pide revisar la recarga en Wompi después de cerrar el widget. El id que manda
 * el navegador es solo una pista: el estado y el monto se consultan siempre a Wompi.
 */
export class SyncDepositDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,64}$/)
  transactionId?: string;
}
