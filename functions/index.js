const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// Main function: Handle bus status updates
exports.onBusStatusUpdate = functions.firestore
  .document('buses/{busId}')
  .onWrite(async (change, context) => {
    const busId = context.params.busId;
    const newValue = change.after.exists ? change.after.data() : null;
    
    if (!newValue) {
      console.log(`Bus ${busId} document deleted`);
      return;
    }
    
    try {
      // Update daily statistics
      await updateDailyStats(busId, newValue);
      console.log(`✅ Updated stats for bus ${busId}`);
      
      // Log the update
      console.log(`Bus ${busId} status: ${newValue.status} ${newValue.statusText}`);
      
    } catch (error) {
      console.error(`❌ Error processing update for bus ${busId}:`, error);
    }
  });

// Function: Update daily statistics
async function updateDailyStats(busId, busData) {
  const today = new Date().toISOString().split('T')[0];
  const statsDocRef = db.collection('stats').doc(`daily-${today}`);
  
  const increment = admin.firestore.FieldValue.increment(1);
  
  await statsDocRef.set({
    date: today,
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    totalReports: increment,
    [`reportsByBus.${busId}`]: increment,
    [`reportsByStatus.${busData.statusText.toLowerCase()}`]: increment,
    [`reportsByHour.${new Date().getHours()}`]: increment
  }, { merge: true });
}

// Function: Clean up old reports (runs every hour)
exports.cleanupOldReports = functions.pubsub
  .schedule('0 * * * *') // Every hour at minute 0
  .timeZone('Asia/Kolkata') // Set your timezone
  .onRun(async (context) => {
    const cutoffTime = Date.now() - (2 * 60 * 60 * 1000); // 2 hours ago
    
    const oldReportsQuery = await db.collection('buses')
      .where('timestamp', '<', cutoffTime)
      .get();
    
    if (oldReportsQuery.empty) {
      console.log('No old reports to clean up');
      return;
    }
    
    const batch = db.batch();
    let deleteCount = 0;
    
    oldReportsQuery.forEach(doc => {
      batch.delete(doc.ref);
      deleteCount++;
    });
    
    await batch.commit();
    console.log(`🧹 Cleaned up ${deleteCount} old reports`);
  });

// HTTP Function: Get statistics API
exports.getStats = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get today's stats
    const statsDoc = await db.collection('stats').doc(`daily-${today}`).get();
    const statsData = statsDoc.exists ? statsDoc.data() : {};
    
    // Get active buses count
    const activeBusesSnapshot = await db.collection('buses').get();
    const activeBusesCount = activeBusesSnapshot.size;
    
    // Calculate last update time
    let lastUpdateTime = null;
    if (!activeBusesSnapshot.empty) {
      const latestDoc = activeBusesSnapshot.docs
        .sort((a, b) => b.data().timestamp - a.data().timestamp)[0];
      lastUpdateTime = latestDoc.data().timestamp;
    }
    
    const response = {
      totalReports: statsData.totalReports || 0,
      activeBuses: activeBusesCount,
      lastUpdate: lastUpdateTime,
      reportsByStatus: statsData.reportsByStatus || {},
      success: true
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ 
      error: 'Failed to get statistics',
      success: false 
    });
  }
});
