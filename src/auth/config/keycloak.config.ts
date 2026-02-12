import { registerAs } from '@nestjs/config';
import { IsString, IsUrl } from 'class-validator';
import validateConfig from '../../utils/validate-config';
import { KeycloakConfig } from './keycloak-config.type';

class EnvironmentVariablesValidator {
    @IsUrl({ require_tld: false })
    KEYCLOAK_AUTH_SERVER_URL: string;

    @IsString()
    KEYCLOAK_REALM: string;

    @IsString()
    KEYCLOAK_CLIENT_ID: string;

    @IsString()
    KEYCLOAK_CLIENT_SECRET: string;

    @IsString()
    KEYCLOAK_CALLBACK_URL: string;
}

export default registerAs<KeycloakConfig>('keycloak', () => {
    validateConfig(process.env, EnvironmentVariablesValidator);

    return {
        authServerUrl: process.env.KEYCLOAK_AUTH_SERVER_URL ?? '',
        realm: process.env.KEYCLOAK_REALM ?? '',
        clientId: process.env.KEYCLOAK_CLIENT_ID ?? '',
        clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
        callbackUrl: process.env.KEYCLOAK_CALLBACK_URL ?? '',
    };
});
