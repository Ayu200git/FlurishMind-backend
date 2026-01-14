const path = require('path');
const fs = require('fs');

const clearImage = filePath => {
  if (!filePath) return;

  filePath = path.join(__dirname, '..', filePath);
  fs.unlink(filePath, err => {
    if (err && err.code !== 'ENOENT') {
      // Only log errors that aren't "file not found"
      console.error('Error deleting file:', err);
    }
    // Silently ignore ENOENT errors (file already deleted)
  });
};

exports.clearImage = clearImage;