import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { SalesGateway } from './gateways/sales.gateway';
import { LeadNotificationListener } from './listeners/lead-notification.listener';

@Module({
    imports: [
        JwtModule,
        ConfigModule,
    ],
    providers: [SalesGateway, LeadNotificationListener],
    exports: [SalesGateway],
})
export class SocketModule { }
