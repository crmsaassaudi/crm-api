export class LeadCreatedEvent {
  constructor(
    public readonly leadId: string,
    public readonly saleId: string,
    public readonly name: string,
  ) {}
}
