import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ResilienceService } from './resilience.service';

@Injectable()
export class AxiosResilienceSetup implements OnModuleInit {
  constructor(
    private readonly httpService: HttpService,
    private readonly resilienceService: ResilienceService,
  ) {}

  onModuleInit() {
    this.httpService.axiosRef.interceptors.response.use(
      (response) => response,
      async (error) => {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
  }
}
