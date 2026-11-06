import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv(); // fail fast on bad config
  const app = await NestFactory.create(AppModule, { rawBody: true }); // raw body is needed to verify webhook signatures
  app.use(helmet());
  app.enableVersioning({ type: VersioningType.URI });
  app.enableCors({ origin: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',') : false });
  if (env.NODE_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('SALA API').setVersion('0.1').addBearerAuth().build());
    SwaggerModule.setup('docs', app, doc);
  }
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
}
bootstrap();
