export abstract class BaseEvent {
  public readonly occurredOn: Date;
  public readonly dispatcherId?: string;

  constructor(dispatcherId?: string) {
    this.occurredOn = new Date();
    this.dispatcherId = dispatcherId;
  }
}
