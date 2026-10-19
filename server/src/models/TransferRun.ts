import mongoose from "mongoose";

// Reference-only recovery journal. Never store import bodies or export data here.
const schema = new mongoose.Schema(
  {
    owner: { type: String, required: true },
    kind: { type: String, enum: ["import", "export"], required: true },
    inputHash: String,
    status: {
      type: String,
      enum: ["pending", "running", "failed", "completed", "cancelled"],
      default: "pending",
    },
    cancelRequested: { type: Boolean, default: false },
    token: String,
    steps: { type: mongoose.Schema.Types.Mixed, default: {} },
    finishedAt: Date,
  },
  { timestamps: true },
);
schema.index({ owner: 1, createdAt: -1 });
// Only terminal runs expire. Running/failed recovery evidence is retained.
schema.index({ finishedAt: 1 }, { expireAfterSeconds: 30 * 86400 });
export default mongoose.models.TransferRun ||
  mongoose.model("TransferRun", schema);
