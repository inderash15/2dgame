const mongoose = require('mongoose');

const GameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true, index: true },
  sourceTeamId: String,
  gameSlot: String,
  genre: { type: String, index: true },
  title: { type: String, required: true, index: true },
  coreMechanic: String,
  description: String,
  objective: String,
  level1Focus: String,
  level2Focus: String,
  implementation2D: String,
  scope12Hour: String,
  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'], default: 'Medium' },
  conceptOrigin: String,
  originalRef: String,
  uniquenessCheck: String,
  archived: { type: Boolean, default: false }
}, { timestamps: true });

const TeamSchema = new mongoose.Schema({
  teamNumber: { type: String, required: true, unique: true, index: true },
  department: { type: String, index: true },
  classSheet: String,
  leaderName: { type: String, required: true },
  registerNumber: String,
  leaderClass: String,
  leaderContact: String, // Admin-only: stripped from public/team responses
  facultyMentor: String,
  mentorMobile: String,  // Admin-only: stripped from public/team responses
  accessCodeHash: String,
  progressStatus: { type: String, default: 'Not Started' },
  progressRemarks: String
}, { timestamps: true });

const AllocationSchema = new mongoose.Schema({
  version: { type: String, required: true, index: true },
  seed: String,
  status: { type: String, enum: ['Draft', 'Published', 'Locked'], default: 'Draft' },
  assignments: [{
    gameId: { type: String, required: true },
    teamNumber: { type: String, required: true },
    allocatedAt: { type: Date, default: Date.now }
  }],
  teamMeta: { type: Map, of: mongoose.Schema.Types.Mixed },
  sixGameTeams: [String],
  createdBy: String
}, { timestamps: true });

const AdminUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  salt: { type: String, required: true },
  role: { type: String, enum: ['superadmin', 'admin'], default: 'admin' }
}, { timestamps: true });

const AnnouncementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, required: true },
  priority: { type: String, enum: ['Normal', 'Important', 'Urgent'], default: 'Normal' },
  target: { type: String, default: 'ALL' },
  startDate: Date,
  expiryDate: Date
}, { timestamps: true });

const AuditLogSchema = new mongoose.Schema({
  action: { type: String, required: true },
  details: String,
  actor: String,
  ip: String
}, { timestamps: true });

module.exports = {
  Game: mongoose.model('Game', GameSchema),
  Team: mongoose.model('Team', TeamSchema),
  Allocation: mongoose.model('Allocation', AllocationSchema),
  AdminUser: mongoose.model('AdminUser', AdminUserSchema),
  Announcement: mongoose.model('Announcement', AnnouncementSchema),
  AuditLog: mongoose.model('AuditLog', AuditLogSchema)
};
