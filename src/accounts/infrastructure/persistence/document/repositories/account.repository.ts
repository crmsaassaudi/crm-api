import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AccountSchemaClass, AccountSchemaDocument } from '../entities/account.schema';
import { Account } from '../../../../domain/account';
import { AccountMapper } from '../mappers/account.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';

@Injectable()
export class AccountRepository extends BaseDocumentRepository<AccountSchemaDocument, Account> {
    constructor(
        @InjectModel(AccountSchemaClass.name)
        accountModel: Model<AccountSchemaDocument>,
        cls: ClsService,
    ) {
        super(accountModel, cls);
    }

    protected mapToDomain(doc: AccountSchemaClass): Account {
        return AccountMapper.toDomain(doc);
    }

    protected toPersistence(domain: Account): AccountSchemaClass {
        return AccountMapper.toPersistence(domain);
    }
}
