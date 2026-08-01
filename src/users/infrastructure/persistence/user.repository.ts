import { DeepPartial } from '../../../utils/types/deep-partial.type';
import { NullableType } from '../../../utils/types/nullable.type';
import { IPaginationOptions } from '../../../utils/types/pagination-options';
import { User } from '../../domain/user';
import { FilterUserDto, SortUserDto } from '../../dto/query-user.dto';
import { PaginationResponseDto } from '../../../utils/dto/pagination-response.dto';

export abstract class UserRepository {
  abstract create(
    data: Omit<User, 'id' | 'createdAt' | 'deletedAt' | 'updatedAt'>,
    session?: any,
  ): Promise<User>;

  abstract findManyWithPagination({
    filterOptions,
    sortOptions,
    paginationOptions,
  }: {
    filterOptions?: FilterUserDto | null;
    sortOptions?: SortUserDto[] | null;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<User>>;

  abstract findById(id: User['id']): Promise<NullableType<User>>;
  abstract findByIds(ids: User['id'][]): Promise<User[]>;
  /** Find by IDs without tenant scoping — use when resolving cross-tenant references (e.g. agent names in history) */
  abstract findByIdsGlobal(ids: User['id'][]): Promise<User[]>;
  abstract findManyByTenant(tenantId: string): Promise<User[]>;

  /**
   * Member count per org unit for one tenant, keyed by org-unit id.
   * Units with no members are absent from the map rather than zero.
   */
  abstract countByOrgUnit(tenantId: string): Promise<Record<string, number>>;
  abstract findByEmail(email: User['email']): Promise<NullableType<User>>;
  abstract findByKeycloakIdAndProvider({
    keycloakId,
    provider,
  }: {
    keycloakId: User['keycloakId'];
    provider: User['provider'];
  }): Promise<NullableType<User>>;

  abstract findIncompleteOnboardingBefore(
    cutoffDate: Date,
    limit?: number,
  ): Promise<User[]>;

  /** Throws NotFoundException when the id is outside the caller's scope. */
  abstract update(id: User['id'], payload: DeepPartial<User>): Promise<User>;

  /** `update()` without the refusal — for idempotent sweeps only. */
  abstract updateIfExists(
    id: User['id'],
    payload: DeepPartial<User>,
  ): Promise<User | null>;

  abstract upsertWithTenants(
    keycloakId: string,
    email: string,
    userData: Partial<User>,
    newTenants: {
      tenantId: string;
      roles: string[];
      roleIds?: string[];
      joinedAt: Date;
    }[],
    session?: any,
  ): Promise<User>;

  abstract removeTenantMembership(
    userId: string,
    tenantId: string,
  ): Promise<User>;

  /** Throws NotFoundException when the id is outside the caller's scope. */
  abstract remove(id: User['id']): Promise<void>;

  /** `remove()` without the refusal — returns whether anything matched. */
  abstract removeIfExists(id: User['id']): Promise<boolean>;
}
