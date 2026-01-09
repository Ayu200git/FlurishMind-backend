const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const commentSchema = new Schema(
  {
    content: {
      type: String,
      required: true
    },
    post: {
      type: Schema.Types.ObjectId,
      ref: 'Post',
      required: true
    },
    creator: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    parentId: {
      type: Schema.Types.ObjectId,
      ref: 'Comment',
      default: null
    },
    likes: [{
      type: Schema.Types.ObjectId,
      ref: 'User'
    }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('Comment', commentSchema);
