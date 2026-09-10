const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
      select: false,
    },
    avatarColor: {
      type: String,
      default: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('User', userSchema);