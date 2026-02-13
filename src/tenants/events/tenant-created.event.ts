export class TenantCreatedEvent {
    constructor(
        public readonly tenantId: string,
        public readonly companyName: string,
        public readonly adminEmail: string,
    ) { }
}
