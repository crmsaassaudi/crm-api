import { Module } from '@nestjs/common';
import { ActivityLogListener } from './listeners/activity-log.listener';

import { TestEventController } from './test-event.controller';

@Module({
    controllers: [TestEventController],
    providers: [ActivityLogListener],
})
export class ActivityLogModule { }
