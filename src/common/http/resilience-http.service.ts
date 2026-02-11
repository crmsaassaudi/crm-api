import { Injectable, ServiceUnavailableException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ResilienceService } from './resilience.service';
import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { ResilienceOptions, ResilienceServiceType } from './resilience.definitions';
import { IntegrationLogService } from './integration-log.service';
import { ClsService } from 'nestjs-cls';

export interface ResilienceConfig {
    resilience?: Partial<ResilienceOptions> & { service: ResilienceServiceType };
}

@Injectable()
export class ResilienceHttpService {
    private readonly logger = new Logger(ResilienceHttpService.name);

    constructor(
        private readonly httpService: HttpService,
        private readonly resilienceService: ResilienceService,
        private readonly integrationLogService: IntegrationLogService,
        private readonly cls: ClsService,
    ) { }

    // Execute request with resilience and logging

    private async execute<T>(fn: () => Promise<AxiosResponse<T>>, context: { url: string, method: string }, config?: ResilienceConfig): Promise<AxiosResponse<T>> {
        const serviceName = config?.resilience?.service || 'none';
        const start = Date.now();
        // Reset retry count for this request scope
        this.cls.set('resilienceRetries', 0);

        const policy = this.resilienceService.getPolicy(serviceName, config?.resilience);

        try {
            const response = await policy.execute(fn);

            const durationMs = Date.now() - start;
            this.integrationLogService.logRequest({
                service: serviceName,
                url: context.url,
                method: context.method,
                status: response.status,
                success: true,
                retries: this.cls.get('resilienceRetries') || 0,
                breakerOpen: false, // Todo: Get actual state if possible
                durationMs,
                correlationId: this.cls.getId(),
            });

            return response;
        } catch (error) {
            const durationMs = Date.now() - start;
            this.logger.error(`Request to ${serviceName} failed: ${error.message}`, error.stack);

            this.integrationLogService.logRequest({
                service: serviceName,
                url: context.url,
                method: context.method,
                status: error.response?.status || 500,
                success: false,
                retries: this.cls.get('resilienceRetries') || 0,
                breakerOpen: error.message?.includes('CircuitBreaker Open'), // Rough check
                durationMs,
                correlationId: this.cls.getId(),
            });

            throw new ServiceUnavailableException({
                service: serviceName,
                message: `External service '${serviceName}' is unavailable.`,
                cause: error.message,
            });
        }
    }

    async request<T>(config: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.request<T>(config)), { url: config.url || '', method: config.method || 'GET' }, resilienceConfig);
    }

    async get<T>(url: string, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.get<T>(url, config)), { url, method: 'GET' }, resilienceConfig);
    }

    async post<T>(url: string, data?: any, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.post<T>(url, data, config)), { url, method: 'POST' }, resilienceConfig);
    }

    async put<T>(url: string, data?: any, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.put<T>(url, data, config)), { url, method: 'PUT' }, resilienceConfig);
    }

    async patch<T>(url: string, data?: any, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.patch<T>(url, data, config)), { url, method: 'PATCH' }, resilienceConfig);
    }

    async delete<T>(url: string, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.delete<T>(url, config)), { url, method: 'DELETE' }, resilienceConfig);
    }
}
