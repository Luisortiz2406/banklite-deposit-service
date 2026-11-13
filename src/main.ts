import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { MetricsService } from './metrics/metrics.service';

// Tope del cuerpo de las peticiones: los eventos de Wompi pesan unos pocos KB.
const BODY_LIMIT = '64kb';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // Cuenta y mide cada petición (las métricas se publican en el puerto METRICS_PORT, solo red privada).
  app.use(app.get(MetricsService).middleware());
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Sin CORS: el navegador solo habla con el api-gateway, que es quien decide los orígenes.
  const port = process.env.PORT ?? 3014;
  await app.listen(port);
  new Logger('Bootstrap').log(`Deposit Service escuchando en http://localhost:${port}`);
}

bootstrap();
