import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { IsNull, Not, Repository } from 'typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { Deposit } from './entities/deposit.entity';

/** Endpoints entre servicios (red interna, x-internal-key). El gateway responde 404 a /internal desde afuera. */
@Controller('internal/deposits')
@UseGuards(InternalKeyGuard)
export class InternalDepositsController {
  constructor(@InjectRepository(Deposit) private readonly deposits: Repository<Deposit>) {}

  /**
   * Lo que impediría cancelar la cuenta del cliente (solo account-service):
   * recargas que todavía pueden abonarse (PENDING con pago iniciado o sin vencer)
   * y recargas en revisión (Wompi cobró pero algo quedó por resolver a mano).
   */
  @Get('users/:idUser/resumen-cierre')
  async resumenCierre(@Param('idUser', ParseUUIDPipe) idUser: string, @Req() request: Request) {
    if ((request as any).internalCaller !== 'account') {
      throw new ForbiddenException('Solo account-service puede pedir este resumen.');
    }
    const [conPago, sinVencer, enRevision] = await Promise.all([
      // Ya hay una transacción en Wompi: el abono puede llegar en cualquier momento.
      this.deposits.count({ where: { userId: idUser, status: 'PENDING', wompiTransactionId: Not(IsNull()) } }),
      // Sin transacción conocida, pero aún puede aparecer un pago: el widget sigue
      // abierto o Wompi no ha avisado. Mismo margen que el proceso de pendientes
      // (1 h después del vencimiento) antes de darla por expirada.
      this.deposits
        .createQueryBuilder('d')
        .where('d.user_id = :idUser', { idUser })
        .andWhere("d.status = 'PENDING'")
        .andWhere('d.wompi_transaction_id IS NULL')
        .andWhere("d.expires_at > now() - interval '1 hour'")
        .getCount(),
      this.deposits.count({ where: { userId: idUser, status: 'REVIEW' } }),
    ]);
    const recargasPendientes = conPago + sinVencer;
    return { recargasPendientes, recargasEnRevision: enRevision, sinPendientes: recargasPendientes + enRevision === 0 };
  }
}
