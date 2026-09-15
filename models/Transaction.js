const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  guildId: { type: String, required: true },
  userEmail: { type: String, required: true },
  amount: { type: Number, required: true },
  plan: { type: String, enum: ['PREMIUM_30_DAYS', 'PREMIUM_1_YEAR'], default: 'PREMIUM_30_DAYS' },
  status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);