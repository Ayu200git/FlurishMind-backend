const bcrypt = require('bcryptjs');
const validator = require('validator');
const jwt = require('jsonwebtoken');

const User = require('../models/user');
const Post = require('../models/post');
const Comment = require('../models/comment');
const { clearImage } = require('../util/file');

async function getRepliesRecursive(parentId) {
  const replies = await Comment.find({ parentId })
    .sort({ createdAt: -1 })
    .populate('creator', 'name email avatar');

  return Promise.all(replies.map(async r => {
    if (!r.creator) {
      console.error('Creator not found for reply:', r._id);
      throw new Error('Comment creator not found');
    }
    return {
      ...r._doc,
      _id: r._id.toString(),
      createdAt: r.createdAt.toISOString(),
      creator: {
        _id: r.creator._id.toString(),
        name: r.creator.name,
        email: r.creator.email,
        avatar: r.creator.avatar || ''
      },
      parentId: r.parentId ? r.parentId.toString() : null,
      replies: await getRepliesRecursive(r._id)
    };
  }));
}

async function getNestedComments(postId) {
  const topComments = await Comment.find({ post: postId, parentId: null })
    .sort({ createdAt: -1 })
    .populate('creator', 'name email avatar');

  return Promise.all(topComments.map(async c => {
    if (!c.creator) {
      console.error('Creator not found for comment:', c._id);
      throw new Error('Comment creator not found');
    }
    return {
      ...c._doc,
      _id: c._id.toString(),
      createdAt: c.createdAt.toISOString(),
      creator: {
        _id: c.creator._id.toString(),
        name: c.creator.name,
        email: c.creator.email,
        avatar: c.creator.avatar || ''
      },
      parentId: null,
      replies: await getRepliesRecursive(c._id)
    };
  }));
}

module.exports = {
  createUser: async function ({ userInput }) {
    const errors = [];
    if (!validator.isEmail(userInput.email)) errors.push({ message: 'E-Mail is invalid.' });
    if (!userInput.password || !validator.isLength(userInput.password, { min: 5 })) errors.push({ message: 'Password too short!' });
    if (!userInput.name || validator.isEmpty(userInput.name.trim())) errors.push({ message: 'Name is required.' });
    if (errors.length > 0) {
      const err = new Error('Invalid input.');
      err.data = errors;
      err.code = 422;
      throw err;
    }

    const existingUser = await User.findOne({ email: userInput.email });
    if (existingUser) {
      const err = new Error('User exists already!');
      err.code = 422;
      throw err;
    }

    const hashedPw = await bcrypt.hash(userInput.password, 12);

    const user = new User({
      email: userInput.email,
      name: userInput.name,
      password: hashedPw,
      status: 'I am new!'
    });

    const createdUser = await user.save();
    return { ...createdUser._doc, _id: createdUser._id.toString() };
  },

  login: async function ({ email, password }) {
    const user = await User.findOne({ email });
    if (!user) {
      const err = new Error('User not found.');
      err.code = 401;
      throw err;
    }

    const isEqual = await bcrypt.compare(password, user.password);
    if (!isEqual) {
      const err = new Error('Password is incorrect.');
      err.code = 401;
      throw err;
    }

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    return { token, userId: user._id.toString() };
  },

  user: async function (_, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const user = await User.findById(context.userId);
    if (!user) throw new Error('No user found!');
    return { ...user._doc, _id: user._id.toString() };
  },

  updateStatus: async function ({ status }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const user = await User.findById(context.userId);
    if (!user) throw new Error('No user found!');
    user.status = status;
    await user.save();
    return { ...user._doc, _id: user._id.toString() };
  },

  updateUser: async function ({ userInput }, context) {
    if (!context || !context.isAuth) throw new Error('Not authenticated!');
    const user = await User.findById(context.userId);
    if (!user) throw new Error('User not found!');

    if (userInput.name) user.name = userInput.name;
    if (userInput.username !== undefined) user.username = userInput.username;
    if (userInput.bio !== undefined) user.bio = userInput.bio;
    if (userInput.status) user.status = userInput.status;
    if (userInput.avatar !== undefined) user.avatar = userInput.avatar;

    await user.save();
    return { ...user._doc, _id: user._id.toString() };
  },

  users: async function (args, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const currentUser = await User.findById(context.userId);
    if (!currentUser || currentUser.role !== 'admin') throw new Error('Not authorized! Admin access required.');
    const users = await User.find().select('-password');
    return users.map(u => ({ ...u._doc, _id: u._id.toString() }));
  },

  userById: async function ({ userId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const user = await User.findById(userId).select('-password');
    if (!user) throw new Error('User not found!');
    return { ...user._doc, _id: user._id.toString() };
  },

  createPost: async function ({ postInput }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const errors = [];
    if (!postInput.title || !validator.isLength(postInput.title, { min: 5 })) errors.push({ message: 'Title is invalid.' });
    if (!postInput.content || !validator.isLength(postInput.content, { min: 5 })) errors.push({ message: 'Content is invalid.' });
    if (errors.length > 0) {
      const err = new Error('Invalid input.');
      err.data = errors;
      err.code = 422;
      throw err;
    }

    const user = await User.findById(context.userId);
    if (!user) throw new Error('Invalid user.');

    const post = new Post({
      title: postInput.title,
      content: postInput.content,
      imageUrl: postInput.imageUrl,
      creator: user
    });

    const createdPost = await post.save();
    if (user.posts && Array.isArray(user.posts)) {
      user.posts.push(createdPost);
      await user.save();
    }

    return {
      ...createdPost._doc,
      _id: createdPost._id.toString(),
      createdAt: createdPost.createdAt.toISOString(),
      updatedAt: createdPost.updatedAt.toISOString(),
      likesCount: 0,
      commentsCount: 0,
      comments: []
    };
  },

  updatePost: async function ({ id, postInput }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const post = await Post.findById(id).populate('creator');
    if (!post) throw new Error('No post found!');

    // Safety check for orphaned posts
    if (!post.creator) {
      // If creator is missing but the current user matches the stored ID (without populate), we could check that?
      // But safer to just fail or assume admin? Let's just fail safely.
      throw new Error('Post creator not found (Data integrity error).');
    }

    if (post.creator._id.toString() !== context.userId.toString()) {
      throw new Error('Not authorized!');
    }
    const errors = [];
    if (!postInput.title || !validator.isLength(postInput.title, { min: 5 })) errors.push({ message: 'Title is invalid.' });
    if (!postInput.content || !validator.isLength(postInput.content, { min: 5 })) errors.push({ message: 'Content is invalid.' });
    if (errors.length > 0) {
      const err = new Error('Invalid input.');
      err.data = errors;
      err.code = 422;
      throw err;
    }
    post.title = postInput.title;
    post.content = postInput.content;

    if (postInput.imageUrl !== 'undefined' && postInput.imageUrl !== post.imageUrl) {
      // Only clear local files, not remote URLs (case insensitive check)
      if (post.imageUrl && !/^https?:\/\//i.test(post.imageUrl)) {
        try {
          clearImage(post.imageUrl);
        } catch (e) { console.error("Error clearing image:", e); }
      }
      post.imageUrl = postInput.imageUrl;
    }
    const updatedPost = await post.save();
    return {
      ...updatedPost._doc,
      _id: updatedPost._id.toString(),
      createdAt: updatedPost.createdAt.toISOString(),
      updatedAt: updatedPost.updatedAt.toISOString(),
      likesCount: updatedPost.likes ? updatedPost.likes.length : 0,
      commentsCount: await Comment.countDocuments({ post: id, parentId: null }),
      comments: []
    };
  },

  deletePost: async function ({ id }, context) {
    console.log('Attempting to delete post:', id); // DEBUG LOG
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const post = await Post.findById(id);
    if (!post) throw new Error('No post found!');
    if (post.creator.toString() !== context.userId.toString()) {
      throw new Error('Not authorized!');
    }
    if (post.imageUrl && !/^https?:\/\//i.test(post.imageUrl)) {
      try {
        clearImage(post.imageUrl);
      } catch (e) { console.error("Error clearing image:", e); }
    }
    await Post.findByIdAndDelete(id);
    console.log('Post deleted from DB'); // DEBUG LOG
    const user = await User.findById(context.userId);
    user.posts.pull(id);
    await user.save();
    console.log('User post reference removed'); // DEBUG LOG
    return true;
  },

  posts: async function ({ page = 1, limit = 5 }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const perPage = limit;
    const totalPosts = await Post.countDocuments();

    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .populate('creator', 'name _id')
      .populate('likes', 'name _id');

    const postsWithComments = await Promise.all(
      posts.map(async (p) => {
        // We only fetch the count here.
        const count = await Comment.countDocuments({ post: p._id, parentId: null });
        return { post: p, comments: [], commentsCount: count };
      })
    );

    return {
      posts: postsWithComments.map(({ post, comments, commentsCount }) => ({
        ...post._doc,
        _id: post._id.toString(),
        createdAt: post.createdAt.toISOString(),
        updatedAt: post.updatedAt.toISOString(),
        likesCount: post.likes ? post.likes.length : 0,
        commentsCount: commentsCount,
        comments
      })),
      totalPosts
    };
  },

  post: async function ({ id }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const post = await Post.findById(id)
      .populate('creator', 'name _id')
      .populate('likes', 'name _id');
    if (!post) throw new Error('No post found!');

    const comments = await getNestedComments(id);

    return {
      ...post._doc,
      _id: post._id.toString(),
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      likesCount: post.likes ? post.likes.length : 0,
      commentsCount: comments.length,
      comments
    };
  },

  addComment: async function ({ commentInput }, context) {

    if (!context?.isAuth) throw new Error('Not authenticated!');
    if (!commentInput.content || !commentInput.content.trim())
      throw new Error('Comment cannot be empty!');

    const post = await Post.findById(commentInput.postId);
    if (!post) throw new Error('Post not found!');

    const user = await User.findById(context.userId);
    if (!user) throw new Error('User not found!');

    const comment = new Comment({
      content: commentInput.content.trim(),
      post: commentInput.postId,
      creator: user._id,
      parentId: commentInput.parentId || null
    });

    await comment.save();
    await comment.populate({
      path: "creator",
      select: "name username email avatar role status"
    });

    if (!comment.creator || !comment.creator.name) {
      comment.creator = comment.creator || {};
      comment.creator.name = "Unknown User";
    }

    return {
      ...comment._doc,
      _id: comment._id.toString(),
      creator: {
        _id: comment.creator._id?.toString() || null,
        name: comment.creator.name,
        username: comment.creator.username || "",
        email: comment.creator.email || "",
        avatar: comment.creator.avatar || "",
        role: comment.creator.role || "user",
        status: comment.creator.status || ""
      },
      replies: []
    };
  },



  updateComment: async function ({ commentId, content }, context) {
    if (!context || !context.isAuth) throw new Error('Not authenticated!');
    if (!content || content.trim().length === 0) throw new Error('Comment cannot be empty!');

    const comment = await Comment.findById(commentId).populate('creator', 'name _id email avatar');
    if (!comment) throw new Error('Comment not found!');
    if (comment.creator._id.toString() !== context.userId.toString()) throw new Error('Not authorized!');

    comment.content = content.trim();
    await comment.save();
    await comment.populate('creator', 'name _id email avatar');

    return {
      _id: comment._id.toString(),
      content: comment.content,
      createdAt: comment.createdAt.toISOString(),
      creator: {
        _id: comment.creator._id.toString(),
        name: comment.creator.name,
        email: comment.creator.email,
        avatar: comment.creator.avatar || ''
      },
      parentId: comment.parentId ? comment.parentId.toString() : null,
      replies: []
    };
  },

  deleteComment: async function ({ commentId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const comment = await Comment.findById(commentId).populate('creator', 'name _id');
    if (!comment) throw new Error('Comment not found!');
    if (comment.creator._id.toString() !== context.userId.toString()) throw new Error('Not authorized!');
    await Comment.findByIdAndDelete(commentId);
    return true;
  },

  comments: async function ({ postId }, context) {
    if (!context?.isAuth) throw new Error("Not authenticated!");
    return await getNestedComments(postId);
  },

  replies: async function ({ commentId }, context) {
    if (!context?.isAuth) throw new Error("Not authenticated!");
    return await getRepliesRecursive(commentId);
  },

  paginatedComments: async function ({ postId, page = 1, limit = 5 }, context) {
    if (!context?.isAuth) throw new Error("Not authenticated!");
    const skip = (page - 1) * limit;

    const totalComments = await Comment.countDocuments({ post: postId, parentId: null });
    const topComments = await Comment.find({ post: postId, parentId: null })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('creator', 'name email avatar');

    const comments = await Promise.all(topComments.map(async c => ({
      ...c._doc,
      _id: c._id.toString(),
      createdAt: c.createdAt.toISOString(),
      creator: {
        _id: c.creator._id.toString(),
        name: c.creator.name,
        email: c.creator.email,
        avatar: c.creator.avatar
      },
      parentId: null,
      replies: await getRepliesRecursive(c._id)
    })));

    return {
      comments,
      totalComments,
      hasMore: skip + limit < totalComments
    };
  },

  paginatedReplies: async function ({ commentId, page = 1, limit = 5 }, context) {
    if (!context?.isAuth) throw new Error("Not authenticated!");
    const skip = (page - 1) * limit;

    const totalReplies = await Comment.countDocuments({ parentId: commentId });
    const replies = await Comment.find({ parentId: commentId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('creator', 'name email avatar');

    return {
      replies: replies.map(r => ({
        ...r._doc,
        _id: r._id.toString(),
        createdAt: r.createdAt.toISOString(),
        creator: {
          _id: r.creator._id.toString(),
          name: r.creator.name,
          email: r.creator.email,
          avatar: r.creator.avatar
        },
        parentId: r.parentId ? r.parentId.toString() : null
      })),
      totalReplies,
      hasMore: skip + limit < totalReplies
    };
  },

  likePost: async function ({ postId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const post = await Post.findById(postId).populate('creator', 'name _id');
    if (!post) throw new Error('Post not found!');

    const userId = context.userId.toString();
    if (!(post.likes || []).some(l => l.toString() === userId)) {
      post.likes.push(userId);
      await post.save();
    }

    const comments = await getNestedComments(postId);
    return {
      ...post._doc,
      _id: post._id.toString(),
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      likesCount: post.likes.length,
      commentsCount: comments.length,
      comments
    };
  },

  unlikePost: async function ({ postId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const post = await Post.findById(postId).populate('creator', 'name _id');
    if (!post) throw new Error('Post not found!');

    const userId = context.userId.toString();
    post.likes = (post.likes || []).filter(like => like.toString() !== userId);
    await post.save();

    const comments = await getNestedComments(postId);
    return {
      ...post._doc,
      _id: post._id.toString(),
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      likesCount: post.likes.length,
      commentsCount: comments.length,
      comments
    };
  }
};
