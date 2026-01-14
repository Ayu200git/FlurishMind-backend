// Check current avatar values in database
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/user');

const MONGO_URI = (process.env.MONGO_URI || '').trim();

async function checkAvatars() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB\n');

        // Find all users and show their avatars
        const users = await User.find({}).select('name email avatar');

        console.log('Current user avatars:');
        console.log('='.repeat(80));
        users.forEach(user => {
            console.log(`User: ${user.name} (${user.email})`);
            console.log(`Avatar: ${user.avatar || '(empty)'}`);
            console.log('-'.repeat(80));
        });

        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkAvatars();
