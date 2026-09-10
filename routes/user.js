const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { publicUser } = require('../utils/helpers');
const { isHexColor } = require('../utils/validators');

const router = express.Router();

router.use(auth);

// GET /api/user/me
router.get('/me', async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      if (String(newPassword).length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }
      user.password = await bcrypt.hash(String(newPassword), 10);
    }

    await user.save();
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;