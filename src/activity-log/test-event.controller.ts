import { Controller, Post, Body } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TestEvent } from '../common/events/test.event';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Test')
@Controller('test-events')
export class TestEventController {
    constructor(private readonly eventEmitter: EventEmitter2) { }

    @Post()
    triggerEvent(@Body('message') message: string) {
        const event = new TestEvent(message, 'test-user-id');
        this.eventEmitter.emit('test.event', event);
        return { success: true, message: 'Event triggered' };
    }
}
