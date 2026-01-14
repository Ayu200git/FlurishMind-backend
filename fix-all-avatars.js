// Complete solution to fix and reset all avatar issues
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/user');
const fs = require('fs');
const path = require('path');

const MONGO_URI = (process.env.MONGO_URI || '').trim();

async function fixAllAvatars() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Step 1: Find all users with avatar paths
        const users = await User.find({});
        console.log(`Found ${users.length} users\n`);

        let fixedCount = 0;
        let alreadyOkCount = 0;

        for (const user of users) {
            if (!user.avatar) {
                console.log(`✓ ${user.name}: No avatar (OK)`);
                alreadyOkCount++;
                continue;
            }

            // Check if the avatar file actually exists
            const avatarPath = path.join(__dirname, user.avatar);
            const exists = fs.existsSync(avatarPath);

            if (!exists) {
                console.log(`✗ ${user.name}: Broken avatar path: ${user.avatar}`);
                console.log(`  → Resetting to empty`);

                user.avatar = '';
                await user.save();
                fixedCount++;
            } else {
                console.log(`✓ ${user.name}: Avatar OK: ${user.avatar}`);
                alreadyOkCount++;
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log(`✅ Complete!`);
        console.log(`   Fixed: ${fixedCount} users`);
        console.log(`   Already OK: ${alreadyOkCount} users`);
        console.log('='.repeat(80));
        console.log('\n📸 Now you can upload a new profile picture without errors!');

        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

fixAllAvatars();
