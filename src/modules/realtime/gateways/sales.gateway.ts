import { WebSocketGateway } from '@nestjs/websockets';
import { BaseGateway } from './base.gateway';

@WebSocketGateway({
    namespace: '/sales',
    cors: {
        origin: '*', // Adjust this for production
    },
})
export class SalesGateway extends BaseGateway { }
