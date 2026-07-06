const fs = require('fs');
const https = require('https');

const SONAR_TOKEN = 'sqa_d7b8f9baa47b594d13ac95930d89d68f6348031d';
const PROJECT_KEY = 'crm-api';
const BASE_URL = 'https://sonar.crmsaudi.dev';

async function fetchIssues() {
    const url = `${BASE_URL}/api/issues/search?componentKeys=${PROJECT_KEY}&resolved=false&ps=100&p=1`;
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
        const issues = data.issues
            .filter(i => i.status === 'OPEN' || i.status === 'REOPENED')
            .map(i => ({
                key: i.key,
                status: i.status,
                rule: i.rule,
                file: i.component.replace('crm-api:', ''),
                line: i.line,
                message: i.message,
                textRange: i.textRange
            }));
        console.log(JSON.stringify(issues.slice(0, 20), null, 2));
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

run();
