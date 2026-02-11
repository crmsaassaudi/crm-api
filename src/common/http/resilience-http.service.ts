import { Injectable, ServiceUnavailableException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ResilienceService } from './resilience.service';
import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { ResilienceOptions, ResilienceServiceType } from './resilience.definitions';

export interface ResilienceConfig {
    resilience?: Partial<ResilienceOptions> & { service: ResilienceServiceType };
}

@Injectable()
export class ResilienceHttpService {
    private readonly logger = new Logger(ResilienceHttpService.name);

    constructor(
        private readonly httpService: HttpService,
        private readonly resilienceService: ResilienceService,
    ) { }

    private async execute<T>(fn: () => Promise<AxiosResponse<T>>, config?: ResilienceConfig): Promise<AxiosResponse<T>> {
        const serviceName = config?.resilience?.service || 'none';
        // Only pass valid ResilienceOptions to getPolicy
        const policy = this.resilienceService.getPolicy(serviceName, config?.resilience);

        try {
            return await policy.execute(fn);
        } catch (error) {
            this.logger.error(`Request to ${serviceName} failed: ${error.message}`, error.stack);
            throw new ServiceUnavailableException({
                service: serviceName,
                message: `External service '${serviceName}' is unavailable.`,
                cause: error.message,
            });
        }
    }

    async request<T>(config: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.request<T>(config)), resilienceConfig);
    }

    async get<T>(url: string, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.get<T>(url, config)), resilienceConfig);
    }

    async post<T>(url: string, data?: any, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.post<T>(url, data, config)), resilienceConfig);
    }

    async put<T>(url: string, data?: any, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.put<T>(url, data, config)), resilienceConfig);
    }

    async patch<T>(url: string, data?: any, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.patch<T>(url, data, config)), resilienceConfig);
    }

    async delete<T>(url: string, config?: AxiosRequestConfig, resilienceConfig?: ResilienceConfig): Promise<AxiosResponse<T>> {
        return this.execute(() => firstValueFrom(this.httpService.delete<T>(url, config)), resilienceConfig);
    }
}
