import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { ResilienceService } from './resilience.service';

@Injectable()
export class HttpResilienceInterceptor implements NestInterceptor {
    constructor(private readonly resilienceService: ResilienceService) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        // We assume this interceptor is applied to HttpService calls or controllers delegating to it.
        // However, typical AxiosInterceptor logic is better handled by wrapping HttpService or using Axios interceptors directly.
        // For simplicity in NestJS HttpModule, we can wrap the execution.
        // BUT: NestInterceptor wraps the *Controller* execution passed to it.

        // To wrap outgoing HTTP calls, it's better to create a custom HttpService wrapper or use an APP_INTERCEPTOR if the calls are Observable based.
        // Here, we'll assume this interceptor wraps a method that returns a Promise/Observable and we want to retry that WHOLE method.

        // Actually, task requirement 7.2 says "AxiosInterceptor". 
        // NestJS HttpService uses axios. We can register an axios interceptor onModuleInit.
        // Or we provide a wrapper interceptor for NestJS handlers.

        // Let's implement this as a global interceptor that wraps the execution flow using cockatiel.

        return from(
            this.resilienceService.policy.execute(() => next.handle().toPromise()),
        );
    }
}
