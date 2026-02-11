import { BaseEvent } from './base.event';

export class TestEvent extends BaseEvent {
    constructor(
        public readonly message: string,
        dispatcherId?: string,
    ) {
        super(dispatcherId);
    }
}
