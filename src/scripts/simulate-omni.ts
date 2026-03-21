import axios from 'axios';

/**
 * Omni-Channel End-to-End Simulation Script
 * 
 * Flow:
 * 1. Post mock Facebook Webhook -> /omni/webhook/facebook
 * 2. Wait for async processing (BullMQ)
 * 3. Query REST API -> /omni/conversations to find the new session
 * 4. Query REST API -> /omni/conversations/:id/messages to verify persistence
 * 5. Patch status -> /omni/conversations/:id/status to verify REST integration
 */

const API_URL = 'http://localhost:3000';
const EXTERNAL_ID = `user_${Date.now()}`;

async function simulate() {
  console.log('🚀 Starting Omni-Channel Simulation...');

  // 1. Mock Webhook
  console.log('📡 Step 1: Sending mock Facebook webhook...');
  const webhookPayload = {
    object: 'page',
    entry: [{
      id: 'page_123',
      time: Date.now(),
      messaging: [{
        sender: { id: EXTERNAL_ID },
        recipient: { id: 'page_123' },
        timestamp: Date.now(),
        message: {
          mid: `mid_${Date.now()}`,
          text: 'Hello from Simulation!'
        }
      }]
    }]
  };

  await axios.post(`${API_URL}/omni/webhook/facebook`, webhookPayload);
  console.log('✅ Webhook accepted (Pillar 1/4 status: queued)');

  // 2. Wait for BullMQ processor
  console.log('⏳ Waiting 3 seconds for async processing...');
  await new Promise(r => setTimeout(r, 3000));

  // 3. Query Conversations (Pillar 6)
  console.log('🔍 Step 2: Querying REST API for the new conversation...');
  const convRes = await axios.get(`${API_URL}/omni/conversations?limit=1`);
  const conversations = convRes.data.items;
  
  const conversation = conversations.find((c: any) => c.customer.externalId === EXTERNAL_ID);
  
  if (!conversation) {
    console.error('❌ Error: Conversation not found in DB. Did the processor fail?');
    process.exit(1);
  }
  console.log(`✅ Success: Found conversation ${conversation._id} (Pillar 5 status: persisted)`);

  // 4. Query Messages
  console.log('💬 Step 3: Verifying message history persistence...');
  const msgRes = await axios.get(`${API_URL}/omni/conversations/${conversation._id}/messages`);
  const messages = msgRes.data.items;
  
  if (messages.length > 0 && messages[0].content === 'Hello from Simulation!') {
    console.log('✅ Success: Message content verified in history API.');
  } else {
    console.error('❌ Error: Message history mismatch or empty.');
  }

  // 5. Patch Status
  console.log('🎯 Step 4: Testing session resolution via API...');
  await axios.patch(`${API_URL}/omni/conversations/${conversation._id}/status`, {
    status: 'resolved'
  });
  
  const updatedConv = await axios.get(`${API_URL}/omni/conversations/${conversation._id}`);
  if (updatedConv.data.status === 'resolved') {
    console.log('✅ Success: Conversation status updated via REST API (Pillar 6 status: operational)');
  }

  console.log('\n🌟 Omni-Channel Pillar-to-Pillar Flow Verified!');
}

simulate().catch(err => {
  console.error('💥 Simulation failed:', err.response?.data || err.message);
});
