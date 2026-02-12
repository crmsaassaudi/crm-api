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

    const userObjects = await this.model
      .find(where)
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
    const userObject = await this.model.findById(id);
    return userObject ? UserMapper.toDomain(userObject) : null;
  }

  async create(data: Omit<User, 'id' | 'createdAt' | 'deletedAt' | 'updatedAt' | 'tenantId'>): Promise<User> {
    const domainEntity = new User();
    Object.assign(domainEntity, data);
    domainEntity.tenantId = this.cls.get('tenantId');

    // Default values if needed, otherwise handled by schema defaults or mapper

    const persistenceModel = UserMapper.toPersistence(domainEntity);
    const createdUser = new this.model(persistenceModel);
    const userObject = await createdUser.save();
    return UserMapper.toDomain(userObject);
  }

  async findByIds(ids: User['id'][]): Promise<User[]> {
    const userObjects = await this.model.find({ _id: { $in: ids } });
    return userObjects.map((userObject) => UserMapper.toDomain(userObject));
  }

  async findByEmail(email: User['email']): Promise<NullableType<User>> {
    if (!email) return null;

    const userObject = await this.model.findOne({ email });
    return userObject ? UserMapper.toDomain(userObject) : null;
  }

  async findBySocialIdAndProvider({
    socialId,
    provider,
  }: {
    socialId: User['socialId'];
    provider: User['provider'];
  }): Promise<NullableType<User>> {
    if (!socialId || !provider) return null;

    const userObject = await this.model.findOne({
      socialId,
      provider,
    });

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

    // Optimistic locking: if version is provided, ensure we only update if version matches
    if (version !== undefined) {
      filter['__v'] = version;
    }

    // Use persistence mapper only for fields present in payload?
    // UserMapper.toPersistence expects full User.
    // For safer update, we should fetch, merge, then persist.
    // Re-using existing logic here but adapted for 'model' property.

    const user = await this.model.findOne({ _id: id.toString() });
    if (!user) return null;

    const persistenceObject = UserMapper.toPersistence({
      ...UserMapper.toDomain(user),
      ...clonedPayload,
    });

    const updatedUser = await this.model.findOneAndUpdate(
      filter,
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
    await this.model.deleteOne({
      _id: id.toString(),
    });
  }
}
