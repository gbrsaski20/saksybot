const mongoose = require('mongoose');

const serverConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  isPremium: { type: Boolean, default: false },
  premiumExpires: { type: Date, default: null },
  verificationSettings: {
    enabled: { type: Boolean, default: true },
    verificationChannelId: { type: String, default: '' },
    unverifiedRoleId: { type: String, default: '' },
    verifiedRoleId: { type: String, default: '' },
    ownerRoleId: { type: String, default: '' },
    modRoleId: { type: String, default: '' }
  },
  autoBanSettings: {
    enabled: { type: Boolean, default: true },
    maxEmojiCount: { type: Number, default: 5 },
    forbiddenWords: { type: [String], default: ['spam', 'toxic', 'promosi'] }
  }
});

module.exports = mongoose.model('ServerConfig', serverConfigSchema);