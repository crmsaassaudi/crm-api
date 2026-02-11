import { Controller, Get, Query } from '@nestjs/common';
import { ResilienceHttpService } from './resilience-http.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Test')
@Controller('test-http')
export class TestHttpController {
    constructor(private readonly httpService: ResilienceHttpService) { }

    @Get('fail')
    async fail(@Query('url') url: string = 'http://httpstat.us/500') {
        // Uses 'generic' policy from registry: retries=2
        return this.httpService.get(url, undefined, { resilience: { service: 'generic' } });
    }

    @Get('facebook')
    async facebook() {
        // Uses 'facebook' policy: retries=5, timeout=5000
        // Fixed URL to prevent SSRF
        const url = 'http://httpstat.us/500';
        return this.httpService.get(url, undefined, { resilience: { service: 'facebook' } });
    }
    @Get('none')
    async none(@Query('url') url: string = 'http://httpstat.us/500') {
        // Uses 'none' policy: No retries, no circuit breaker
        return this.httpService.get(url, undefined, { resilience: { service: 'none' } });
    }

    @Get('default')
    async default(@Query('url') url: string = 'http://httpstat.us/500') {
        // Should use 'none' policy by default
        return this.httpService.get(url);
    }
}
