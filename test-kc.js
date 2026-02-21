const fs = require('fs');
const KcAdminClient = require('@keycloak/keycloak-admin-client').default;

const kc = new KcAdminClient({
    baseUrl: 'http://localhost:8080',
    realmName: 'crm-saas'
});

async function run() {
    try {
        await kc.auth({
            grantType: 'client_credentials',
            clientId: 'crm-api',
            clientSecret: 'u9NNdSzs3klmJUoOAqhF63HAUWpHB1G9'
        });
        console.log('Success');
    } catch (e) {
        fs.writeFileSync('err.txt', e.stack);
    }
}

run();
