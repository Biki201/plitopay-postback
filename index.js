const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Firebase Admin init using environment variable
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable is not set!');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// TimeWall Secret Key (set in Render environment variable)
const TIMEWALL_SECRET = process.env.TIMEWALL_SECRET_KEY;

// Health check
app.get('/', (req, res) => res.send('PlitoPay Postback Server Running ✅'));

// TimeWall Postback endpoint
app.get('/timewall-postback', async (req, res) => {
  try {
    const { userID, transactionID, revenue, currencyAmount, hash, type } = req.query;

    console.log('Postback received:', req.query);

    // 1. Validate required fields
    if (!userID || !transactionID || !currencyAmount) {
      console.error('Missing required fields');
      return res.status(400).send('Missing required fields');
    }

    // 2. Verify hash (security check)
    if (hash && TIMEWALL_SECRET) {
      const expectedHash = crypto
        .createHash('sha256')
        .update(`${userID}.${revenue}.${TIMEWALL_SECRET}`)
        .digest('hex');
      if (hash !== expectedHash) {
        console.error('Hash mismatch — possible fraud attempt');
        return res.status(403).send('Invalid hash');
      }
    }

    // 3. Handle chargebacks (negative currencyAmount)
    const points = parseInt(currencyAmount);
    if (isNaN(points)) {
      return res.status(400).send('Invalid currencyAmount');
    }

    // 4. Check type — only process 'credit', skip 'hold' / 'hold_cancelled'
    if (type === 'hold' || type === 'hold_cancelled') {
      console.log(`Skipping type: ${type}`);
      return res.status(200).send('OK - hold skipped');
    }

    // 5. Duplicate transaction check
    const txRef = db.collection('timewallTransactions').doc(transactionID);
    const txDoc = await txRef.get();
    if (txDoc.exists) {
      console.log('Duplicate transactionID — already processed:', transactionID);
      return res.status(200).send('OK - already processed');
    }

    // 6. Credit or deduct points in user's Firestore document
    const userRef = db.collection('users').doc(userID);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.error('User not found:', userID);
      return res.status(404).send('User not found');
    }

    // Atomic points update
    await userRef.update({
      points: admin.firestore.FieldValue.increment(points),
      timewallEarnings: admin.firestore.FieldValue.increment(Math.max(0, points)),
    });

    // 7. Mark transaction as processed (prevent double-credit)
    await txRef.set({
      userID,
      transactionID,
      revenue: revenue || '0',
      currencyAmount: points,
      type: type || 'credit',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Credited ${points} points to user ${userID}`);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('Postback error:', err);
    return res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
