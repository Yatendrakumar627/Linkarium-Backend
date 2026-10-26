const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { publicUser, invalidateTokenVersion } = require('../utils/helpers');
const { isHexColor } = require('../utils/validators');
const { safeTimeZone } = require('../utils/timezone');
const totp = require('../utils/totp');

const router = express.Router();

router.use(auth);

// The themes the client knows about.
const THEMES = ['dark', 'light', 'system'];
// The views the client can open.
const DEFAULT_VIEWS = ['dashboard', 'links', 'collections', 'tags', 'archive', 'favorites', 'insights'];
// The color classification modes supported for cards and tags.
const COLOR_MODES = ['tag', 'collection', 'blend', 'brand', 'own', 'tag-first', 'collection-first'];

// GET /api/user/me
router.get('/me', async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// PATCH /api/user/me
router.patch('/me', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('+password');
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const { name, avatarColor, currentPassword, newPassword } = req.body;

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty.' });
      if (trimmed.length > 60) return res.status(400).json({ error: 'Name must be 60 characters or fewer.' });
      user.name = trimmed;
    }
    if (avatarColor !== undefined && avatarColor !== null) {
      if (!isHexColor(avatarColor)) return res.status(400).json({ error: 'Invalid color format.' });
      user.avatarColor = avatarColor;
    }

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required to change password.' });
      }
      const ok = await bcrypt.compare(String(currentPassword), user.password);
      if (!ok) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
      if (String(newPassword).length < 10) {
        return res.status(400).json({ error: 'New password must be at least 10 characters.' });
      }
      user.password = await bcrypt.hash(String(newPassword), 10);
      // Revoke every previously issued token — all devices must sign in again.
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      invalidateTokenVersion(String(user._id));
    }

    await user.save();
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// PATCH /api/user/preferences — the client settings (theme, digest, default view).
router.patch('/preferences', async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const {
      digestEnabled,
      digestDay,
      digestHour,
      timezone,
      theme,
      defaultView,
      autoEnrich,
      colorMode,
    } = req.body || {};

    if (!user.preferences) {
      user.preferences = {};
    }

    if (digestEnabled !== undefined) {
      user.preferences.digestEnabled = Boolean(digestEnabled);
    }
    if (digestDay !== undefined) {
      const day = Number(digestDay);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        return res.status(400).json({ error: 'The digest day must be a number between 0 (Sunday) and 6.' });
      }
      user.preferences.digestDay = day;
    }
    if (digestHour !== undefined) {
      const hour = Number(digestHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return res.status(400).json({ error: 'The digest hour must be a number between 0 and 23.' });
      }
      user.preferences.digestHour = hour;
    }
    if (timezone !== undefined) {
      // safeTimeZone falls back to UTC for an unknown zone, but a typo should
      // be reported rather than silently ignored.
      const requested = String(timezone || '').trim();
      if (requested && requested !== 'UTC' && safeTimeZone(requested) === 'UTC') {
        return res.status(400).json({ error: 'That is not a valid timezone.' });
      }
      user.preferences.timezone = requested ? safeTimeZone(requested) : 'UTC';
    }
    if (theme !== undefined) {
      if (!THEMES.includes(theme)) {
        return res.status(400).json({ error: `The theme must be one of: ${THEMES.join(', ')}.` });
      }
      user.preferences.theme = theme;
    }
    if (defaultView !== undefined) {
      if (!DEFAULT_VIEWS.includes(defaultView)) {
        return res.status(400).json({ error: 'That is not a known view.' });
      }
      user.preferences.defaultView = defaultView;
    }
    if (autoEnrich !== undefined) {
      user.preferences.autoEnrich = Boolean(autoEnrich);
    }
    if (colorMode !== undefined) {
      if (!COLOR_MODES.includes(colorMode)) {
        return res.status(400).json({ error: `The color mode must be one of: ${COLOR_MODES.join(', ')}.` });
      }
      user.preferences.colorMode = colorMode;
    }

    await user.save();
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/user/totp — is two-factor authentication on?
router.get('/totp', async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    res.json({
      enabled: Boolean(user.totp?.enabled),
      recoveryCodesLeft: Array.isArray(user.recoveryCodes) ? user.recoveryCodes.length : 0,
      verifiedAt: user.totp?.verifiedAt || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/user/totp/setup — start the two-factor setup.
//
// Returns the secret, the otpauth:// URI for the authenticator app and the
// recovery codes. Two-factor authentication is only switched on once the user
// has proved that the authenticator works (POST /api/user/totp/enable).
router.post('/totp/setup', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('+totp.secret +recoveryCodes');
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.totp?.enabled) {
      return res.status(409).json({ error: 'Two-factor authentication is already enabled.' });
    }

    const secret = totp.generateSecret();
    const recoveryCodes = totp.generateRecoveryCodes(10);

    user.totp.secret = secret;
    user.totp.enabled = false;
    user.totp.verifiedAt = null;
    user.recoveryCodes = recoveryCodes.map((code) => totp.hashRecoveryCode(code));

    await user.save();

    res.json({
      secret,
      otpauthUrl: totp.otpauthUrl(secret, user.email, 'Linkarium'),
      recoveryCodes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/user/totp/enable — switch two-factor authentication on.
router.post('/totp/enable', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'A code is required.' });

    const user = await User.findById(req.userId).select('+totp.secret +recoveryCodes');
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.totp?.enabled) {
      return res.status(409).json({ error: 'Two-factor authentication is already enabled.' });
    }
    if (!user.totp?.secret) {
      return res.status(400).json({ error: 'Start the setup first.' });
    }

    if (!totp.verify(user.totp.secret, code)) {
      return res.status(400).json({ error: 'That code is not correct.' });
    }

    user.totp.enabled = true;
    user.totp.verifiedAt = new Date();
    await user.save();

    res.json({ enabled: true, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/user/totp/disable — switch two-factor authentication off.
//
// The user has to prove who they are: either with a current one-time code or
// with their password.
router.post('/totp/disable', async (req, res) => {
  try {
    const { code, password } = req.body || {};

    const user = await User.findById(req.userId).select('+password +totp.secret +recoveryCodes');
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!user.totp?.enabled) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled.' });
    }

    let authorised = false;

    if (code && user.totp.secret) {
      authorised = totp.verify(user.totp.secret, code);
      if (!authorised) {
        const hash = totp.hashRecoveryCode(code);
        const index = (user.recoveryCodes || []).indexOf(hash);
        if (index !== -1) {
          authorised = true;
          user.recoveryCodes.splice(index, 1);
        }
      }
    }

    if (!authorised && password) {
      authorised = await bcrypt.compare(String(password), user.password);
    }

    if (!authorised) {
      return res.status(401).json({ error: 'A valid code or password is required.' });
    }

    user.totp.enabled = false;
    user.totp.secret = null;
    user.totp.verifiedAt = null;
    user.recoveryCodes = [];
    await user.save();

    res.json({ enabled: false, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/user/totp/recovery-codes — issue a fresh set of recovery codes.
router.post('/totp/recovery-codes', async (req, res) => {
  try {
    const { code, password } = req.body || {};

    const user = await User.findById(req.userId).select('+password +totp.secret +recoveryCodes');
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!user.totp?.enabled || !user.totp.secret) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled.' });
    }

    let authorised = totp.verify(user.totp.secret, code);
    if (!authorised && password) {
      authorised = await bcrypt.compare(String(password), user.password);
    }
    if (!authorised) {
      return res.status(401).json({ error: 'A valid code or password is required.' });
    }

    const recoveryCodes = totp.generateRecoveryCodes(10);
    user.recoveryCodes = recoveryCodes.map((c) => totp.hashRecoveryCode(c));
    await user.save();

    res.json({ recoveryCodes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
