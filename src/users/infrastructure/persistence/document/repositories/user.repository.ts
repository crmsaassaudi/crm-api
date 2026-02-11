import { Injectable, ConflictException } from '@nestjs/common';

import { NullableType } from '../../../../../utils/types/nullable.type';
import { FilterUserDto, SortUserDto } from '../../../../dto/query-user.dto';
import { User } from '../../../../domain/user';
import { UserRepository } from '../../user.repository';
import { UserSchemaClass } from '../entities/user.schema';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { UserMapper } from '../mappers/user.mapper';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';

@Injectable()
export class UsersDocumentRepository implements UserRepository {
  constructor(
    @InjectModel(UserSchemaClass.name)
    private readonly usersModel: Model<UserSchemaClass>,
  ) { }

  async create(data: User): Promise<User> {
    const persistenceModel = UserMapper.toPersistence(data);
    const createdUser = new this.usersModel(persistenceModel);
    const userObject = await createdUser.save();
    return UserMapper.toDomain(userObject);
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

    const userObjects = await this.usersModel
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
    const userObject = await this.usersModel.findById(id);
    return userObject ? UserMapper.toDomain(userObject) : null;
  }

  async findByIds(ids: User['id'][]): Promise<User[]> {
    const userObjects = await this.usersModel.find({ _id: { $in: ids } });
    return userObjects.map((userObject) => UserMapper.toDomain(userObject));
  }

  async findByEmail(email: User['email']): Promise<NullableType<User>> {
    if (!email) return null;

    const userObject = await this.usersModel.findOne({ email });
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

    const userObject = await this.usersModel.findOne({
      socialId,
      provider,
    });

    return userObject ? UserMapper.toDomain(userObject) : null;
  }

  async update(
    id: User['id'],
    payload: Partial<User>,
    version?: number,
  ): Promise<User | null> {
    const clonedPayload = { ...payload };
    delete clonedPayload.id;

    const filter: FilterQuery<UserSchemaClass> = { _id: id.toString() };

    // Optimistic locking: if version is provided, ensure we only update if version matches
    if (version !== undefined) {
      filter['__v'] = version;
    }

    const updatePayload: any = {
      ...UserMapper.toPersistence({
        ...UserMapper.toDomain(await this.usersModel.findOne({ _id: id.toString() }) as UserSchemaClass),
        // Note: Efficient way would be not fetching but we need to merge domain logic if mapper is complex.
        // For now let's rely on findOneAndUpdate doing a merge if we just passed payload?
        // Actually, mapper toPersistence might require full object. 
        // Let's stick to the existing logic but add $inc.
        ...clonedPayload,
      }),
    };

    // We cannot use toPersistence simple merge if we don't have full object.
    // The previous code fetched 'user' then merged.
    // Let's fetch first (but without version check for fetch, or with?)
    // If we fetch first, we might read old data.
    // Optimistic locking usually implies:
    // 1. User has data v1.
    // 2. User sends update request with v1.
    // 3. We try to update WHERE id=.. AND v=1.

    // Re-reading logic:
    const user = await this.usersModel.findOne({ _id: id.toString() });
    if (!user) return null;

    const persistenceObject = UserMapper.toPersistence({
      ...UserMapper.toDomain(user),
      ...clonedPayload,
    });

    // We need to use the filter WITH version for the atomic update
    const updatedUser = await this.usersModel.findOneAndUpdate(
      filter,
      {
        ...persistenceObject,
        $inc: { __v: 1 } // Increment version
      },
      { new: true },
    );

    if (!updatedUser && version !== undefined) {
      // If update failed but user existed (we checked above), it means version mismatch
      throw new ConflictException('Data has been modified by another user');
    }

    return updatedUser ? UserMapper.toDomain(updatedUser) : null;
  }

  async remove(id: User['id']): Promise<void> {
    await this.usersModel.deleteOne({
      _id: id.toString(),
    });
  }
}
