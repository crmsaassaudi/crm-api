import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

@Global()
@Module({
    imports: [
        BullModule.forRootAsync({
            useFactory: (configService: ConfigService) => ({
                connection: {
                    host: configService.get('queue.host'),
                    port: configService.get('queue.port'),
                    password: configService.get('queue.password'),
                    db: configService.get('queue.db'),
                },
            }),
            inject: [ConfigService],
        }),
    ],
    exports: [BullModule],
})
export class QueueModule { }
