const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const os = require('os');

const User = require('../models/User');
const Link = require('../models/Link');
const Collection = require('../models/Collection');
const Session = require('../models/Session');
const ApiKey = require('../models/ApiKey');
const Visit = require('../models/Visit');
const SavedView = require('../models/SavedView');
const Challenge = require('../models/Challenge');

const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const { invalidateTokenVersion } = require('../utils/helpers');
const { getMasterEmail } = require('../utils/initMaster');

const router = express.Router();

// All routes require standard token authentication AND admin privileges
router.use(auth);
router.use(adminAuth);

/**
 * Helper: prevent any operation that mutates or deletes the Master Admin
 */
function isMasterUser(user) {
  if (!user) return false;
  if (user.isMaster) return true;
  if (String(user.email).toLowerCase().trim() === getMasterEmail()) return true;
  return false;
}

// ============================================================================
// 1. SYSTEM OVERVIEW & METRICS
// ============================================================================
router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    // Parallel aggregate queries for ultra-fast performance
    const [
      userCounts,
      linkCounts,
      collectionStats,
      sessionStats,
      apiKeyCount,
      recentUsers,
      recentLinks,
      growthUsers,
      growthLinks,
      topDomains,
    ] = await Promise.all([
      // User counts and segmentation
      User.aggregate([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            activeUsers: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            suspendedUsers: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } },
            adminUsers: { $sum: { $cond: [{ $eq: ['$role', 'admin'] }, 1, 0] } },
            twoFactorUsers: { $sum: { $cond: [{ $eq: ['$totp.enabled', true] }, 1, 0] } },
            newUsers24h: { $sum: { $cond: [{ $gte: ['$createdAt', oneDayAgo] }, 1, 0] } },
            newUsers7d: { $sum: { $cond: [{ $gte: ['$createdAt', sevenDaysAgo] }, 1, 0] } },
            newUsers30d: { $sum: { $cond: [{ $gte: ['$createdAt', thirtyDaysAgo] }, 1, 0] } },
          },
        },
      ]),

      // Link counts & total platform visits
      Link.aggregate([
        {
          $group: {
            _id: null,
            totalLinks: { $sum: 1 },
            activeLinks: { $sum: { $cond: [{ $eq: ['$deletedAt', null] }, 1, 0] } },
            archivedLinks: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$deletedAt', null] }, { $eq: ['$archived', true] }] },
                  1,
                  0,
                ],
              },
            },
            trashLinks: { $sum: { $cond: [{ $ne: ['$deletedAt', null] }, 1, 0] } },
            favoriteLinks: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$deletedAt', null] }, { $eq: ['$favorite', true] }] },
                  1,
                  0,
                ],
              },
            },
            totalVisits: { $sum: { $ifNull: ['$visits', 0] } },
            newLinks7d: { $sum: { $cond: [{ $gte: ['$createdAt', sevenDaysAgo] }, 1, 0] } },
          },
        },
      ]),

      // Collections
      Collection.aggregate([
        {
          $group: {
            _id: null,
            totalCollections: { $sum: 1 },
            sharedCollections: { $sum: { $cond: [{ $eq: ['$isShared', true] }, 1, 0] } },
          },
        },
      ]),

      // Sessions
      Session.aggregate([
        {
          $group: {
            _id: null,
            totalSessions: { $sum: 1 },
            activeSessions: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$revokedAt', null] },
                      { $gte: ['$expiresAt', now] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      // API keys
      ApiKey.countDocuments({ revokedAt: null }),

      // 5 most recent users
      User.find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .select('_id name email role isMaster status createdAt avatarColor lastLoginAt loginCount'),

      // 10 most recent links with user information
      Link.find({ deletedAt: null })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('user', 'name email avatarColor')
        .select('_id title url visits tags createdAt user color healthStatus'),

      // Daily user signups for past 14 days
      User.aggregate([
        { $match: { createdAt: { $gte: fourteenDaysAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Daily link creations for past 14 days
      Link.aggregate([
        { $match: { createdAt: { $gte: fourteenDaysAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Top 8 domains saved across the platform
      Link.aggregate([
        { $match: { deletedAt: null } },
        {
          $project: {
            domain: {
              $arrayElemAt: [
                {
                  $split: [
                    {
                      $arrayElemAt: [
                        {
                          $split: [
                            {
                              $replaceAll: {
                                input: {
                                  $replaceAll: { input: '$url', find: 'https://', replacement: '' },
                                },
                                find: 'http://',
                                replacement: '',
                              },
                            },
                            '/',
                          ],
                        },
                        0,
                      ],
                    },
                    ':',
                  ],
                },
                0,
              ],
            },
          },
        },
        { $group: { _id: '$domain', count: { $sum: 1 } } },
        { $match: { _id: { $ne: '' } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
    ]);

    const u = userCounts[0] || {};
    const l = linkCounts[0] || {};
    const c = collectionStats[0] || {};
    const s = sessionStats[0] || {};

    const mem = process.memoryUsage();

    res.json({
      metrics: {
        totalUsers: u.totalUsers || 0,
        activeUsers: u.activeUsers || 0,
        suspendedUsers: u.suspendedUsers || 0,
        adminUsers: u.adminUsers || 0,
        twoFactorUsers: u.twoFactorUsers || 0,
        newUsers24h: u.newUsers24h || 0,
        newUsers7d: u.newUsers7d || 0,
        newUsers30d: u.newUsers30d || 0,

        totalLinks: l.totalLinks || 0,
        activeLinks: l.activeLinks || 0,
        archivedLinks: l.archivedLinks || 0,
        trashLinks: l.trashLinks || 0,
        favoriteLinks: l.favoriteLinks || 0,
        totalVisits: l.totalVisits || 0,
        newLinks7d: l.newLinks7d || 0,

        totalCollections: c.totalCollections || 0,
        sharedCollections: c.sharedCollections || 0,

        totalSessions: s.totalSessions || 0,
        activeSessions: s.activeSessions || 0,
        totalApiKeys: apiKeyCount || 0,
      },
      growth: {
        users: growthUsers,
        links: growthLinks,
      },
      topDomains: topDomains.map((d) => ({ domain: d._id, count: d.count })),
      recentUsers,
      recentLinks,
      system: {
        nodeVersion: process.version,
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        uptime: Math.floor(process.uptime()),
        memoryRssMb: Math.round(mem.rss / 1024 / 1024),
        memoryHeapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        mongoState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        env: process.env.NODE_ENV || 'development',
      },
    });
  } catch (err) {
    console.error('[admin/overview] error:', err);
    res.status(500).json({ error: 'Failed to load system overview.' });
  }
});

// ============================================================================
// 1.1 REAL-TIME ACTIVITY STREAM
// ============================================================================
router.get('/activity', async (req, res) => {
  try {
    const [recentUsers, recentLinks, recentSessions] = await Promise.all([
      User.find({})
        .sort({ createdAt: -1 })
        .limit(10)
        .select('_id name email createdAt avatarColor status role isMaster')
        .lean(),
      Link.find({ deletedAt: null })
        .sort({ createdAt: -1 })
        .limit(12)
        .populate('user', 'name email avatarColor')
        .select('_id title url visits createdAt user color')
        .lean(),
      Session.find({ revokedAt: null })
        .sort({ lastUsedAt: -1 })
        .limit(10)
        .populate('user', 'name email avatarColor')
        .select('_id user device ip lastUsedAt createdAt')
        .lean(),
    ]);

    const events = [];

    (recentUsers || []).forEach((u) => {
      events.push({
        id: `user-${u._id}`,
        type: 'user_registered',
        category: 'user',
        title: `${u.name} joined Linkarium`,
        subtitle: u.email,
        timestamp: u.createdAt,
        color: '#3b82f6',
        badge: u.isMaster ? '👑 Master' : u.role === 'admin' ? '🛡️ Admin' : '👤 User',
      });
    });

    (recentLinks || []).forEach((l) => {
      events.push({
        id: `link-${l._id}`,
        type: 'link_saved',
        category: 'link',
        title: l.title || l.url,
        subtitle: l.url,
        user: l.user ? { name: l.user.name, email: l.user.email, avatarColor: l.user.avatarColor } : null,
        timestamp: l.createdAt,
        color: l.color || '#10b981',
        badge: `${l.visits || 0} clicks`,
      });
    });

    (recentSessions || []).forEach((s) => {
      events.push({
        id: `session-${s._id}`,
        type: 'session_active',
        category: 'session',
        title: `${s.user?.name || 'Active User'} session`,
        subtitle: `${s.device?.browser || 'Browser'} on ${s.device?.os || 'OS'} • ${s.ip || 'Unknown IP'}`,
        user: s.user ? { name: s.user.name, email: s.user.email, avatarColor: s.user.avatarColor } : null,
        timestamp: s.lastUsedAt || s.createdAt,
        color: '#06b6d4',
        badge: '🟢 Online',
      });
    });

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      events: events.slice(0, 25),
    });
  } catch (err) {
    console.error('[admin/activity] error:', err);
    res.status(500).json({ error: 'Failed to retrieve activity stream.' });
  }
});

// ============================================================================
// 2. USERS MANAGEMENT & DEEP TRACKING (LIST & SEARCH)
// ============================================================================
router.get('/users', async (req, res) => {
  try {
    const {
      search = '',
      role = 'all',
      status = 'all',
      twoFactor = 'all',
      sort = 'newest',
      page = 1,
      limit = 50,
    } = req.query;

    const conditions = [];
    const searchTerm = String(search || '').trim();

    if (searchTerm) {
      const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchOr = [
        { name: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
      // The UI advertises searching by user ID, so honour a full 24-char ObjectId.
      if (/^[0-9a-fA-F]{24}$/.test(searchTerm)) {
        searchOr.push({ _id: new mongoose.Types.ObjectId(searchTerm) });
      }
      conditions.push({ $or: searchOr });
    }

    if (role !== 'all') {
      conditions.push({ role });
    }

    if (status !== 'all') {
      conditions.push({ status });
    }

    if (twoFactor === 'enabled') {
      conditions.push({ 'totp.enabled': true });
    } else if (twoFactor === 'disabled') {
      conditions.push({
        $or: [{ 'totp.enabled': false }, { 'totp.enabled': { $exists: false } }],
      });
    }

    const matchQuery = conditions.length > 0 ? { $and: conditions } : {};

    const sortStage = {};
    if (sort === 'oldest') sortStage.createdAt = 1;
    else if (sort === 'name_asc') sortStage.name = 1;
    else if (sort === 'links_desc') sortStage.totalLinks = -1;
    else if (sort === 'visits_desc') sortStage.totalVisits = -1;
    else if (sort === 'last_login') sortStage.lastLoginAt = -1;
    else sortStage.createdAt = -1; // default newest

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skipNum = (pageNum - 1) * limitNum;

    // Aggregation pipeline to join user metrics in one shot
    const [result] = await User.aggregate([
      { $match: matchQuery },
      {
        $facet: {
          totalCount: [{ $count: 'count' }],
          users: [
            // Look up link counts and total visits
            {
              $lookup: {
                from: 'links',
                localField: '_id',
                foreignField: 'user',
                as: 'userLinks',
                pipeline: [
                  {
                    $project: {
                      deletedAt: 1,
                      archived: 1,
                      visits: 1,
                    },
                  },
                ],
              },
            },
            // Look up collection count
            {
              $lookup: {
                from: 'collections',
                localField: '_id',
                foreignField: 'user',
                as: 'userCollections',
                pipeline: [{ $project: { _id: 1 } }],
              },
            },
            // Look up active sessions count
            {
              $lookup: {
                from: 'sessions',
                localField: '_id',
                foreignField: 'user',
                as: 'userSessions',
                pipeline: [
                  {
                    $match: {
                      revokedAt: null,
                      expiresAt: { $gte: new Date() },
                    },
                  },
                  { $project: { _id: 1, ip: 1, device: 1, lastUsedAt: 1 } },
                ],
              },
            },
            // Look up API keys count
            {
              $lookup: {
                from: 'apikeys',
                localField: '_id',
                foreignField: 'user',
                as: 'userApiKeys',
                pipeline: [{ $match: { revokedAt: null } }, { $project: { _id: 1 } }],
              },
            },
            // Calculate computed metrics
            {
              $addFields: {
                totalLinks: { $size: '$userLinks' },
                activeLinks: {
                  $size: {
                    $filter: {
                      input: '$userLinks',
                      as: 'l',
                      cond: { $eq: ['$$l.deletedAt', null] },
                    },
                  },
                },
                archivedLinks: {
                  $size: {
                    $filter: {
                      input: '$userLinks',
                      as: 'l',
                      cond: {
                        $and: [
                          { $eq: ['$$l.deletedAt', null] },
                          { $eq: ['$$l.archived', true] },
                        ],
                      },
                    },
                  },
                },
                trashLinks: {
                  $size: {
                    $filter: {
                      input: '$userLinks',
                      as: 'l',
                      cond: { $ne: ['$$l.deletedAt', null] },
                    },
                  },
                },
                totalVisits: { $sum: '$userLinks.visits' },
                collectionsCount: { $size: '$userCollections' },
                activeSessionsCount: { $size: '$userSessions' },
                apiKeysCount: { $size: '$userApiKeys' },
                twoFactorEnabled: { $ifNull: ['$totp.enabled', false] },
              },
            },
            {
              $project: {
                password: 0,
                'totp.secret': 0,
                recoveryCodes: 0,
                userLinks: 0,
                userCollections: 0,
                userSessions: 0,
                userApiKeys: 0,
              },
            },
            { $sort: sortStage },
            { $skip: skipNum },
            { $limit: limitNum },
          ],
        },
      },
    ]);

    const total = result?.totalCount?.[0]?.count || 0;
    const users = result?.users || [];

    res.json({
      users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error('[admin/users] error:', err);
    res.status(500).json({ error: 'Failed to retrieve users.' });
  }
});

// ============================================================================
// 3. DEEP USER DETAILS (EVERY DETAIL MENTIONED & TRACKABLE)
// ============================================================================
router.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid user ID.' });
    }

    const user = await User.findById(id).select(
      '+tokenVersion +totp.verifiedAt +preferences'
    );
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Parallel fetch all related resources
    const [
      linkStats,
      collections,
      sessions,
      apiKeys,
      recentLinks,
      visitCount,
      savedViewsCount,
    ] = await Promise.all([
      Link.aggregate([
        { $match: { user: user._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$deletedAt', null] }, 1, 0] } },
            archived: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$deletedAt', null] }, { $eq: ['$archived', true] }] },
                  1,
                  0,
                ],
              },
            },
            trash: { $sum: { $cond: [{ $ne: ['$deletedAt', null] }, 1, 0] } },
            favorites: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$deletedAt', null] }, { $eq: ['$favorite', true] }] },
                  1,
                  0,
                ],
              },
            },
            totalVisits: { $sum: { $ifNull: ['$visits', 0] } },
          },
        },
      ]),

      Collection.find({ user: user._id })
        .sort({ createdAt: -1 })
        .select('_id name color icon isShared shareSlug createdAt'),

      Session.find({ user: user._id })
        .sort({ lastUsedAt: -1 })
        .select('_id jti userAgent ip device lastUsedAt expiresAt revokedAt createdAt'),

      ApiKey.find({ user: user._id })
        .sort({ createdAt: -1 })
        .select('_id name prefix scopes lastUsedAt expiresAt revokedAt createdAt'),

      Link.find({ user: user._id, deletedAt: null })
        .sort({ createdAt: -1 })
        .limit(25)
        .populate('collectionId', 'name color icon')
        .select('_id title url description tags visits favorite color createdAt healthStatus collectionId'),

      Visit.countDocuments({ user: user._id }),
      SavedView.countDocuments({ user: user._id }),
    ]);

    const stats = linkStats[0] || {
      total: 0,
      active: 0,
      archived: 0,
      trash: 0,
      favorites: 0,
      totalVisits: 0,
    };

    res.json({
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        isMaster: Boolean(user.isMaster),
        status: user.status || 'active',
        avatarColor: user.avatarColor,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        tokenVersion: user.tokenVersion || 0,
        lastLoginAt: user.lastLoginAt,
        lastLoginIp: user.lastLoginIp,
        loginCount: user.loginCount || 0,
        twoFactor: {
          enabled: Boolean(user.totp?.enabled),
          verifiedAt: user.totp?.verifiedAt,
        },
        preferences: user.preferences || {},
      },
      stats: {
        links: stats,
        collectionsCount: collections.length,
        sessionsCount: sessions.length,
        activeSessionsCount: sessions.filter((s) => !s.revokedAt && new Date(s.expiresAt) >= new Date()).length,
        apiKeysCount: apiKeys.length,
        totalVisitsLogged: visitCount,
        savedViewsCount,
      },
      collections,
      sessions,
      apiKeys,
      recentLinks,
    });
  } catch (err) {
    console.error('[admin/user/:id] error:', err);
    res.status(500).json({ error: 'Failed to retrieve user details.' });
  }
});

// ============================================================================
// 4. USER'S SPECIFIC LINKS LIST (PAGINATED & SEARCHABLE)
// ============================================================================
router.get('/users/:id/links', async (req, res) => {
  try {
    const { id } = req.params;
    const { search = '', filter = 'all', page = 1, limit = 50 } = req.query;

    const query = { user: new mongoose.Types.ObjectId(id) };

    if (filter === 'active') {
      query.deletedAt = null;
      query.archived = false;
    } else if (filter === 'archived') {
      query.deletedAt = null;
      query.archived = true;
    } else if (filter === 'trash') {
      query.deletedAt = { $ne: null };
    } else if (filter === 'favorites') {
      query.deletedAt = null;
      query.favorite = true;
    }

    if (search.trim()) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { title: { $regex: escaped, $options: 'i' } },
        { url: { $regex: escaped, $options: 'i' } },
        { tags: { $in: [new RegExp(escaped, 'i')] } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

    const [links, total] = await Promise.all([
      Link.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate('collectionId', 'name color icon'),
      Link.countDocuments(query),
    ]);

    res.json({
      links,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error('[admin/users/:id/links] error:', err);
    res.status(500).json({ error: 'Failed to load user links.' });
  }
});

// ============================================================================
// 5. UPDATE USER STATUS (ACTIVE / SUSPENDED)
// ============================================================================
router.patch('/users/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Status must be active or suspended.' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (String(req.adminUser._id) === String(user._id)) {
      return res.status(403).json({ error: 'You cannot change the status of your own account.' });
    }

    if (isMasterUser(user)) {
      return res.status(403).json({ error: 'Cannot suspend the Master Admin account.' });
    }

    user.status = status;

    // If suspended, immediately revoke outstanding access
    if (status === 'suspended') {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      await Session.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
      invalidateTokenVersion(user._id);
    }

    await user.save();

    res.json({
      success: true,
      message: `User status changed to ${status}.`,
      status: user.status,
    });
  } catch (err) {
    console.error('[admin/status] error:', err);
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});

// ============================================================================
// 6. UPDATE USER ROLE (USER / ADMIN)
// ============================================================================
router.patch('/users/:id/role', async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Role must be user or admin.' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (String(req.adminUser._id) === String(user._id)) {
      return res.status(403).json({ error: 'You cannot change your own role.' });
    }

    if (isMasterUser(user) && role !== 'admin') {
      return res.status(403).json({ error: 'Cannot demote the Master Admin account.' });
    }

    if (user.role === 'admin' && !req.adminUser.isMaster && role !== 'admin') {
      return res.status(403).json({ error: 'Only the Master Administrator can demote an administrator account.' });
    }

    user.role = role;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    invalidateTokenVersion(user._id);

    res.json({
      success: true,
      message: `User role changed to ${role}.`,
      role: user.role,
    });
  } catch (err) {
    console.error('[admin/role] error:', err);
    res.status(500).json({ error: 'Failed to update user role.' });
  }
});

// ============================================================================
// 7. FORCE LOGOUT / TERMINATE SESSIONS
// ============================================================================
router.post('/users/:id/reset-sessions', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (String(req.adminUser._id) === String(user._id)) {
      return res.status(403).json({ error: 'You cannot revoke your own active session from here. Use the Sign Out button.' });
    }

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    invalidateTokenVersion(user._id);

    await Session.updateMany(
      { user: user._id, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    res.json({
      success: true,
      message: `All active sessions revoked for ${user.email}.`,
    });
  } catch (err) {
    console.error('[admin/reset-sessions] error:', err);
    res.status(500).json({ error: 'Failed to terminate sessions.' });
  }
});

// ============================================================================
// 8. RESET USER PASSWORD
// ============================================================================
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (isMasterUser(user)) {
      return res.status(403).json({
        error: 'The Master Admin password is managed via server environment configuration (MASTER_ADMIN_PASSWORD).',
      });
    }

    if (user.role === 'admin' && !req.adminUser.isMaster && String(user._id) !== String(req.adminUser._id)) {
      return res.status(403).json({
        error: 'Only the Master Administrator can reset the password of another administrator.',
      });
    }

    user.password = await bcrypt.hash(String(newPassword), 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    invalidateTokenVersion(user._id);

    await Session.updateMany(
      { user: user._id, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    res.json({
      success: true,
      message: `Password successfully updated for ${user.email}. All sessions revoked.`,
    });
  } catch (err) {
    console.error('[admin/reset-password] error:', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ============================================================================
// 9. DELETE USER & CASCADE DATA
// ============================================================================
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (String(req.adminUser._id) === String(user._id)) {
      return res.status(403).json({ error: 'You cannot delete your own account.' });
    }

    if (isMasterUser(user)) {
      return res.status(403).json({ error: 'The Master Admin account cannot be deleted.' });
    }

    if (user.role === 'admin' && !req.adminUser.isMaster) {
      return res.status(403).json({ error: 'Only the Master Administrator can delete an administrator account.' });
    }

    // Cascade delete all associated entities
    await Promise.all([
      User.deleteOne({ _id: user._id }),
      Link.deleteMany({ user: user._id }),
      Collection.deleteMany({ user: user._id }),
      Visit.deleteMany({ user: user._id }),
      Session.deleteMany({ user: user._id }),
      ApiKey.deleteMany({ user: user._id }),
      SavedView.deleteMany({ user: user._id }),
      Challenge.deleteMany({ user: user._id }),
    ]);

    invalidateTokenVersion(user._id);

    res.json({
      success: true,
      message: `User ${user.email} and all associated data permanently deleted.`,
    });
  } catch (err) {
    console.error('[admin/delete-user] error:', err);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// ============================================================================
// 10. GLOBAL LINKS EXPLORER (ACROSS ALL USERS)
// ============================================================================
router.get('/links', async (req, res) => {
  try {
    const { search = '', domain = '', page = 1, limit = 50 } = req.query;

    const query = { deletedAt: null };

    if (search.trim()) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { title: { $regex: escaped, $options: 'i' } },
        { url: { $regex: escaped, $options: 'i' } },
        { tags: { $in: [new RegExp(escaped, 'i')] } },
      ];
    }

    if (domain.trim()) {
      const escaped = domain.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.url = { $regex: escaped, $options: 'i' };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

    const [links, total] = await Promise.all([
      Link.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate('user', 'name email avatarColor')
        .populate('collectionId', 'name color icon')
        .select('_id title url visits tags createdAt color healthStatus user collectionId archived'),
      Link.countDocuments(query),
    ]);

    res.json({
      links,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error('[admin/links] error:', err);
    res.status(500).json({ error: 'Failed to load global links.' });
  }
});

// ============================================================================
// 11. DELETE LINK BY ADMIN
// ============================================================================
router.delete('/links/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const link = await Link.findById(id);
    if (!link) {
      return res.status(404).json({ error: 'Link not found.' });
    }

    await Link.deleteOne({ _id: link._id });
    await Visit.deleteMany({ link: link._id });

    res.json({ success: true, message: 'Link permanently deleted.' });
  } catch (err) {
    console.error('[admin/delete-link] error:', err);
    res.status(500).json({ error: 'Failed to delete link.' });
  }
});

// ============================================================================
// 12. GLOBAL SESSIONS & AUDIT RADAR
// ============================================================================
router.get('/sessions', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

    const [sessions, total] = await Promise.all([
      Session.find({ revokedAt: null, expiresAt: { $gte: new Date() } })
        .sort({ lastUsedAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate('user', 'name email avatarColor role isMaster')
        .select('_id user userAgent ip device lastUsedAt expiresAt createdAt'),
      Session.countDocuments({ revokedAt: null, expiresAt: { $gte: new Date() } }),
    ]);

    res.json({
      sessions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error('[admin/sessions] error:', err);
    res.status(500).json({ error: 'Failed to load sessions.' });
  }
});

router.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await Session.findByIdAndUpdate(id, { $set: { revokedAt: new Date() } });
    res.json({ success: true, message: 'Session revoked.' });
  } catch (err) {
    console.error('[admin/revoke-session] error:', err);
    res.status(500).json({ error: 'Failed to revoke session.' });
  }
});

// ============================================================================
// 13. EXPORT AUDIT REPORT (JSON)
// ============================================================================
router.get('/export', async (req, res) => {
  try {
    const users = await User.find({})
      .select('-password -totp.secret -recoveryCodes')
      .lean();

    const summary = {
      exportedAt: new Date(),
      masterAdmin: req.adminUser.email,
      totalUsers: users.length,
      users,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="linkarium-audit-${Date.now()}.json"`
    );
    res.send(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error('[admin/export] error:', err);
    res.status(500).json({ error: 'Failed to export audit report.' });
  }
});

// ============================================================================
// 14. COMPLETE DATABASE INTELLIGENCE & ATLAS VAULT
// ============================================================================
const COLLECTION_DESCRIPTIONS = {
  users: 'Authentication credentials, profile metadata, TOTP secrets, user preferences & login logs',
  links: 'Saved bookmarks, canonical URLs, visit counts, tags, favicon cards & article data',
  collections: 'User folders, color themes, icon descriptors & public share slugs',
  sessions: 'Active and historical device sessions, IP addresses, browser agents & refresh tokens',
  visits: 'Individual link visit timestamps, click logs, and engagement events',
  savedviews: 'Saved smart filters, automated triage rules, and custom views',
  ratelimits: 'Distributed rate limiting buckets, window tracking and request counters',
  locks: 'Distributed mutual exclusion leases for background workers & schedulers',
  apikeys: 'Personal developer access tokens, hashed keys, prefixes and scope grants',
  challenges: 'Temporary two-factor authentication (TOTP) login challenge tokens',
};

// GET /api/admin/database/overview — Full MongoDB Atlas engine & collection telemetry
router.get('/database/overview', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      return res.status(503).json({ error: 'Database connection is not available.' });
    }

    const startPing = Date.now();
    await db.command({ ping: 1 });
    const pingMs = Date.now() - startPing;

    const [dbStats, rawCols] = await Promise.all([
      db.stats(),
      db.listCollections().toArray(),
    ]);

    // Inspect each collection in parallel
    const collections = await Promise.all(
      rawCols.map(async (c) => {
        const colName = c.name;
        let count = 0;
        let sizeBytes = 0;
        let storageSizeBytes = 0;
        let totalIndexSizeBytes = 0;
        let avgObjSizeBytes = 0;
        let indexes = [];

        try {
          const stats = await db.command({ collStats: colName });
          count = stats.count || 0;
          sizeBytes = stats.size || 0;
          storageSizeBytes = stats.storageSize || 0;
          totalIndexSizeBytes = stats.totalIndexSize || 0;
          avgObjSizeBytes = Math.round(stats.avgObjSize || 0);
          indexes = (stats.indexDetails ? Object.keys(stats.indexDetails) : []) || [];
        } catch {
          count = await db.collection(colName).countDocuments();
        }

        try {
          const rawIndexes = await db.collection(colName).indexes();
          indexes = rawIndexes.map((idx) => ({
            name: idx.name,
            keys: idx.key,
            unique: Boolean(idx.unique),
          }));
        } catch {
          // ignore
        }

        return {
          name: colName,
          count,
          sizeBytes,
          storageSizeBytes,
          totalIndexSizeBytes,
          avgObjSizeBytes,
          indexesCount: indexes.length,
          indexes,
          description: COLLECTION_DESCRIPTIONS[colName] || 'System data collection',
        };
      })
    );

    // Sort collections by count descending
    collections.sort((a, b) => b.count - a.count);

    // Masked host information
    const rawUri = process.env.MONGODB_URI || '';
    const hostMatch = rawUri.match(/@([^/?]+)/);
    const host = hostMatch ? hostMatch[1] : 'MongoDB Atlas Cluster';

    res.json({
      database: {
        name: db.databaseName,
        host,
        pingMs,
        state: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        totalCollections: dbStats.collections,
        totalObjects: dbStats.objects,
        avgObjSizeBytes: Math.round(dbStats.avgObjSize || 0),
        dataSizeBytes: dbStats.dataSize,
        dataSizeMb: (dbStats.dataSize / 1024 / 1024).toFixed(2),
        storageSizeBytes: dbStats.storageSize,
        storageSizeMb: (dbStats.storageSize / 1024 / 1024).toFixed(2),
        indexesCount: dbStats.indexes,
        indexSizeBytes: dbStats.indexSize,
        indexSizeMb: (dbStats.indexSize / 1024 / 1024).toFixed(2),
        totalSizeBytes: dbStats.storageSize + dbStats.indexSize,
        totalSizeMb: ((dbStats.storageSize + dbStats.indexSize) / 1024 / 1024).toFixed(2),
      },
      collections,
    });
  } catch (err) {
    console.error('[admin/database/overview] error:', err);
    res.status(500).json({ error: 'Failed to retrieve database statistics.' });
  }
});

// GET /api/admin/database/collection/:name — Live query & document browser
router.get('/database/collection/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { page = 1, limit = 25, search = '' } = req.query;

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(503).json({ error: 'Database connection is not available.' });
    }

    // Security check: exclude system collections
    if (name.startsWith('system.') || name.startsWith('local.')) {
      return res.status(403).json({ error: 'Access to system collections is restricted.' });
    }

    // Security check: ensure collection exists in db
    const rawCols = await db.listCollections({ name }).toArray();
    if (rawCols.length === 0) {
      return res.status(404).json({ error: `Collection "${name}" does not exist in database.` });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skipNum = (pageNum - 1) * limitNum;

    const query = {};
    if (search.trim()) {
      const q = search.trim();
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Try searching ObjectId or string regex
      if (/^[0-9a-fA-F]{24}$/.test(q)) {
        query._id = new mongoose.Types.ObjectId(q);
      } else {
        // Broad search across common fields
        query.$or = [
          { name: { $regex: escaped, $options: 'i' } },
          { email: { $regex: escaped, $options: 'i' } },
          { title: { $regex: escaped, $options: 'i' } },
          { url: { $regex: escaped, $options: 'i' } },
          { ip: { $regex: escaped, $options: 'i' } },
          { key: { $regex: escaped, $options: 'i' } },
        ];
      }
    }

    const col = db.collection(name);
    let documents = [];
    let total = 0;

    try {
      [documents, total] = await Promise.all([
        col.find(query).sort({ _id: -1 }).skip(skipNum).limit(limitNum).toArray(),
        col.countDocuments(query),
      ]);
    } catch {
      // Fallback if regex on $or is invalid for this schema
      [documents, total] = await Promise.all([
        col.find({}).sort({ _id: -1 }).skip(skipNum).limit(limitNum).toArray(),
        col.countDocuments({}),
      ]);
    }

    // Redact sensitive credentials for the users collection
    if (name === 'users') {
      documents = documents.map((doc) => {
        const sanitized = { ...doc };
        if (sanitized.password) sanitized.password = '[REDACTED_PASSWORD_HASH]';
        if (sanitized.totp && sanitized.totp.secret) {
          sanitized.totp = { ...sanitized.totp, secret: '[REDACTED_TOTP_SECRET]' };
        }
        if (sanitized.recoveryCodes) {
          sanitized.recoveryCodes = ['[REDACTED]'];
        }
        return sanitized;
      });
    }

    // Extract all unique field keys across returned documents for dynamic table headers
    const keysSet = new Set(['_id']);
    documents.forEach((doc) => {
      Object.keys(doc).forEach((k) => keysSet.add(k));
    });
    const schemaKeys = Array.from(keysSet);

    res.json({
      collection: name,
      total,
      schemaKeys,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
      documents,
    });
  } catch (err) {
    console.error('[admin/database/collection] error:', err);
    res.status(500).json({ error: 'Failed to query collection.' });
  }
});

// GET /api/admin/database/dump — Complete database dump (All collections & documents)
router.get('/database/dump', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      return res.status(503).json({ error: 'Database connection is not available.' });
    }

    const rawCols = await db.listCollections().toArray();
    const dump = {
      database: db.databaseName,
      exportedAt: new Date().toISOString(),
      masterAdmin: req.adminUser.email,
      totalCollections: rawCols.length,
      collections: {},
    };

    let totalDocs = 0;
    for (const c of rawCols) {
      if (c.name.startsWith('system.') || c.name.startsWith('local.')) continue;
      let docs = await db.collection(c.name).find({}).toArray();
      if (c.name === 'users') {
        docs = docs.map((doc) => {
          const sanitized = { ...doc };
          if (sanitized.password) sanitized.password = '[REDACTED_PASSWORD_HASH]';
          if (sanitized.totp && sanitized.totp.secret) {
            sanitized.totp = { ...sanitized.totp, secret: '[REDACTED_TOTP_SECRET]' };
          }
          if (sanitized.recoveryCodes) {
            sanitized.recoveryCodes = ['[REDACTED]'];
          }
          return sanitized;
        });
      }
      dump.collections[c.name] = docs;
      totalDocs += docs.length;
    }
    dump.totalDocuments = totalDocs;

    const filename = `linkarium-full-database-dump-${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(dump, null, 2));
  } catch (err) {
    console.error('[admin/database/dump] error:', err);
    res.status(500).json({ error: 'Failed to generate database dump.' });
  }
});

// GET /api/admin/activity — Live platform activity stream (Signups, Saves, Sessions)
router.get('/activity', async (req, res) => {
  try {
    const [recentUsers, recentLinks, recentSessions] = await Promise.all([
      User.find({}, 'name email role createdAt isMaster avatarColor')
        .sort({ createdAt: -1 })
        .limit(12)
        .lean(),
      Link.find({ isTrash: false }, 'title url domain createdAt user')
        .populate('user', 'name email avatarColor')
        .sort({ createdAt: -1 })
        .limit(15)
        .lean(),
      Session.find({}, 'ipAddress userAgent createdAt lastUsedAt user')
        .populate('user', 'name email avatarColor')
        .sort({ lastUsedAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const events = [];

    // Map user creations
    (recentUsers || []).forEach((u) => {
      events.push({
        id: `user-${u._id}`,
        type: 'user_signup',
        title: 'New User Registered',
        description: `${u.name || 'User'} (${u.email}) joined Linkarium`,
        timestamp: u.createdAt,
        user: {
          name: u.name,
          email: u.email,
          avatarColor: u.avatarColor || '#f59e0b',
        },
        badgeColor: 'orange',
        badgeText: u.role === 'admin' ? 'ADMIN' : 'MEMBER',
      });
    });

    // Map link saves
    (recentLinks || []).forEach((l) => {
      events.push({
        id: `link-${l._id}`,
        type: 'link_created',
        title: 'Bookmark Saved',
        description: `"${l.title || 'Untitled'}" saved to vault`,
        timestamp: l.createdAt,
        url: l.url,
        domain: l.domain,
        user: l.user
          ? {
              name: l.user.name,
              email: l.user.email,
              avatarColor: l.user.avatarColor || '#3b82f6',
            }
          : { name: 'System', email: 'system@linkarium.com', avatarColor: '#64748b' },
        badgeColor: 'blue',
        badgeText: l.domain || 'LINK',
      });
    });

    // Map session logins / activity
    (recentSessions || []).forEach((s) => {
      const isMobile = /mobile|android|iphone|ipad/i.test(s.userAgent || '');
      events.push({
        id: `session-${s._id}`,
        type: 'session_active',
        title: 'Device Authenticated',
        description: `${s.user?.name || s.user?.email || 'User'} connected via ${isMobile ? 'Mobile' : 'Desktop'}`,
        timestamp: s.lastUsedAt || s.createdAt,
        ipAddress: s.ipAddress,
        user: s.user
          ? {
              name: s.user.name,
              email: s.user.email,
              avatarColor: s.user.avatarColor || '#10b981',
            }
          : { name: 'Client', email: 'session@linkarium.com', avatarColor: '#64748b' },
        badgeColor: 'teal',
        badgeText: isMobile ? 'MOBILE' : 'DESKTOP',
      });
    });

    // Chronological sort descending
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json({
      events: events.slice(0, 30),
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin/activity] error:', err);
    res.status(500).json({ error: 'Failed to generate activity stream.' });
  }
});

module.exports = router;


