import { WebSocketGateway } from '@nestjs/websockets';
import { BaseGateway } from './base.gateway';

const allowedOrigins =
  process.env.FRONTEND_DOMAIN?.split(',') ||
  (process.env.NODE_ENV === 'development' ? ['*'] : []);

@WebSocketGateway({
  namespace: '/sales',
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
})
export class SalesGateway extends BaseGateway {}
