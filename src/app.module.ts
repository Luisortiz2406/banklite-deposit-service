import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from './config/env.validation';
import { DepositsModule } from './deposits/deposits.module';
import { ENTITIES } from './entities';
import { HealthController } from './health.controller';
import { readWompiConfig } from './wompi/wompi.config';
import { MetricsModule } from './metrics/metrics.module';

const validateCommon = validateEnv(
  [
    { key: 'JWT_SECRET', type: 'secret' },
    { key: 'INTERNAL_API_KEY', type: 'secret' },
    { key: 'DATABASE_URL', type: 'url' },
    // Quién puede pedir el resumen para cancelar la cuenta: "account:<clave>".
    { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys', optional: true },
  ],
  ['JWT_SECRET', 'INTERNAL_API_KEY'],
);

@Module({
  imports: [
    MetricsModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      // Secretos comunes y llaves de Wompi: el servicio no arranca si algo falta o
      // si hay llaves de producción con WOMPI_ENV=sandbox.
      validate: (config) => {
        const validated = validateCommon(config);
        readWompiConfig(validated);
        return validated;
      },
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: ENTITIES,
        synchronize: true,
        logging: false,
      }),
    }),
    DepositsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
