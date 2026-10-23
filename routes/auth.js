const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Session = require('../models/Session');
const Challenge = require('../models/Challenge');
const auth = require('../middleware/auth');
const {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  publicUser,
  invalidateTokenVersion,
} = require('../utils/helpers');
const { isEmail } = require('../utils/validators');
const { describeDevice } = require('../utils/device');
const totp = require('../utils/totp');
const {
  initMasterAccount,
  isMasterCredentials,
  getMasterEmail,
} = require('../utils/initMaster');

const router = express.Router();

const isProd = process.env.NODE_ENV === 'production';
// Cross-site cookies (Vercel frontend -> Render API) require SameSite=None
// and Secure, which in turn require HTTPS. Set SECURE_COOKIES=true/false to
// override the NODE_ENV default if the deployment differs.
const SECURE_COOKIES = process.env.SECURE_COOKIES
  ? process.env.SECURE_COOKIES === 'true'
  : isProd;
// Cross-site on Vercel<->Render: SameSite=None + Secure required.
const REFRESH_COOKIE_NAME = 'rt';
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: SECURE_COOKIES,
  sameSite: SECURE_COOKIES ? 'none' : 'lax',
  // The refresh cookie must be readable by every authenticated API route, not
  // only /api/auth. The session routes need it to tell which device is
  // "current" when revoking the others.
  path: '/api',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// Refreshes can race: React StrictMode boots the app twice, and several tabs
// can refresh at the same moment. A token used twice inside this window is a
// benign race, not a stolen token.
const REFRESH_REUSE_GRACE_MS = 30 * 1000;

// How long a login challenge stays valid.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// How many codes may be tried before the challenge is thrown away.
const MAX_CHALLENGE_ATTEMPTS = 5;

function setRefreshCookie(res, token) {
  // Remove the cookie issued by older builds (path /api/auth) so the browser
  // does not send two `rt` cookies after this deploy.
  res.clearCookie(REFRESH_COOKIE_NAME, {
    ...REFRESH_COOKIE_OPTS,
    path: '/api/auth',
    maxAge: 0,
  });
  res.cookie(REFRESH_COOKIE_NAME, token, REFRESH_COOKIE_OPTS);
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, { ...REFRESH_COOKIE_OPTS, maxAge: 0 });
  res.clearCookie(REFRESH_COOKIE_NAME, {
    ...REFRESH_COOKIE_OPTS,
    path: '/api/auth',
    maxAge: 0,
  });
}

/**
 * Create the session that belongs to a freshly issued refresh token.
 *
 * The session is what makes "sign out this device" and refresh-token reuse
 * detection possible.
 */
async function createSession(user, req, refreshToken) {
  const payload = verifyToken(refreshToken, 'refresh');
  const userAgent = req.headers['user-agent'] || '';

  const session = await Session.create({
    user: user._id,
    jti: payload.jti,
    userAgent,
    ip: req.ip || '',
    device: describeDevice(userAgent),
    lastUsedAt: new Date(),
    expiresAt: new Date(payload.exp * 1000),
  });

  return session;
}

/**
 * Issue an access token, a refresh token and the matching session.
 */
async function issueTokens(res, user, req) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  setRefreshCookie(res, refreshToken);
  try {
    await createSession(user, req, refreshToken);
  } catch (err) {
    // A failed session write must not block the login.
    console.error('[auth] could not create the session:', err.message);
  }
  return accessToken;
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (String(name).trim().length > 60) {
      return res.status(400).json({ error: 'Name must be 60 characters or fewer.' });
    }
    if (String(password).length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    }

    if (String(email).toLowerCase().trim() === getMasterEmail()) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const existing = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const hash = await bcrypt.hash(String(password), 10);
    const user = await User.create({
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password: hash,
      role: 'user',
      status: 'active',
      lastLoginAt: new Date(),
      lastLoginIp: req.ip || '',
      loginCount: 1,
    });

    const accessToken = await issueTokens(res, user, req);
    res.status(201).json({ accessToken, token: accessToken, user: publicUser(user) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // --- Master Account Special Authentication ---
    if (isMasterCredentials(normalizedEmail, password)) {
      const masterUser = await initMasterAccount();
      if (!masterUser) {
        return res.status(500).json({ error: 'Could not initialize master admin.' });
      }

      masterUser.lastLoginAt = new Date();
      masterUser.lastLoginIp = req.ip || '';
      masterUser.loginCount = (masterUser.loginCount || 0) + 1;
      await masterUser.save();

      const accessToken = await issueTokens(res, masterUser, req);
      return res.json({
        accessToken,
        token: accessToken,
        user: publicUser(masterUser),
        isAdmin: true,
      });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+password');
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'This account has been suspended by an administrator.' });
    }

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    user.lastLoginAt = new Date();
    user.lastLoginIp = req.ip || '';
    user.loginCount = (user.loginCount || 0) + 1;
    await user.save();

    // Two-factor authentication: the password was correct, but the account
    // still needs a one-time code. A challenge is issued instead of a token.
    if (user.totp?.enabled) {
      const challenge = await Challenge.create({
        user: user._id,
        code: crypto.randomBytes(24).toString('base64url'),
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      });

      return res.json({
        requiresOtp: true,
        challengeId: challenge.code,
        user: { name: user.name, email: user.email },
      });
    }

    const accessToken = await issueTokens(res, user, req);
    res.json({ accessToken, token: accessToken, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/auth/verify-otp — finish a login that needs a second factor.
router.post('/verify-otp', async (req, res) => {
  try {
    const { challengeId, code } = req.body;
    if (!challengeId || !code) {
      return res.status(400).json({ error: 'A challenge id and a code are required.' });
    }

    const challenge = await Challenge.findOne({ code: String(challengeId), consumedAt: null });
    if (!challenge) {
      return res.status(401).json({ error: 'This login attempt is no longer valid.' });
    }
    if (challenge.expiresAt.getTime() <= Date.now()) {
      return res.status(401).json({ error: 'This login attempt has expired.' });
    }
    if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      await Challenge.updateOne({ _id: challenge._id }, { $set: { consumedAt: new Date() } });
      return res.status(429).json({ error: 'Too many attempts. Please sign in again.' });
    }

    const user = await User.findById(challenge.user);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const secret = user.totp?.secret;
    if (!secret) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    let valid = totp.verify(secret, code);

    // A recovery code is accepted instead of a one-time code.
    if (!valid) {
      const hash = totp.hashRecoveryCode(code);
      const index = (user.recoveryCodes || []).indexOf(hash);
      if (index !== -1) {
        valid = true;
        user.recoveryCodes.splice(index, 1);
        await user.save();
      }
    }

    if (!valid) {
      await Challenge.updateOne({ _id: challenge._id }, { $inc: { attempts: 1 } });
      return res.status(401).json({ error: 'That code is not correct.' });
    }

    challenge.consumedAt = new Date();
    await challenge.save();

    const accessToken = await issueTokens(res, user, req);
    res.json({ accessToken, token: accessToken, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const rt = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!rt) {
      return res.status(401).json({ error: 'Not authorized. Missing refresh token.' });
    }

    const payload = verifyToken(rt, 'refresh');
    const user = await User.findById(payload.id);
    if (!user || (payload.v || 0) !== (user.tokenVersion || 0)) {
      clearRefreshCookie(res);
      invalidateTokenVersion(payload.id);
      return res.status(401).json({ error: 'Not authorized. Token invalid or expired.' });
    }

    // Refresh-token reuse detection & revocation check
    let session = null;
    let benignRace = false;
    if (payload.jti) {
      session = await Session.findOne({ jti: payload.jti });
      if (session?.revokedAt) {
        clearRefreshCookie(res);
        return res.status(401).json({ error: 'This session has been revoked. Please sign in again.' });
      }
      if (session?.rotatedAt) {
        const rotatedAt = new Date(session.rotatedAt).getTime();
        if (Date.now() - rotatedAt <= REFRESH_REUSE_GRACE_MS) {
          // Two tabs (or StrictMode's double bootstrap) refreshed at the same
          // time. Both are legitimate; issue a fresh pair instead of logging
          // the user out of every device.
          benignRace = true;
        } else {
          await Session.updateMany({ user: payload.id, revokedAt: null }, { $set: { revokedAt: new Date() } });
          user.tokenVersion = (user.tokenVersion || 0) + 1;
          await user.save();
          invalidateTokenVersion(payload.id);
          clearRefreshCookie(res);
          return res.status(401).json({
            error: 'This session was signed out because the refresh token was reused. Please sign in again.',
          });
        }
      }
    }

    // Rotate refresh token on use (refresh token rotation)
    const accessToken = signAccessToken(user);
    const newRefresh = signRefreshToken(user);
    setRefreshCookie(res, newRefresh);

    if (session) {
      // In a benign race the original session stays rotated (do not reset
      // rotatedAt, or a stolen token could keep extending its own grace
      // window). It is simply no longer the current session.
      if (!benignRace) session.rotatedAt = new Date();
      session.lastUsedAt = new Date();
      await session.save();
    }
    try {
      await createSession(user, req, newRefresh);
    } catch (err) {
      console.error('[auth] could not create the session:', err.message);
    }

    res.json({ accessToken, token: accessToken, user: publicUser(user) });
  } catch {
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Not authorized. Token invalid or expired.' });
  }
});

// Logout must always succeed: it identifies the user from the access token
// or, when that already expired, from the refresh cookie, then revokes every
// outstanding session by bumping the token version.
router.post('/logout', async (req, res) => {
  try {
    let userId = null;

    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        userId = verifyToken(header.split(' ')[1], 'access').id;
      } catch {
        // fall through to the refresh cookie
      }
    }

    if (!userId) {
      const rt = req.cookies?.[REFRESH_COOKIE_NAME];
      if (rt) {
        try {
          userId = verifyToken(rt, 'refresh').id;
        } catch {
          // invalid/expired refresh token — just clear the cookie
        }
      }
    }

    if (userId) {
      const user = await User.findById(userId);
      if (user) {
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();
        invalidateTokenVersion(userId);
      }
      // Revoke the device sessions as well, so the session list is accurate.
      await Session.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } }).catch(
        () => {}
      );
    }

    clearRefreshCookie(res);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    clearRefreshCookie(res);
    res.json({ ok: true });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
