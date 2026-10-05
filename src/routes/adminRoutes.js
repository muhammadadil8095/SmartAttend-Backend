import express from "express";

import {
  getAdminDashboard,
  getAdminStudents,
  createAdminStudent,
} from "../controllers/adminController.js";

import { syncAllEnrollments } from "../utils/enrollmentHelper.js";

import { authenticate } from "../middleware/authMiddleware.js";
import { authorize } from "../middleware/roleMiddleware.js";

const router = express.Router();

router.get("/dashboard", authenticate, authorize("ADMIN"), getAdminDashboard);

router.get("/students", authenticate, authorize("ADMIN"), getAdminStudents);

router.post("/students", authenticate, authorize("ADMIN"), createAdminStudent);

// Repair/sync enrollments for existing students and classes
router.post(
  "/sync-enrollments",
  authenticate,
  authorize("ADMIN"),
  async (req, res) => {
    try {
      const result = await syncAllEnrollments();

      return res.status(200).json({
        success: true,
        message: "Enrollments synchronized successfully",
        data: result,
      });
    } catch (error) {
      console.error("Enrollment sync error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to synchronize enrollments",
      });
    }
  },
);

export default router;
