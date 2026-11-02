import { Deposit } from './deposits/entities/deposit.entity';

/**
 * Todas las tablas de deposit_db. La usan TypeORM al arrancar y
 * scripts/verificar-esquema.js (CI), que comprueba que database/schema.sql y
 * database/backup.sql crean exactamente estas tablas.
 */
export const ENTITIES = [Deposit];
