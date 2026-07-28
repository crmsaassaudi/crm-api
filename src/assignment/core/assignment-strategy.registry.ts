import { ConflictException, Injectable } from '@nestjs/common';
import { AssignmentStrategy } from '../domain/assignment.types';
export interface AssignmentStrategyPlugin {
  name: AssignmentStrategy;
  reservationMode: 'first-eligible' | 'least-load' | 'capacity-load';
  rotateCandidates: boolean;
  enforceCapacity: boolean;
  loadOrdered: boolean;
}

@Injectable()
export class AssignmentStrategyRegistry {
  private readonly plugins = new Map<
    AssignmentStrategy,
    AssignmentStrategyPlugin
  >();

  constructor() {
    this.register({
      name: 'round-robin',
      reservationMode: 'first-eligible',
      rotateCandidates: true,
      enforceCapacity: true,
      loadOrdered: false,
    });
    this.register({
      name: 'least-busy',
      reservationMode: 'least-load',
      rotateCandidates: false,
      enforceCapacity: false,
      loadOrdered: true,
    });
    this.register({
      name: 'capacity-based',
      reservationMode: 'capacity-load',
      rotateCandidates: false,
      enforceCapacity: true,
      loadOrdered: true,
    });
  }

  register(plugin: AssignmentStrategyPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new ConflictException(
        `Assignment strategy "${plugin.name}" is already registered`,
      );
    }
    this.plugins.set(plugin.name, Object.freeze({ ...plugin }));
  }

  get(name: AssignmentStrategy): AssignmentStrategyPlugin | null {
    return this.plugins.get(name) ?? null;
  }

  list(): readonly AssignmentStrategyPlugin[] {
    return Object.freeze([...this.plugins.values()]);
  }
}
