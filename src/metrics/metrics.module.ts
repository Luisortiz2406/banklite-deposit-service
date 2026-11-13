import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { PaymentGatewayMetrics } from './payment-gateway-metrics';

@Module({
  providers: [MetricsService, PaymentGatewayMetrics],
  exports: [MetricsService, PaymentGatewayMetrics],
})
export class MetricsModule {}
