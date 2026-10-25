import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * PENDING: creada, esperando el pago en Wompi (o el abono, si el ledger no respondió).
 * APPROVED: Wompi la aprobó y el ledger ya abonó el saldo.
 * DECLINED / VOIDED / ERROR: estado final de Wompi; no se abona nada.
 * EXPIRED: pasaron 24 h sin ninguna transacción en Wompi.
 * AMOUNT_MISMATCH: la transacción de Wompi no coincide con la recarga (monto o moneda); no se abona.
 * REVIEW: requiere revisión manual (p. ej. Wompi anuló una recarga ya abonada o el ledger rechazó el abono).
 */
export type DepositStatus =
  'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR' | 'EXPIRED' | 'AMOUNT_MISMATCH' | 'REVIEW';

@Entity('deposits')
@Index(['status', 'createdAt'])
export class Deposit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Referencia que se le pasa a Wompi (única por recarga).
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  reference: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  // Monto en pesos, fijado por el servidor al crear la recarga.
  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ name: 'amount_in_cents', type: 'bigint' })
  amountInCents: string;

  @Column({ type: 'varchar', length: 3, default: 'COP' })
  currency: string;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status: DepositStatus;

  // Hasta cuándo se puede pagar en el widget (también va en la firma de integridad).
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  // Transacción de Wompi que decidió la recarga. Una transacción solo sirve para una recarga.
  @Index({ unique: true, where: 'wompi_transaction_id IS NOT NULL' })
  @Column({ name: 'wompi_transaction_id', type: 'varchar', length: 64, nullable: true })
  wompiTransactionId: string | null;

  @Column({ name: 'payment_method_type', type: 'varchar', length: 30, nullable: true })
  paymentMethodType: string | null;

  @Column({ name: 'status_message', type: 'varchar', length: 200, nullable: true })
  statusMessage: string | null;

  @Column({ name: 'ledger_transaction_id', type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  @Column({ name: 'credited_at', type: 'timestamptz', nullable: true })
  creditedAt: Date | null;

  // Proceso de pendientes: cuándo se consultó Wompi por última vez y cuántas veces.
  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt: Date | null;

  @Column({ name: 'check_attempts', type: 'int', default: 0 })
  checkAttempts: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
