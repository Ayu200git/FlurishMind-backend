// Run this script to reset broken avatar paths in the database
// Usage: node reset-avatars.js

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/user');

const MONGO_URI = (process.env.MONGO_URI || '').trim();

async function resetBrokenAvatars() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        // Find users with broken avatar paths (old deleted files)
        const brokenAvatarPatterns = [
            /2026-01-14T08-46-27/,
            /2026-01-14T11-46-10/
        ];

        for (const pattern of brokenAvatarPatterns) {
            const result = await User.updateMany(
                { avatar: pattern },
                { $set: { avatar: '' } }
            );
            console.log(`Reset ${result.modifiedCount} users with pattern: ${pattern}`);
        }

        console.log('✅ Avatar reset complete! Now upload a new profile picture.');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

resetBrokenAvatars();
