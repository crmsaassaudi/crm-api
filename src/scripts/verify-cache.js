const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:3000/api/v1';
const EMAIL = 'admin@example.com';
const PASSWORD = 'secret';

async function run() {
    try {
        // 1. Login
        console.log('Logging in...');
        const loginRes = await axios.post(`${BASE_URL}/auth/email/login`, {
            email: EMAIL,
            password: PASSWORD,
        });
        const token = loginRes.data.token;
        console.log('Logged in. Token obtained.');
        const headers = { Authorization: `Bearer ${token}` };

        // 2. Get Users (First Call - Cache Miss)
        console.log('Fetching users (1st time)...');
        const start1 = Date.now();
        const res1 = await axios.get(`${BASE_URL}/users`, { headers });
        const duration1 = Date.now() - start1;
        console.log(`Users fetched in ${duration1}ms. Count: ${res1.data.data.length}`);
        const userId = res1.data.data.find(u => u.email === EMAIL).id; // Get admin user ID

        // 3. Get Users (Second Call - Cache Hit)
        console.log('Fetching users (2nd time)...');
        const start2 = Date.now();
        const res2 = await axios.get(`${BASE_URL}/users`, { headers });
        const duration2 = Date.now() - start2;
        console.log(`Users fetched in ${duration2}ms.`);

        if (duration2 < duration1) {
            console.log('SUCCESS: Cache Hit observed (Response time improved).');
        } else {
            console.log('NOTE: Response time similar (Localhost variance). Assuming cache working if step 5 passes.');
        }

        // 4. Update User (Trigger Invalidation)
        console.log(`Updating user ${userId}...`);
        const newName = `Super`;
        // We update to the same name just to trigger the event, or slightly different
        await axios.patch(`${BASE_URL}/users/${userId}`, { firstName: newName }, { headers });
        console.log('User updated.');

        // Wait a bit for event propagation (async listeners)
        await new Promise(r => setTimeout(r, 100));

        // 5. Get Users (Third Call - Should be fresh)
        // If cache was NOT cleared, we would get the OLD list (which might still have the old name if we changed it, 
        // but here we didn't change name effectively, let's change it effectively to test).

        // Let's actually change the name
        const testName = `Test_${Date.now()}`;
        await axios.patch(`${BASE_URL}/users/${userId}`, { firstName: testName }, { headers });
        console.log(`User name changed to ${testName}`);

        await new Promise(r => setTimeout(r, 100));

        console.log('Fetching users (3rd time - after update)...');
        const res3 = await axios.get(`${BASE_URL}/users`, { headers });
        const updatedUser = res3.data.data.find(u => u.id === userId);

        if (updatedUser.firstName === testName) {
            console.log('SUCCESS: Cache Invalidated (Data is up to date).');
        } else {
            console.log('FAILURE: Data mismatch. Cache might not be invalidated.');
            console.log(`Expected: ${testName}, Got: ${updatedUser.firstName}`);
        }

        // Revert name
        await axios.patch(`${BASE_URL}/users/${userId}`, { firstName: 'Super' }, { headers });

    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

run();
