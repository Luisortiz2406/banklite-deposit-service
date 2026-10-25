import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { WompiEvent } from '../wompi/wompi.signatures';
import { DepositsService } from './deposits.service';
import { CreateDepositDto, SyncDepositDto } from './dto/deposit.dto';

/** Recargas del cliente (JWT). */
@Controller('deposits')
@UseGuards(JwtAuthGuard)
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  /** Mínimo, máximo y ambiente de Wompi (para el formulario). */
  @Get('config')
  config() {
    return this.deposits.getConfig();
  }

  @Get()
  list(@Req() request: Request) {
    return this.deposits.list(this.userId(request));
  }

  /** Crea la recarga PENDING y devuelve los datos firmados para abrir el widget de Wompi. */
  @Post()
  create(@Body() dto: CreateDepositDto, @Req() request: Request) {
    return this.deposits.create(this.userId(request), (request as any).accessToken, dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.deposits.get(this.userId(request), id);
  }

  /** Al cerrar el widget: consulta el estado en Wompi sin esperar el webhook. */
  @Post(':id/sync')
  @HttpCode(200)
  sync(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SyncDepositDto, @Req() request: Request) {
    return this.deposits.sync(this.userId(request), id, dto.transactionId);
  }

  private userId(request: Request): string {
    return (request as any).user.idUser;
  }
}

/**
 * Webhook de eventos de Wompi (ruta pública a través del gateway, sin JWT). La
 * autenticidad la da la firma del evento (secreto de eventos). El cuerpo nunca
 * se registra en los logs.
 */
@Controller('deposits/wompi')
export class WompiEventsController {
  constructor(private readonly deposits: DepositsService) {}

  @Post('events')
  @HttpCode(200)
  async events(@Body() event: WompiEvent, @Headers('x-event-checksum') checksum: string | undefined) {
    const outcome = await this.deposits.handleEvent(event ?? {}, checksum);
    return { received: true, outcome };
  }
}
