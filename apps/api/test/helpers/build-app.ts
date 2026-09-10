import { TestingModule } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";

export async function buildFastifyApp(moduleRef: TestingModule): Promise<NestFastifyApplication> {
  return moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
}
