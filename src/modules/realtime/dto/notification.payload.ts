export class NotificationPayload {
    constructor(
        public type: string,
        public message: string,
        public leadId: string,
        public timestamp: number = Date.now(),
    ) { }
}
