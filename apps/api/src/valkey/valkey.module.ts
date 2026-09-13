import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

export const VALKEY = Symbol("VALKEY");

@Global()
@Module({
  providers: [
    {
      provide: VALKEY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const connectionString = config.getOrThrow<string>("VALKEY_URL");
        const client = new Redis(connectionString, { lazyConnect: true });
        return Object.assign(client, { onModuleDestroy: () => client.quit() });
      },
    },
  ],
  exports: [VALKEY],
})
export class ValkeyModule {}
