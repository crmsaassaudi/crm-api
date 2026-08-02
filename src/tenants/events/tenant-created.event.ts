export class TenantCreatedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly companyName: string,
    public readonly adminEmail: string,
    public readonly ownerId?: string,
    public readonly onboardingGoal?: string,
    /** Headcount bracket from onboarding; shapes the seeded org tree. */
    public readonly teamSize?: string,
  ) {}
}
