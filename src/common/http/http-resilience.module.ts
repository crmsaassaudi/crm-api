import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ResilienceService } from './resilience.service';
import { ResilienceHttpService } from './resilience-http.service';
import { TestHttpController } from './test-http.controller';

@Global()
@Module({
    imports: [HttpModule],
    controllers: [TestHttpController],
    providers: [ResilienceService, ResilienceHttpService],
    exports: [HttpModule, ResilienceService, ResilienceHttpService],
})
export class HttpResilienceModule { }
