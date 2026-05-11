export type KeycloakConfig = {
  authServerUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  adminClientId: string;
  adminClientSecret: string;
  callbackUrl: string;
  frontendUrl: string;
};
