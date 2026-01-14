// Clear the specific broken avatar path
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/user');

const MONGO_URI = (process.env.MONGO_URI || '').trim();

async function clearBrokenAvatar() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Update ANY user with this specific broken path
        const result = await User.updateMany(
            { avatar: { $regex: '2026-01-14T08-46-27' } },
            { $set: { avatar: '' } }
        );

        console.log(`✅ Updated ${result.modifiedCount} user(s) with broken avatar path`);

        // Also check for any other old paths
        const result2 = await User.updateMany(
            { avatar: { $regex: '2026-01-14T11-46' } },
            { $set: { avatar: '' } }
        );

        console.log(`✅ Updated ${result2.modifiedCount} user(s) with old avatar paths`);

        console.log('\n📸 Now upload a NEW profile picture in Edit Profile!');
        console.log('   The new picture will display everywhere without errors.');

        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

clearBrokenAvatar();
