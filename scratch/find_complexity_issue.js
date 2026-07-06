const fs = require('fs');
const https = require('https');

const SONAR_TOKEN = 'sqa_d7b8f9baa47b594d13ac95930d89d68f6348031d';
const PROJECT_KEY = 'crm-api';
const BASE_URL = 'https://sonar.crmsaudi.dev';

async function fetchIssues() {
    const url = `${BASE_URL}/api/issues/search?componentKeys=${PROJECT_KEY}&resolved=false&rules=typescript:S3776`;
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'Authorization': `Bearer ${SONAR_TOKEN}`
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function run() {
    try {
        const data = await fetchIssues();
        const contactIssue = data.issues.find(i => i.component.includes('contact.repository.ts'));
        console.log(JSON.stringify(contactIssue, null, 2));
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
