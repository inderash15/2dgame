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
  teamId: { type: String, required: true, unique: true, index: true, uppercase: true, trim: true },
  department: { type: String, index: true },
  classSheet: String,
  leaderName: { type: String, required: true },
  registerNumber: String,
  leaderClass: String,
  leaderContact: String, // Admin-only: excluded from public/team responses
  facultyMentor: { type: String, index: true },
  mentorMobile: String,  // Admin-only: excluded from public/team responses
  accessCodeHash: String,
  progressStatus: {
    type: String,
    enum: ['Not Started', 'Planning', 'Development In Progress', 'Testing', 'Completed', 'Submitted'],
    default: 'Not Started'
  },
  completionPct: { type: Number, min: 0, max: 100, default: 0 },
  progressRemarks: { type: String, default: '' },
  lastProgressUpdate: Date
}, { timestamps: true });

const MentorSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
  displayName: { type: String, required: true, unique: true },
  department: { type: String, default: '' },
  passwordHash: { type: String, required: true },
  salt: { type: String, required: true },
  mustChangePassword: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
  lastLoginAt: Date,
  loginCount: { type: Number, default: 0 }
}, { timestamps: true });

const ProgressUpdateSchema = new mongoose.Schema({
  teamId: { type: String, required: true, index: true, uppercase: true },
  mentorId: { type: String, required: true, index: true },
  mentorName: { type: String, required: true },
  previousStatus: String,
  newStatus: { type: String, required: true },
  previousPct: { type: Number, default: 0 },
  newPct: { type: Number, required: true, min: 0, max: 100 },
  remarks: String,
  feedback: String,
  reviewDate: String
}, { timestamps: true });

const AllocationSchema = new mongoose.Schema({
  version: { type: String, required: true, index: true },
  seed: String,
  status: { type: String, enum: ['Draft', 'Published', 'Locked'], default: 'Draft' },
  assignments: [{
    gameId: { type: String, required: true },
    teamId: { type: String, required: true },
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
  Mentor: mongoose.model('Mentor', MentorSchema),
  ProgressUpdate: mongoose.model('ProgressUpdate', ProgressUpdateSchema),
  Allocation: mongoose.model('Allocation', AllocationSchema),
  AdminUser: mongoose.model('AdminUser', AdminUserSchema),
  Announcement: mongoose.model('Announcement', AnnouncementSchema),
  AuditLog: mongoose.model('AuditLog', AuditLogSchema)
};
