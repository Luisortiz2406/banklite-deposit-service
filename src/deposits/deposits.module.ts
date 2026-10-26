import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { InternalDepositsController } from './internal-deposits.controller';
import { WOMPI_CONFIG, WompiClient } from '../wompi/wompi.client';
import { readWompiConfig } from '../wompi/wompi.config';
import { BankingClientService } from './banking-client.service';
import { DepositsController, WompiEventsController } from './deposits.controller';
import { DepositsService } from './deposits.service';
import { Deposit } from './entities/deposit.entity';
import { PendingDepositsJob } from './pending-deposits.job';

const WOMPI_KEYS = [
  'WOMPI_ENV',
  'WOMPI_PUBLIC_KEY',
  'WOMPI_PRIVATE_KEY',
  'WOMPI_INTEGRITY_SECRET',
  'WOMPI_EVENTS_SECRET',
];

@Module({
  imports: [ConfigModule, JwtModule.register({}), TypeOrmModule.forFeature([Deposit])],
  controllers: [DepositsController, WompiEventsController, InternalDepositsController],
  providers: [
    {
      provide: WOMPI_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readWompiConfig(Object.fromEntries(WOMPI_KEYS.map((key) => [key, config.get<string>(key)]))),
    },
    WompiClient,
    BankingClientService,
    DepositsService,
    PendingDepositsJob,
    JwtAuthGuard,
    InternalKeyGuard,
  ],
})
export class DepositsModule {}
