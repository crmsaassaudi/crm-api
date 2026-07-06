const fs = require('fs');
const issues = JSON.parse(fs.readFileSync('sonar_issues.json', 'utf8')).issues;
const openIssues = issues.filter(i => i.status === 'OPEN');
console.log(JSON.stringify(openIssues, null, 2));
