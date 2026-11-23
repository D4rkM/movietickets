import { Global, Module } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import { BusinessMetrics, METER_PROVIDER } from "./business-metrics";

/**
 * Business metrics provider. Global so any module can inject BusinessMetrics;
 * feature modules that emit metrics also import it explicitly, so test modules
 * built from a subset of modules (without AppModule) still resolve it.
 *
 * METER_PROVIDER is resolved when Nest instantiates the provider — after
 * `instrumentation.ts` registered the SDK's global MeterProvider — and tests
 * override it with an in-memory one.
 */
@Global()
@Module({
  providers: [{ provide: METER_PROVIDER, useFactory: () => metrics.getMeterProvider() }, BusinessMetrics],
  exports: [BusinessMetrics],
})
export class TelemetryModule {}
