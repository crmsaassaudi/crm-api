import { Injectable, ConflictException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls'; // Import ClsService
import { NullableType } from '../../../../../utils/types/nullable.type';
import { FilterUserDto, SortUserDto } from '../../../../dto/query-user.dto';
import { User } from '../../../../domain/user';
import { UserRepository } from '../../user.repository';
import { UserSchemaClass, UserSchemaDocument } from '../entities/user.schema';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { UserMapper } from '../mappers/user.mapper';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';

@Injectable()
export class UsersDocumentRepository
  extends BaseDocumentRepository<UserSchemaDocument, User>
  implements UserRepository {
  constructor(
    @InjectModel(UserSchemaClass.name)
    userModel: Model<UserSchemaDocument>,
    cls: ClsService, // Inject ClsService
  ) {
    super(userModel, cls);
  }

  protected mapToDomain(doc: UserSchemaClass): User {
    return UserMapper.toDomain(doc);
  }

  protected toPersistence(domain: User): UserSchemaClass {
    return UserMapper.toPersistence(domain);
  }

  async findManyWithPagination({
    filterOptions,
    sortOptions,
    paginationOptions,
  }: {
    filterOptions?: FilterUserDto | null;
    sortOptions?: SortUserDto[] | null;
    paginationOptions: IPaginationOptions;
  }): Promise<User[]> {
    const where: FilterQuery<UserSchemaClass> = {};
    if (filterOptions?.roles?.length) {
      where['role._id'] = {
        $in: filterOptions.roles.map((role) => role.id.toString()),
      };
    }

    const scopedWhere = this.applyTenantFilter(where);

    const userObjects = await this.model
      .find(scopedWhere)
      .sort(
        sortOptions?.reduce(
          (accumulator, sort) => ({
            ...accumulator,
            [sort.orderBy === 'id' ? '_id' : sort.orderBy]:
              sort.order.toUpperCase() === 'ASC' ? 1 : -1,
          }),
          {},
        ),
      )
      .skip((paginationOptions.page - 1) * paginationOptions.limit)
      .limit(paginationOptions.limit);

    return userObjects.map((userObject) => UserMapper.toDomain(userObject));
  }

  async findById(id: User['id']): Promise<NullableType<User>> {
    const filter = this.applyTenantFilter({ _id: id.toString() });
    const userObject = await this.model.findOne(filter);
    return userObject ? UserMapper.toDomain(userObject) : null;
  }

  async create(data: Omit<User, 'id' | 'createdAt' | 'deletedAt' | 'updatedAt' | 'tenant'> & { tenant?: string }): Promise<User> {
    const domainEntity = new User();
    Object.assign(domainEntity, data);
    domainEntity.tenant = data.tenant || this.cls.get('tenantId');

    // Default values if needed, otherwise handled by schema defaults or mapper

    const persistenceModel = UserMapper.toPersistence(domainEntity);
    const createdUser = new this.model(persistenceModel);
    const userObject = await createdUser.save();
    return UserMapper.toDomain(userObject);
  }

  async findByIds(ids: User['id'][]): Promise<User[]> {
    const filter = this.applyTenantFilter({ _id: { $in: ids } });
    const userObjects = await this.model.find(filter);
    return userObjects.map((userObject) => UserMapper.toDomain(userObject));
  }

  async findByEmail(email: User['email']): Promise<NullableType<User>> {
    if (!email) return null;

    const filter = this.applyTenantFilter({ email });
    const userObject = await this.model.findOne(filter);
    return userObject ? UserMapper.toDomain(userObject) : null;
  }

  async findByKeycloakIdAndProvider({
    keycloakId,
    provider,
  }: {
    keycloakId: User['keycloakId'];
    provider: User['provider'];
  }): Promise<NullableType<User>> {
    if (!keycloakId || !provider) return null;

    const filter = this.applyTenantFilter({
      keycloakId,
      provider,
    });

    const userObject = await this.model.findOne(filter);

    return userObject ? UserMapper.toDomain(userObject) : null;
  }

  async update(
    id: User['id'],
    payload: Partial<User>,
    session?: any, // Match Base signature optionally, or just ignore since we override
  ): Promise<User | null> {
    const clonedPayload = { ...payload };
    delete clonedPayload.id;

    const version = clonedPayload.version; // Extract version from payload
    // Do not delete version if mapper logic needs it for persistence?
    // Base implementation extracts and deletes. Here we manually extracting.

    const filter: FilterQuery<UserSchemaDocument> = { _id: id.toString() };
    const scopedFilter = this.applyTenantFilter(filter);

    // Optimistic locking: if version is provided, ensure we only update if version matches
    if (version !== undefined) {
      scopedFilter['__v'] = version;
    }

    // Use persistence mapper only for fields present in payload?
    // UserMapper.toPersistence expects full User.
    // For safer update, we should fetch, merge, then persist.
    // Re-using existing logic here but adapted for 'model' property.

    const user = await this.model.findOne(this.applyTenantFilter({ _id: id.toString() }));
    if (!user) return null;

    const persistenceObject = UserMapper.toPersistence({
      ...UserMapper.toDomain(user),
      ...clonedPayload,
    });

    // Remove version from persistence object to avoid manually setting it, 
    // let $inc handle it or mongoose handle it.
    // However, mapper might include it.
    delete (persistenceObject as any).__v;

    const updatedUser = await this.model.findOneAndUpdate(
      scopedFilter,
      {
        ...persistenceObject,
        $inc: { __v: 1 }, // Increment version
      },
      { new: true },
    );

    if (!updatedUser && version !== undefined) {
      throw new ConflictException('Data has been modified by another user');
    }

    return updatedUser ? UserMapper.toDomain(updatedUser) : null;
  }

  async remove(id: User['id']): Promise<void> {
    const filter = this.applyTenantFilter({ _id: id.toString() });
    await this.model.deleteOne(filter);
  }
}
