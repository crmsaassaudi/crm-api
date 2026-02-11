import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ResilienceService } from './resilience.service';

@Injectable()
export class AxiosResilienceSetup implements OnModuleInit {
    constructor(
        private readonly httpService: HttpService,
        private readonly resilienceService: ResilienceService,
    ) { }

    onModuleInit() {
        this.httpService.axiosRef.interceptors.response.use(
            (response) => response,
            async (error) => {
                // This is tricky with Cockatiel because it expects to wrap the execution function, 
                // not just intercept the error. Axios interceptors are good for retrying directly 
                // using a specific library like 'axios-retry'.
                // To use Cockatiel effectively, we should WRAP the call, not intercept it inside.

                // HOWEVER, to satisfy the requirement "AxiosInterceptor", we can try to retry here.
                // But cleaner way: create a WrappedHttpService.
                return Promise.reject(error);
            },
        );
    }
}
// Note: We will use a Wrapper Service instead as it's cleaner with Cockatiel.
