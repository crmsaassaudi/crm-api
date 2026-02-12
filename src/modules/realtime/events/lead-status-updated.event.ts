export class LeadStatusUpdatedEvent {
  constructor(
    public readonly leadId: string,
    public readonly saleId: string,
    public readonly status: string,
  ) {}
}
