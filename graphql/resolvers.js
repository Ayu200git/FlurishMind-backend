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
    .populate('creator', 'name email avatar')
    .populate('likes', 'name _id');

  return Promise.all(replies.map(async r => {
    if (!r.creator) {
      console.error('Creator not found for reply:', r._id);
      throw new Error('Comment creator not found');
    }
    return {
      ...r._doc,
      _id: r._id.toString(),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : r.createdAt.toISOString(),
      likesCount: r.likes.length,
      likes: r.likes.map(u => ({ ...u._doc, _id: u._id.toString() })),
      creator: {
        _id: r.creator._id.toString(),
        name: r.creator.name,
        email: r.creator.email,
        avatar: r.creator.avatar || ''
      },
      parentId: r.parentId ? r.parentId.toString() : null,
      replies: await Promise.all(replies.map(async r => ({
        ...r._doc,
        _id: r._id.toString(),
        createdAt: r.createdAt.toISOString(),
        creator: {
          _id: r.creator._id.toString(),
          name: r.creator.name,
          email: r.creator.email,
          avatar: r.creator.avatar
        },
        parentId: r.parentId ? r.parentId.toString() : null,
        likesCount: r.likes ? r.likes.length : 0,
        likes: [],
        replies: [],
        repliesCount: (await Comment.countDocuments({ parentId: r._id }))
      }))),
      repliesCount: (await Comment.countDocuments({ parentId: r._id }))
    };
  }));
}

async function getNestedComments(postId) {
  const topComments = await Comment.find({ post: postId, parentId: null })
    .sort({ createdAt: -1 })
    .populate('creator', 'name email avatar')
    .populate('likes', 'name _id');

  return Promise.all(topComments.map(async c => {
    return {
      ...c._doc,
      _id: c._id.toString(),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt ? c.updatedAt.toISOString() : c.createdAt.toISOString(),
      likesCount: c.likes.length,
      likes: c.likes.map(u => ({ ...u._doc, _id: u._id.toString() })),
      creator: {
        _id: c.creator._id.toString(),
        name: c.creator.name,
        email: c.creator.email,
        avatar: c.creator.avatar || ''
      },
      replies: await getRepliesRecursive(c._id),
      repliesCount: (await Comment.countDocuments({ parentId: c._id }))
    };
  }));
}

/* ✅ Helper to map Post objects consistently for return */
async function mapPostData(p) {
  if (!p) return null;
  // Ensure we have a doc
  const doc = p._doc || p;
  const commentsCount = await Comment.countDocuments({ post: p._id, parentId: null });

  // Sanitization: Strip placeholder URLs to prevent DNS errors
  let imageUrl = p.imageUrl;
  if (imageUrl && imageUrl.includes('via.placeholder.com')) {
    imageUrl = '';
  }

  return {
    ...doc,
    _id: p._id.toString(),
    imageUrl: imageUrl,
    title: p.title,
    content: p.content,
    createdAt: p.createdAt ? p.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: p.updatedAt ? p.updatedAt.toISOString() : (p.createdAt ? p.createdAt.toISOString() : new Date().toISOString()),
    likes: p.likes ? p.likes.map(u => {
      const uDoc = u._doc || u;
      return {
        ...uDoc,
        _id: u._id ? u._id.toString() : u.toString()
      };
    }) : [],
    likesCount: p.likes ? p.likes.length : 0,
    commentsCount: commentsCount,
    comments: [], // Default to empty, post resolver can override if needed
    creator: p.creator ? {
      ...(p.creator._doc || p.creator),
      _id: p.creator._id ? p.creator._id.toString() : p.creator.toString(),
      avatar: p.creator.avatar && p.creator.avatar.includes('via.placeholder.com') ? '' : (p.creator.avatar || '')
    } : null
  };
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
    const user = await User.findById(context.userId).populate('savedPosts').populate('posts');
    if (!user) throw new Error('No user found!');

    // We need to ensure nested fields like creator on posts are populated if the Schema demands it.
    // The Schema `Post` has `creator: User!`. Mongoose `.populate('posts')` only gives us the Post documents.
    // The `post.creator` field inside those might be an ID. 
    // We can use deep population: .populate({ path: 'posts', populate: { path: 'creator' } })

    await user.populate({ path: 'savedPosts', populate: { path: 'creator' } });

    // Fetch posts directly for robustness
    const posts = await Post.find({ creator: context.userId }).populate('creator').populate('likes').sort({ createdAt: -1 });

    return {
      ...user._doc,
      _id: user._id.toString(),
      savedPosts: user.savedPosts ? await Promise.all(
        user.savedPosts.filter(p => p && p._id).map(p => mapPostData(p))
      ) : [],
      posts: await Promise.all(posts.map(p => mapPostData(p)))
    };
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
    const user = await User.findById(userId)
      .select('-password')
      .populate({ path: 'savedPosts', populate: { path: 'creator' } })
      .populate({ path: 'posts', populate: { path: 'creator' } });

    if (!user) throw new Error('User not found!');

    // Fetch posts directly to ensure we get all posts by this creator (more robust than user.posts array)
    const posts = await Post.find({ creator: userId }).populate('creator').populate('likes').sort({ createdAt: -1 });

    return {
      ...user._doc,
      _id: user._id.toString(),
      savedPosts: user.savedPosts ? await Promise.all(
        user.savedPosts.filter(p => p && p._id).map(p => mapPostData(p))
      ) : [],
      posts: await Promise.all(posts.map(p => mapPostData(p)))
    };
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

    // Populate for return
    await createdPost.populate('creator');
    return await mapPostData(createdPost);
  },

  updatePost: async function ({ id, postInput }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const post = await Post.findById(id).populate('creator').populate('likes');
    if (!post) throw new Error('No post found!');

    if (!post.creator || post.creator._id.toString() !== context.userId.toString()) {
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
      if (post.imageUrl && !/^https?:\/\//i.test(post.imageUrl)) {
        try {
          clearImage(post.imageUrl);
        } catch (e) { console.error("Error clearing image:", e); }
      }
      post.imageUrl = postInput.imageUrl;
    }

    const updatedPost = await post.save();
    return await mapPostData(updatedPost);
  },

  deletePost: async function ({ id }, context) {
    console.log('Attempting to delete post:', id);
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
    const user = await User.findById(context.userId);
    user.posts.pull(id);
    await user.save();
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
      .populate('creator', 'name _id avatar')
      .populate('likes', 'name _id');

    const mappedPosts = await Promise.all(posts.map(p => mapPostData(p)));

    return {
      posts: mappedPosts,
      totalPosts
    };
  },

  post: async function ({ id }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const post = await Post.findById(id)
      .populate('creator', 'name _id avatar')
      .populate('likes', 'name _id');
    if (!post) throw new Error('No post found!');

    const mappedPost = await mapPostData(post);
    // Overwrite comments with nested version for single post view
    mappedPost.comments = await getNestedComments(id);
    mappedPost.commentsCount = mappedPost.comments.length;

    return mappedPost;
  },

  likeComment: async function ({ commentId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const comment = await Comment.findById(commentId);
    if (!comment) throw new Error('Comment not found!');

    // Check if user already liked
    if (!comment.likes.includes(context.userId)) {
      comment.likes.push(context.userId);
      await comment.save();
    }

    // Populate to satisfy [User!]! schema
    await comment.populate('likes', 'name _id');
    await comment.populate('creator', 'name _id avatar email');

    return {
      ...comment._doc,
      _id: comment._id.toString(),
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      likesCount: comment.likes.length,
      likes: comment.likes.map(u => ({ ...u._doc, _id: u._id.toString() })),
      creator: { ...comment.creator._doc, _id: comment.creator._id.toString() },
      replies: [] // Resolvers don't usually return deep nested recursive data unless asked, but schema demands [Comment!]!. Empty is fine for just "like".
    };
  },

  unlikeComment: async function ({ commentId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const comment = await Comment.findById(commentId);
    if (!comment) throw new Error('Comment not found!');

    comment.likes.pull(context.userId);
    await comment.save();

    await comment.populate('likes', 'name _id');
    await comment.populate('creator', 'name _id avatar email');

    return {
      ...comment._doc,
      _id: comment._id.toString(),
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      likesCount: comment.likes.length,
      likes: comment.likes.map(u => ({ ...u._doc, _id: u._id.toString() })),
      creator: { ...comment.creator._doc, _id: comment.creator._id.toString() },
      replies: []
    };
  },

  addReply: async function ({ postId, commentId, content }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    if (!content || !content.trim()) throw new Error('Reply cannot be empty!');

    const user = await User.findById(context.userId);
    if (!user) throw new Error('User not found!');

    // Check parent comment
    const parentComment = await Comment.findById(commentId);
    if (!parentComment) throw new Error('Parent comment not found!');

    const reply = new Comment({
      content: content.trim(),
      post: postId,
      parentId: commentId,
      creator: user._id,
      likes: []
    });

    await reply.save();
    await reply.populate('creator', 'name username email avatar');

    return {
      ...reply._doc,
      _id: reply._id.toString(),
      creator: { ...reply.creator._doc, _id: reply.creator._id.toString() },
      likes: [],
      likesCount: 0,
      replies: [],
      repliesCount: 0,
      createdAt: reply.createdAt.toISOString(),
      updatedAt: reply.updatedAt.toISOString()
    };
  },

  paginatedReplies: async function ({ commentId, page = 1, limit = 5 }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');

    const perPage = limit;
    const totalReplies = await Comment.countDocuments({ parentId: commentId });
    const replies = await Comment.find({ parentId: commentId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .populate('creator', 'name avatar _id')
      .populate('likes', 'name _id');

    return {
      replies: replies.map(r => ({
        ...r._doc,
        _id: r._id.toString(),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        likes: r.likes.map(l => ({ ...l._doc, _id: l._id.toString() })),
        likesCount: r.likes.length,
        creator: { ...r.creator._doc, _id: r.creator._id.toString() },
        replies: [], // Do we need recursively nested replies? Maybe just count? Schema says [Comment!]! so empty array satisfies strictly.
        repliesCount: 0 // We could fetch count if we want recursive depth > 1
      })),
      totalReplies,
      hasMore: (page * perPage) < totalReplies
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
      likes: [],
      likesCount: 0,
      replies: [],
      repliesCount: 0,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString()
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
    await comment.populate('likes');

    return {
      ...comment._doc,
      _id: comment._id.toString(),
      content: comment.content,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: (comment.updatedAt || comment.createdAt).toISOString(),
      creator: {
        _id: comment.creator._id.toString(),
        name: comment.creator.name,
        email: comment.creator.email,
        avatar: comment.creator.avatar || ''
      },
      parentId: comment.parentId ? comment.parentId.toString() : null,
      likes: (comment.likes || []).map(l => {
        if (l && l._id) {
          // Fully populated user object
          return {
            ...l._doc,
            _id: l._id.toString(),
            name: l.name || 'Unknown',
            email: l.email || '',
            status: l.status || 'active',
            role: l.role || 'user'
          };
        }
        // Fallback for unpopulated ID or partial object
        return {
          _id: l ? l.toString() : 'unknown',
          name: 'Unknown',
          email: '',
          status: 'active',
          role: 'user'
        };
      }),
      likesCount: comment.likes ? comment.likes.length : 0,
      replies: (comment.replies || []).map(r => ({ _id: r._id ? r._id.toString() : r.toString() })),
      repliesCount: comment.replies ? comment.replies.length : 0
    };
  },

  deleteComment: async function ({ commentId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const comment = await Comment.findById(commentId).populate('creator', 'name _id');
    if (!comment) throw new Error('Comment not found!');
    if (comment.creator._id.toString() !== context.userId.toString()) throw new Error('Not authorized!');

    // Helper to recursively finding all descendant IDs
    const getAllDescendantIds = async (parentId) => {
      const children = await Comment.find({ parentId });
      let ids = children.map(c => c._id);
      for (const child of children) {
        const descendantIds = await getAllDescendantIds(child._id);
        ids = [...ids, ...descendantIds];
      }
      return ids;
    };

    const descendantIds = await getAllDescendantIds(commentId);

    // Delete all descendants first
    if (descendantIds.length > 0) {
      await Comment.deleteMany({ _id: { $in: descendantIds } });
    }

    // Delete the target comment
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
      .populate('creator', 'name email avatar')
      .populate('likes', 'name _id');

    const comments = await Promise.all(topComments.map(async c => ({
      ...c._doc,
      _id: c._id.toString(),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt ? c.updatedAt.toISOString() : c.createdAt.toISOString(),
      likesCount: c.likes.length,
      likes: c.likes.map(u => ({ ...u._doc, _id: u._id.toString() })),
      creator: {
        _id: c.creator._id.toString(),
        name: c.creator.name,
        email: c.creator.email,
        avatar: c.creator.avatar
      },
      parentId: null,
      replies: await getRepliesRecursive(c._id),
      repliesCount: (await Comment.countDocuments({ parentId: c._id }))
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
      .populate('creator', 'name email avatar')
      .populate('likes', 'name _id');

    return {
      replies: await Promise.all(replies.map(async r => ({
        ...r._doc,
        _id: r._id.toString(),
        createdAt: r.createdAt.toISOString(),
        creator: {
          _id: r.creator._id.toString(),
          name: r.creator.name,
          email: r.creator.email,
          avatar: r.creator.avatar
        },
        parentId: r.parentId ? r.parentId.toString() : null,
        likesCount: r.likes ? r.likes.length : 0,
        likes: [],
        replies: [],
        repliesCount: (await Comment.countDocuments({ parentId: r._id }))
      }))),
      totalReplies,
      hasMore: skip + limit < totalReplies
    };
  },

  likePost: async function ({ postId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    // Populate likes so we can map them correctly
    const post = await Post.findById(postId).populate('creator', 'name _id').populate('likes');
    if (!post) throw new Error('Post not found!');

    const userId = context.userId.toString();
    if (!(post.likes || []).some(l => (l._id ? l._id.toString() : l.toString()) === userId)) {
      post.likes.push(userId);
      await post.save();
      // Re-populate after save to be safe
      await post.populate('likes');
    }

    return await mapPostData(post);
  },

  unlikePost: async function ({ postId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const post = await Post.findById(postId).populate('creator', 'name _id').populate('likes');
    if (!post) throw new Error('Post not found!');

    const userId = context.userId.toString();
    post.likes = (post.likes || []).filter(like => (like._id ? like._id.toString() : like.toString()) !== userId);
    await post.save();

    return await mapPostData(post);
  },

  savePost: async function ({ postId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const user = await User.findById(context.userId);
    if (!user) throw new Error('User not found!');

    // Check if post exists
    const post = await Post.findById(postId);
    if (!post) throw new Error('Post not found!');

    if (!user.savedPosts.includes(postId)) {
      user.savedPosts.push(postId);
      await user.save();
    }

    // Populate for return
    await user.populate({ path: 'savedPosts', populate: { path: 'creator' } });
    await user.populate({ path: 'savedPosts', populate: { path: 'likes' } });

    // Check own posts
    const posts = await Post.find({ creator: context.userId }).populate('creator').populate('likes').sort({ createdAt: -1 });

    const validSavedPosts = user.savedPosts.filter(p => p && p._id);

    return {
      ...user._doc,
      _id: user._id.toString(),
      savedPosts: await Promise.all(validSavedPosts.map(p => mapPostData(p))),
      posts: await Promise.all(posts.map(p => mapPostData(p)))
    };
  },

  unsavePost: async function ({ postId }, context) {
    if (!context?.isAuth) throw new Error('Not authenticated!');
    const user = await User.findById(context.userId).populate('savedPosts');
    if (!user) throw new Error('User not found!');

    user.savedPosts.pull(postId);
    await user.save();

    // Populate for return consistency
    await user.populate({ path: 'savedPosts', populate: { path: 'creator' } });
    await user.populate({ path: 'savedPosts', populate: { path: 'likes' } });

    // Fetch own posts as well to return a full User object similar to user/userById
    const posts = await Post.find({ creator: context.userId }).populate('creator').populate('likes').sort({ createdAt: -1 });

    const validSavedPosts = user.savedPosts.filter(p => p && p._id);

    return {
      ...user._doc,
      _id: user._id.toString(),
      savedPosts: await Promise.all(validSavedPosts.map(p => mapPostData(p))),
      posts: await Promise.all(posts.map(p => mapPostData(p)))
    };
  }
};
