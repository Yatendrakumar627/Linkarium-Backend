const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const DEFAULT_MASTER_EMAIL = 'master@linkarium.com';
const DEFAULT_MASTER_PASSWORD = 'Master@Linkarium2026!';
const DEFAULT_MASTER_NAME = 'Master Admin';

function getMasterEmail() {
  return (process.env.MASTER_ADMIN_EMAIL || DEFAULT_MASTER_EMAIL).toLowerCase().trim();
}

function getMasterPassword() {
  return process.env.MASTER_ADMIN_PASSWORD || DEFAULT_MASTER_PASSWORD;
}

function getMasterName() {
  return process.env.MASTER_ADMIN_NAME || DEFAULT_MASTER_NAME;
}

/**
 * Checks whether the given credentials match the configured master credentials
 * using constant-time cryptographic hash comparison to eliminate timing attacks.
 */
function isMasterCredentials(email, password) {
  if (!email || !password) return false;
  const targetEmail = getMasterEmail();
  const targetPass = getMasterPassword();

  const inputEmailDigest = crypto.createHash('sha256').update(String(email).toLowerCase().trim()).digest();
  const targetEmailDigest = crypto.createHash('sha256').update(targetEmail).digest();
  const emailValid = crypto.timingSafeEqual(inputEmailDigest, targetEmailDigest);

  const inputPassDigest = crypto.createHash('sha256').update(String(password)).digest();
  const targetPassDigest = crypto.createHash('sha256').update(targetPass).digest();
  const passValid = crypto.timingSafeEqual(inputPassDigest, targetPassDigest);

  return emailValid && passValid;
}

/**
 * Ensures the Master Admin account exists in the database with role='admin' and isMaster=true.
 * Can be called safely on startup or on-demand.
 */
async function initMasterAccount() {
  try {
    const email = getMasterEmail();
    const rawPassword = getMasterPassword();
    const name = getMasterName();

    let masterUser = await User.findOne({ email }).select('+password');

    if (!masterUser) {
      const hash = await bcrypt.hash(rawPassword, 10);
      masterUser = await User.create({
        name,
        email,
        password: hash,
        role: 'admin',
        isMaster: true,
        status: 'active',
        avatarColor: '#f59e0b', // Distinct golden crown accent
        preferences: {
          theme: 'dark',
          defaultView: 'dashboard',
          autoEnrich: true,
        },
      });
      console.log(`👑 [Master Admin] Account initialized: ${email}`);
    } else {
      let needsSave = false;

      if (masterUser.role !== 'admin') {
        masterUser.role = 'admin';
        needsSave = true;
      }
      if (!masterUser.isMaster) {
        masterUser.isMaster = true;
        needsSave = true;
      }
      if (masterUser.status !== 'active') {
        masterUser.status = 'active';
        needsSave = true;
      }

      // Check if password hash matches current env password
      const match = await bcrypt.compare(rawPassword, masterUser.password);
      if (!match) {
        masterUser.password = await bcrypt.hash(rawPassword, 10);
        needsSave = true;
      }

      if (needsSave) {
        await masterUser.save();
        console.log(`👑 [Master Admin] Account synchronized: ${email}`);
      }
    }

    return masterUser;
  } catch (err) {
    console.error('❌ [Master Admin] Failed to initialize master account:', err.message);
    return null;
  }
}

module.exports = {
  initMasterAccount,
  isMasterCredentials,
  getMasterEmail,
  getMasterPassword,
  getMasterName,
};
